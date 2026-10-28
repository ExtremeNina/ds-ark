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
  type MaaModule,
} from './native.ts';
import { ArknightsOcr, builtinOcrModelDir, type OcrOutcome } from './ocr.ts';
import { ArknightsPipeline, type PipelineResult } from './pipeline.ts';
import { ArknightsRuntime } from './runtime.ts';
import { aspectDeviation, is16by9 } from './geometry.ts';
import { pickWindow, parseKeywords, describeDevices, type WindowInfo } from './window.ts';
import { pngSize, toPngBytes } from './screen.ts';
import { errorText, withTimeout } from './timeout.ts';

const CONNECT_TIMEOUT_MS = 15_000;
const ENUMERATE_TIMEOUT_MS = 8_000;
const SCREENCAP_TIMEOUT_MS = 8_000;
const CLICK_TIMEOUT_MS = 5_000;
const SWIPE_TIMEOUT_MS = 8_000;

/** 截图方式与输入方式都缺省时的兜底组合：后台可采（FramePool/PrintWindow）+ 后台可点。 */
const FALLBACK_SCREENCAP = 'Background';
/**
 * 画面比例与 16:9 的偏差容忍度：不超过这个值只发 info（暂停按钮的 x 已按右边缘余量换算，
 * 轻微偏差通常点得中）；超过才 warn，要求重标或改窗口。0.08 在 720 高下约等于宽度 1223~1338。
 */
const ASPECT_NOTICE_TOLERANCE = 0.08;
// 实测：SendMessage 点不中右上角的小按钮，AnchoredTouch 可以且不抢前台。
const FALLBACK_INPUT = 'AnchoredTouch';

export type ConnectResult =
  | { ok: true; window: WindowInfo; resolution: readonly [number, number] }
  | { ok: false; error: string };

export type ScreencapResult = { ok: true; png: Uint8Array } | { ok: false; error: string };

