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
import { pickWindow, parseKeywords, describeDevices, type WindowInfo } from './window.ts';
import { toPngBytes } from './screen.ts';
import { errorText, withTimeout } from './timeout.ts';

const CONNECT_TIMEOUT_MS = 15_000;
const ENUMERATE_TIMEOUT_MS = 8_000;
const SCREENCAP_TIMEOUT_MS = 8_000;
const CLICK_TIMEOUT_MS = 5_000;

/** 截图方式与输入方式都缺省时的兜底组合：后台可采（FramePool/PrintWindow）+ 后台可点。 */
const FALLBACK_SCREENCAP = 'Background';
const FALLBACK_INPUT = 'SendMessage';

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
  private res: readonly [number, number] | null = null;

  constructor(private readonly load: () => Promise<MaaLoadResult> = loadMaa) {}

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

  /** 画面尺寸；连接成功但还没抓到帧时为 `null`，调用方不得拿它当已知值用。 */
  get resolution(): readonly [number, number] | null {
    return this.res ?? this.readResolution();
  }

  async connect(cfg: ArknightsConfigSection): Promise<ConnectResult> {
    if (this.ctrl && this.connected && this.win && this.res) {
      return { ok: true, window: this.win, resolution: this.res };
    }
    await this.stop();

    const loaded = await this.load();
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
          + '常见原因：游戏以管理员权限运行、所选截图方式不可用、窗口已被其他程序独占。',
      };
    }

    this.ctrl = ctrl;
    this.win = win;
    this.res = this.readResolution();
    if (!this.res) {
      // 连接成功但还没拿到分辨率：抓一帧把尺寸带出来，顺便确认截图链路真的通。
      const shot = await this.screencap();
      const size = shot.ok ? this.readResolution() : null;
      if (!size) {
        await this.stop();
        const detail = shot.ok ? '抓到了画面但读不出尺寸' : shot.error;
        return { ok: false, error: `连接失败：窗口连上了但拿不到画面尺寸（${detail}）。已断开连接。` };
      }
      this.res = size;
    }
    return { ok: true, window: win, resolution: this.res };
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
    return { ok: true, png };
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
    this.res = null;
  }

  private readResolution(): readonly [number, number] | null {
    const raw = this.ctrl?.resolution ?? null;
    if (!raw || raw.length < 2) return null;
    const [width, height] = raw;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return [Math.floor(width), Math.floor(height)];
  }
}
