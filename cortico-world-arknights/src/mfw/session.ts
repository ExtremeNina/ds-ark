/**
 * 控制器会话：持有 Win32 控制器、命中的窗口与截图分辨率。
 * 连接幂等；所有原生调用都过超时；失败一律折成可读回执并清干净半连接状态。
 */
import type { ArknightsConfigSection } from '../config.ts';
import {
  loadMaa,
  type MaaControllerLike,
  type MaaDesktopDevice,
  type MaaJobLike,
  type MaaLoadResult,
} from './native.ts';
import { is16by9 } from './geometry.ts';
import { pickWindow, parseKeywords, describeDevices, type WindowInfo } from './window.ts';
import { pngSize, toPngBytes } from './screen.ts';
import { errorText, withTimeout } from './timeout.ts';

const CONNECT_TIMEOUT_MS = 15_000;
const ENUMERATE_TIMEOUT_MS = 8_000;
const SCREENCAP_TIMEOUT_MS = 8_000;
const CLICK_TIMEOUT_MS = 5_000;

/** 截图方式与输入方式都缺省时的兜底组合：后台可采（FramePool/PrintWindow）+ 后台可点。 */
const FALLBACK_SCREENCAP = 'Background';
// 实测：SendMessage 点不中右上角的小按钮，AnchoredTouch 可以且不抢前台。
const FALLBACK_INPUT = 'AnchoredTouch';

export type ConnectResult =
  | { ok: true; window: WindowInfo; resolution: readonly [number, number] }
  | { ok: false; error: string };

export type ScreencapResult = { ok: true; png: Uint8Array } | { ok: false; error: string };

export type ClickResult = { ok: true } | { ok: false; error: string };

/**
 * 配置里的方式名换算成绑定认识的标志位。
 * 表缺失或名字不在表里都给 `null`：返回 '0' 会让连接「成功」却什么都点不动。
 */
export function resolveMethod(
  table: Record<string, string> | undefined,
  name: string,
  fallbackName: string,
): string | null {
  if (!table) return null;
  if (name !== 'Default' && typeof table[name] === 'string') return table[name];
  return typeof table[fallbackName] === 'string' ? table[fallbackName] : null;
}

function destroyQuietly(ctrl: MaaControllerLike | null): void {
  try {
    ctrl?.destroy();
  } catch {
    // 断开本身失败没有后续可做，保留原错误更有意义。
  }
}

export class ArknightsSession {
  private ctrl: MaaControllerLike | null = null;
  private win: WindowInfo | null = null;
  /** 最近一帧的真实像素尺寸；点击换算以它为准。 */
  private lastFrameSize: { width: number; height: number } | null = null;
  private warnedSizeMismatch = false;
  private warnedAspect = false;

  constructor(
    private readonly load: () => Promise<MaaLoadResult> = loadMaa,
    private readonly warn: (line: string) => void = () => {},
  ) {}

  get connected(): boolean {
    try {
      return this.ctrl?.connected === true;
    } catch {
      return false;
    }
  }

  get window(): WindowInfo | null {
    return this.win;
  }

  /**
   * 画面尺寸；连接成功但还没抓到帧时为 `null`，调用方不得拿它当已知值用。
   * 有帧以后一律用帧的真实像素尺寸：控制器报的尺寸与实际画面可能不是同一个坐标系。
   */
  get resolution(): readonly [number, number] | null {
    if (this.lastFrameSize) return [this.lastFrameSize.width, this.lastFrameSize.height];
    return this.readResolution();
  }

  /**
   * 控制器自己报告的尺寸。排障用：`DXGI_DesktopDup` 这类方式报的是整屏尺寸，
   * 与实际抓到的窗口画面不是一回事，不能拿它算点击坐标。
   */
  get controllerResolution(): readonly [number, number] | null {
    return this.readResolution();
  }