export type ActionResult = { ok: true } | { ok: false; error: string };

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
  /** 连接时拿到的模块引用；Resource/Tasker 由 runtime 统一持有。 */
  private maa: MaaModule | null = null;
  private runtime: ArknightsRuntime | null = null;
  private pipeline: ArknightsPipeline | null = null;
  private ocr: ArknightsOcr | null = null;
  /** 最近一帧的真实像素尺寸；点击换算以它为准。 */
  private lastFrameSize: { width: number; height: number } | null = null;
  private warnedSizeMismatch = false;
  /** 比例提示的级别，用于「只提示一次」以及 minor → major 的升级。 */
  private aspectTier: 'ok' | 'minor' | 'major' = 'ok';

  constructor(
    private readonly load: () => Promise<MaaLoadResult> = loadMaa,
    private readonly warn: (line: string) => void = () => {},
    private readonly info: (line: string) => void = () => {},
    /** 内置 OCR 模型目录，测试可注入；生产走包内 assets。 */
    private readonly ocrBuiltinDir: string = builtinOcrModelDir(),
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
    this.maa = maa;
    // OCR 与 pipeline 共用一个 Resource/Tasker：模型只加载一次。
    this.runtime = new ArknightsRuntime(maa, ctrl, (line) => this.info(line), this.ocrBuiltinDir);
    this.pipeline = new ArknightsPipeline(this.runtime);
    this.ocr = null;
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
      `控制器报告的尺寸 ${reported[0]}×${reported[1]} 与实际画面 ${size.width}×${size.height} 不同，点击换算改用实际画面尺寸。`
        + 'MaaFramework 常把截图短边缩到 720（1920×1080 → 1280×720），这一条本身正常；'
        + '只有控制器尺寸明显大于窗口、且帧里能看到桌面背景时，才可能是抓到了整屏（换截图方式）。',
    );
  }

  /**
   * 画面比例偏离 16:9 时给提示，按偏差分级。
   *
   * 暂停按钮的 x 已经按「距右边缘的余量」换算（16:9 下与旧值完全一致），所以 16:10、1.71:1
   * 这类轻微偏差通常点得中，只值得一条 info；只有偏差大到内容区可能被黑边压缩时才 warn。
   */
  private checkAspect(size: { width: number; height: number }): void {
    const deviation = aspectDeviation(size.width, size.height);
    const tier: 'ok' | 'minor' | 'major' = is16by9(size.width, size.height)
      ? 'ok'
      : deviation <= ASPECT_NOTICE_TOLERANCE ? 'minor' : 'major';
    if (tier === this.aspectTier) return;
    this.aspectTier = tier;

    if (tier === 'minor') {
      this.info(
        `当前画面 ${size.width}×${size.height} 不是 16:9（偏差 ${deviation.toFixed(3)}）。`
          + '暂停按钮的 x 已按距右边缘的余量换算，通常仍能点中；'
          + '只有画面上下出现黑边、内容区被压缩时才会偏，那时按 README 重标 pauseButton。',
      );
      return;
    }
    if (tier === 'major') {
      // minor → major 允许升级一次：窗口被改成更极端的比例时仍然要提醒。
      this.warn(
        `当前画面 ${size.width}×${size.height} 不是 16:9，偏差较大（${deviation.toFixed(3)}），ark_set_paused 可能点偏。`
          + '请把窗口改回 16:9 后重启扩展（重新连接会清掉这条标记），或按 README 的步骤重新标定 pauseButton。',
      );
    }
  }

  async click(x: number, y: number): Promise<ActionResult> {
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

  /** 拖拽：部署干员用。旧绑定没有 `post_swipe` 时给可读原因，而不是让调用方崩在 TypeError 上。 */
  async swipe(x1: number, y1: number, x2: number, y2: number, duration: number): Promise<ActionResult> {
    const ctrl = this.ctrl;
    if (!ctrl || !this.connected) {
      return { ok: false, error: '拖拽失败：还没连接游戏窗口，先调用 ark_connect。' };
    }
    if (typeof ctrl.post_swipe !== 'function') {
      return { ok: false, error: '拖拽失败：当前 @maaxyz/maa-node 的控制器没有提供 post_swipe，无法发拖拽手势。' };
    }
    try {
      const job = await withTimeout(
        Promise.resolve(ctrl.post_swipe(x1, y1, x2, y2, duration).wait()),
        SWIPE_TIMEOUT_MS,
        '拖拽',
      );
      if (!job.succeeded) return { ok: false, error: `拖拽失败：控制器返回失败（状态码 ${String(job.status)}）。` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `拖拽失败：${errorText(error)}` };
    }
  }

  /**
   * 对传入的这一帧做 OCR。识别能力是「有就用」：模型缺失、绑定不提供 Resource/Tasker，
   * 都折成可读原因，由调用方决定降级成「只看图」。`resourceDir` 只用于覆盖包内模型。
   */
  async recognizeFrame(png: Uint8Array, resourceDir: string): Promise<OcrOutcome> {
    const runtime = this.runtime;
    if (!runtime || !this.ctrl || !this.connected) {
      return { ok: false, error: '识别失败：还没连接游戏窗口，先调用 ark_connect。' };
    }
    // 按这一帧自己的尺寸归一化，而不是「最近一帧」：两者不同时框会整体错位。
    const frame = pngSize(png);
    const size = frame ?? this.lastFrameSize;
    if (!size) return { ok: false, error: '识别失败：读不出这一帧的像素尺寸。' };
    this.ocr ??= new ArknightsOcr(runtime);
    const loaded = await this.ocr.load(resourceDir);
    if (!loaded.ok) return { ok: false, error: `识别不可用：${loaded.error}` };
    return this.ocr.recognize(png, [size.width, size.height]);
  }

  /**
   * 跑一条自有 pipeline。OCR 模型与资源包按需加载；任务结束后抓一帧刷新尺寸，
   * 因为 pipeline 用自己的截图链路点击，`lastFrameSize` 可能停在旧帧。
   */
  async runPipeline(
    entry: string,
    overrides: Record<string, unknown>,
    resourceDir: string,
    timeoutMs?: number,
  ): Promise<PipelineResult> {
    const runtime = this.runtime;
    const pipeline = this.pipeline;
    if (!runtime || !pipeline || !this.connected) {
      return { ok: false, status: null, trace: [], error: 'pipeline 不可用：还没连接游戏窗口，先调用 ark_connect。' };
    }
    // pipeline 里的识别节点依赖 OCR 模型，先确保它在；模型缺失时不必再加载 bundle。
    const model = await runtime.ensureOcrModel(resourceDir);
    if (!model.ok) {
      return { ok: false, status: null, trace: [], error: `pipeline 不可用：${model.error}` };
    }
    const bundle = await runtime.ensureBundle();
    if (!bundle.ok) {
      return { ok: false, status: null, trace: [], error: `pipeline 不可用：${bundle.error}` };
    }
    const result = await pipeline.run(entry, overrides, timeoutMs);
    await this.screencap();
    return result;
  }

  async stop(): Promise<void> {
    await this.pipeline?.stop();
    this.pipeline = null;
    this.runtime?.dispose();
    this.runtime = null;
    this.ocr = null;
    destroyQuietly(this.ctrl);
    this.ctrl = null;
    this.win = null;
    this.maa = null;
    this.lastFrameSize = null;
    this.warnedSizeMismatch = false;
    this.aspectTier = 'ok';
  }

  private readResolution(): readonly [number, number] | null {
    const raw = this.ctrl?.resolution ?? null;
    if (!raw || raw.length < 2) return null;
    const [width, height] = raw;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return [Math.floor(width), Math.floor(height)];
  }
}
