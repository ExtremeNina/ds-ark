/**
 * 原生绑定 `@maaxyz/maa-node` 的懒加载。
 *
 * 装配层会为未启用的 World 构造实例，`check:extension` 也在假部署里构造；这些场景没有游戏、
 * 甚至没有原生二进制。因此这里一律不抛错：加载失败折成可读原因，由工具回执转达，
 * `create()` 与 `start()` 依然成功。
 */

/** 桌面窗口三元组：句柄、类名、窗口名。 */
export type MaaDesktopDevice = readonly [handle: string, className: string, windowName: string];

/** Job 的同步结果位；`await job.wait()` 解出来的就是 Job 本身。 */
export interface MaaJobLike {
  readonly succeeded: boolean;
  readonly status: number;
  wait(): Promise<MaaJobLike>;
}

/** 截图 Job：编码后的画面（PNG）同步取出。 */
export interface MaaImageJobLike {
  wait(): Promise<MaaImageJobLike>;
  get(): ArrayBuffer | Uint8Array | null;
}

export interface MaaControllerLike {
  readonly connected: boolean;
  readonly resolution: [number, number] | null;
  post_connection(): MaaJobLike;
  post_click(x: number, y: number, contact?: number, pressure?: number): MaaJobLike;
  /** 拖拽（部署用）；旧绑定可能没有这个方法，调用前要判空。 */
  post_swipe?(x1: number, y1: number, x2: number, y2: number, duration: number, contact?: number, pressure?: number): MaaJobLike;
  post_screencap(): MaaImageJobLike;
  destroy(): void;
}

export interface MaaWin32ControllerCtor {
  new (handle: string, screencapMethod: string, mouseMethod: string, keyboardMethod: string): MaaControllerLike;
  find(): Promise<readonly MaaDesktopDevice[] | null>;
}

/** TaskJob：比普通 Job 多一个 id 与同步取结果的 `get()`。 */
export interface MaaTaskJobLike extends MaaJobLike {
  readonly id: number;
  get(): unknown;
}

/** Resource：只用到「加载 OCR 模型」这一件事。 */
export interface MaaResourceLike {
  readonly loaded: boolean;
  post_ocr_model(path: string): MaaJobLike;
  destroy(): void;
}

/**
 * Tasker：只用来对单张图跑识别（`post_recognition`）。
 * 刻意不声明 `post_task`：本扩展不把控制权交给 pipeline。
 */
export interface MaaTaskerLike {
  resource: MaaResourceLike | null;
  controller: MaaControllerLike | null;
  post_recognition(type: string, param: Record<string, unknown>, image: ArrayBuffer): MaaTaskJobLike;
  node_detail(id: number): unknown;
  recognition_detail(id: number): unknown;
  destroy(): void;
}

export interface MaaResourceCtor {
  new (): MaaResourceLike;
}

export interface MaaTaskerCtor {
  new (): MaaTaskerLike;
}

/** 只声明本扩展用到的部分；真实模块由 `loadMaa()` 一次性断言成这个形状。 */
export interface MaaModule {
  readonly Win32Controller: MaaWin32ControllerCtor;
  readonly Win32ScreencapMethod?: Record<string, string>;
  readonly Win32InputMethod?: Record<string, string>;
  /** 以下两项缺失时不报错，只是没有 OCR 能力。 */
  readonly Resource?: MaaResourceCtor;
  readonly Tasker?: MaaTaskerCtor;
}

export type MaaLoadResult = { ok: true; maa: MaaModule } | { ok: false; error: string };

let settled: MaaLoadResult | null = null;
let loading: Promise<MaaLoadResult> | null = null;

function describe(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return '缺少 @maaxyz/maa-node：用 corepack pnpm install 装好依赖后重启 Coopanion。';
  }
  return `加载 @maaxyz/maa-node 失败：${detail}`;
}

/**
 * `@maaxyz/maa-node` 是 CommonJS：`module.exports = globalThis.maa`，属性是动态挂上去的，
 * 所以 ESM 的具名导入看不见它们，`import()` 的结果里只有 `default`。这里把两种形状都接住。
 */
export function unwrapMaaModule(mod: unknown): MaaModule {
  const named = mod as Partial<MaaModule> | undefined;
  if (named && typeof named.Win32Controller === 'function') return named as MaaModule;
  const fallback = (mod as { default?: Partial<MaaModule> } | undefined)?.default;
  if (fallback && typeof fallback.Win32Controller === 'function') return fallback as MaaModule;
  throw new Error('模块没有导出 Win32Controller：可能是版本不匹配，或平台原生包没装上');
}

/** 成功或失败都只算一次；失败原因被缓存，不在每次调用重试。 */
export async function loadMaa(): Promise<MaaLoadResult> {
  if (settled) return settled;
  if (!loading) {
    loading = import('@maaxyz/maa-node').then(
      (mod) => {
        settled = { ok: true, maa: unwrapMaaModule(mod) };
        return settled;
      },
      (error: unknown) => {
        settled = { ok: false, error: describe(error) };
        return settled;
      },
    );
  }
  return loading;
}