  async connect(cfg: ArknightsConfigSection): Promise<ConnectResult> {
    const known = this.ctrl && this.connected && this.win ? this.resolution : null;
    if (this.ctrl && this.win && known) {
      return { ok: true, window: this.win, resolution: known };
    }
    await this.stop();

    let loaded: MaaLoadResult;
    try {
      loaded = await this.load();
    } catch (error) {
      return { ok: false, error: `连接失败：加载原生模块时抛错（${errorText(error)}）` };
    }
    if (!loaded.ok) return { ok: false, error: `连接失败：${loaded.error}` };

    const maa = loaded.maa;
    const keywords = parseKeywords(cfg.windowMatch);

    let devices: readonly MaaDesktopDevice[] | null;
    try {
      devices = await withTimeout(Promise.resolve(maa.Win32Controller.find()), ENUMERATE_TIMEOUT_MS, '枚举窗口');
    } catch (error) {
      return { ok: false, error: `连接失败：未能枚举窗口（${errorText(error)}）` };
    }

    const win = pickWindow(devices, keywords);
    if (!win) {
      return {
        ok: false,
        error: `连接失败：没有找到窗口名包含「${keywords.join('」或「')}」的窗口。当前可见窗口：${describeDevices(devices)}。`
          + '请确认游戏已启动；如果标题不同，把关键字写进配置 worlds.arknights.windowMatch（多个用逗号分隔）。',
      };
    }

    const screencap = resolveMethod(maa.Win32ScreencapMethod, cfg.screencapMethod, FALLBACK_SCREENCAP);
    if (!screencap) {
      return {
        ok: false,
        error: `连接失败：当前 @maaxyz/maa-node 没有提供截图方式「${cfg.screencapMethod}」对应的标志位，请检查依赖版本或配置。`,
      };
    }
    const input = resolveMethod(maa.Win32InputMethod, cfg.inputMethod, FALLBACK_INPUT);
    if (!input) {
      return {
        ok: false,
        error: `连接失败：当前 @maaxyz/maa-node 没有提供输入方式「${cfg.inputMethod}」对应的标志位，请检查依赖版本或配置。`,
      };
    }

    let ctrl: MaaControllerLike;
    try {
      ctrl = new maa.Win32Controller(win.handle, screencap, input, input);
    } catch (error) {
      return { ok: false, error: `连接失败：无法创建控制器（${errorText(error)}）` };
    }

    let job: MaaJobLike;
    try {
      job = await withTimeout(Promise.resolve(ctrl.post_connection().wait()), CONNECT_TIMEOUT_MS, '连接窗口');
    } catch (error) {
      destroyQuietly(ctrl);
      return { ok: false, error: `连接失败：连接窗口没有响应（${errorText(error)}）` };
    }
    if (!job.succeeded) {
      destroyQuietly(ctrl);
      return {
        ok: false,
        error: `连接失败：控制器拒绝了连接（状态码 ${String(job.status)}）。`
          + '最常见的原因是权限不对等：游戏以管理员身份运行，而 Coopanion 不是——'
          + '这样既抓不到画面，合成点击也会被系统拦掉。请让两者权限一致（都用管理员，或都不用）。'
          + '其次是所选截图方式不适用于该窗口，或窗口被其他程序独占。',
      };
    }

    this.ctrl = ctrl;
    this.win = win;
    let size = this.resolution;
    if (!size) {
      // 连接成功但还没拿到尺寸：抓一帧把尺寸带出来，顺便确认截图链路真的通。
      const shot = await this.screencap();
      size = this.resolution;
      if (!size) {
        await this.stop();
        const detail = shot.ok ? '抓到了画面但读不出尺寸' : shot.error;
        return { ok: false, error: `连接失败：窗口连上了但拿不到画面尺寸（${detail}）。已断开连接。` };
      }
    }
    return { ok: true, window: win, resolution: size };
  }

  async screencap(): Promise<ScreencapResult> {
    const ctrl = this.ctrl;
    if (!ctrl || !this.connected) {
      return { ok: false, error: '截图失败：还没连接游戏窗口，先调用 ark_connect。' };
    }
    let png: Uint8Array | null;
    try {
      const image = await withTimeout(
        (async () => {
          const done = await ctrl.post_screencap().wait();
          return done.get();
        })(),
        SCREENCAP_TIMEOUT_MS,
        '抓帧',
      );
      png = toPngBytes(image);
    } catch (error) {
      return { ok: false, error: `截图失败：抓帧没有返回（${errorText(error)}）` };
    }
    if (!png) {
      return {
        ok: false,
        error: '截图失败：抓到的画面是空的。窗口可能已最小化，或当前截图方式不支持后台采集，'
          + '可改配置 worlds.arknights.screencapMethod。',
      };
    }
    this.recordFrame(png);
    return { ok: true, png };
  }

  /** 记录本帧真实尺寸，并做两项一次性自检：尺寸来源是否一致、比例是否仍与标定基准相同。 */
  private recordFrame(png: Uint8Array): void {
    const size = pngSize(png);
    if (!size) return;
    this.lastFrameSize = size;
    this.checkSizeMismatch(size);
    this.checkAspect(size);
  }

  private checkSizeMismatch(size: { width: number; height: number }): void {
    const reported = this.readResolution();
    if (this.warnedSizeMismatch || !reported) return;
    if (reported[0] === size.width && reported[1] === size.height) return;
    this.warnedSizeMismatch = true;
    this.warn(
      `控制器报告的尺寸 ${reported[0]}×${reported[1]} 与实际画面 ${size.width}×${size.height} 不一致，点击换算改用实际画面尺寸。`,
    );
  }

  /** 暂停坐标是按 16:9 标定的；比例一变，按钮的相对位置就不再可信。 */
  private checkAspect(size: { width: number; height: number }): void {
    if (this.warnedAspect) return;
    if (is16by9(size.width, size.height)) return;
    this.warnedAspect = true;
    this.warn(
      `当前画面 ${size.width}×${size.height} 不是 16:9，而暂停坐标是按 16:9 标定的，ark_set_paused 可能点偏。`
        + '请把窗口改回 16:9 后重启扩展（重新连接会清掉这条标记），或按 README 的步骤重新标定 pauseButton。',
    );
  }

  async click(x: number, y: number): Promise<ClickResult> {
    const ctrl = this.ctrl;
    if (!ctrl || !this.connected) {
      return { ok: false, error: '点击失败：还没连接游戏窗口，先调用 ark_connect。' };
    }
    try {
      const job = await withTimeout(Promise.resolve(ctrl.post_click(x, y).wait()), CLICK_TIMEOUT_MS, '点击');
      if (!job.succeeded) return { ok: false, error: `点击失败：控制器返回失败（状态码 ${String(job.status)}）。` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `点击失败：${errorText(error)}` };
    }
  }

  async stop(): Promise<void> {
    destroyQuietly(this.ctrl);
    this.ctrl = null;
    this.win = null;
    this.lastFrameSize = null;
    this.warnedSizeMismatch = false;
    this.warnedAspect = false;
  }

  private readResolution(): readonly [number, number] | null {
    const raw = this.ctrl?.resolution ?? null;
    if (!raw || raw.length < 2) return null;
    const [width, height] = raw;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return [Math.floor(width), Math.floor(height)];
  }
}
