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
  readonly uuid: string | null;
  post_connection(): MaaJobLike;
  post_click(x: number, y: number, contact?: number, pressure?: number): MaaJobLike;
  post_screencap(): MaaImageJobLike;
  destroy(): void;
}

export interface MaaWin32ControllerCtor {
  new (handle: string, screencapMethod: string, mouseMethod: string, keyboardMethod: string): MaaControllerLike;
  find(): Promise<readonly MaaDesktopDevice[] | null>;
}

/** 只声明本扩展用到的部分；真实模块由 `loadMaa()` 一次性断言成这个形状。 */
export interface MaaModule {
  readonly Win32Controller: MaaWin32ControllerCtor;
  readonly Win32ScreencapMethod?: Record<string, string>;
  readonly Win32InputMethod?: Record<string, string>;
  readonly Global?: { readonly version?: string };
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

/** 成功或失败都只算一次；失败原因被缓存，不在每次调用重试。 */
export async function loadMaa(): Promise<MaaLoadResult> {
  if (settled) return settled;
  if (!loading) {
    loading = import('@maaxyz/maa-node').then(
      (mod) => {
        settled = { ok: true, maa: mod as unknown as MaaModule };
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

/** 仅供测试：清掉缓存，让下一次 `loadMaa()` 重新走动态导入。 */
export function resetMaaLoader(): void {
  settled = null;
  loading = null;
}
