/**
 * 基于 koffi 的经典 MaaCore.dll (Asst.h) 原生 C-API 绑定层：
 * 用于直接调用 MAA 官方桌面版（如 D:/soft/MAA-v6）的原生全权托管引擎。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import koffi from 'koffi';

export type AsstMsgCallback = (msg: number, details: string) => void;

/**
 * MaaCore Win32 控制器输入与截图模式枚举掩码 (对应 AsstCaller.h)
 */
export const MAA_WIN32_INPUT = {
  Seize: 1n,
  SendMessage: 2n,
  PostMessage: 4n,
  SendMessageWithCursorPos: 32n,
} as const;

export const MAA_WIN32_SCREENCAP = {
  GDI: 2n,
  DXGI: 16n,
  DXGI_OR_GDI: 18n,
} as const;

export interface MaaCoreLib {
  readonly version: string;
  create(callback?: AsstMsgCallback): unknown;
  destroy(handle: unknown): Promise<void>;
  loadResource(dir: string): boolean;
  setUserDir(userDir: string): boolean;
  attachWindow(
    handle: unknown,
    hwnd: bigint | number | string,
    screencap?: bigint | number,
    mouse?: bigint | number,
    keyboard?: bigint | number,
  ): boolean;
  connect(handle: unknown, adbPath: string, address: string, config?: string): boolean;
  connected(handle: unknown): boolean;
  appendTask(handle: unknown, taskType: string, params: Record<string, unknown> | string): number;
  start(handle: unknown): boolean;
  stop(handle: unknown): boolean;
  running(handle: unknown): boolean;
}

export function normalizeMaaResourceDir(dir: string): string {
  if (!dir) return dir;
  let cleaned = dir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (cleaned.toLowerCase().endsWith('/resource')) {
    const parent = cleaned.slice(0, cleaned.length - '/resource'.length);
    if (parent) return parent;
  }
  return cleaned;
}

const COMMON_MAA_DIRS = [
  'D:/soft/MAA-v6',
  'C:/Program Files/MAA',
  'D:/Program Files/MAA',
  'C:/MAA',
  'D:/MAA',
  'E:/MAA',
  'C:/Program Files (x86)/MAA',
];

/**
 * 探测本机已安装的 MAA 目录（必须包含 MaaCore.dll）
 */
export function findMaaCoreDir(configuredDir?: string): string | null {
  if (configuredDir && configuredDir.trim()) {
    const candidate = configuredDir.trim().replace(/\\/g, '/');
    if (isValidMaaDir(candidate)) return candidate;
    // 若用户配置了 resource 子目录，回退上一级
    const parent = join(candidate, '..').replace(/\\/g, '/');
    if (isValidMaaDir(parent)) return parent;
    return null;
  }

  for (const candidate of COMMON_MAA_DIRS) {
    if (isValidMaaDir(candidate)) return candidate.replace(/\\/g, '/');
  }

  return null;
}

function isValidMaaDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return existsSync(join(dir, 'MaaCore.dll'));
}

let cachedLib: MaaCoreLib | null = null;
let cachedDir: string | null = null;

/**
 * 加载 MaaCore.dll 并初始化 Asst.h 函数接口
 */
export function loadMaaCoreLib(maaDirInput?: string): MaaCoreLib | null {
  const maaDir = findMaaCoreDir(maaDirInput);
  if (!maaDir) return null;

  if (cachedLib && cachedDir === maaDir) {
    return cachedLib;
  }

  try {
    // 必须将 DLL 所在目录置入 PATH，确保其同级依赖（fastdeploy, onnxruntime, opencv 等）能被动态链接器加载
    if (!process.env.PATH?.includes(maaDir)) {
      process.env.PATH = maaDir + ';' + (process.env.PATH || '');
    }

    const dllPath = join(maaDir, 'MaaCore.dll');
    const lib = koffi.load(dllPath);

    const AsstGetVersion = lib.func('const char* AsstGetVersion()');
    const AsstLoadResource = lib.func('bool AsstLoadResource(const char *path)');
    const AsstSetUserDir = lib.func('bool AsstSetUserDir(const char *path)');
    const AsstCreate = lib.func('void* AsstCreate()');

    const AsstCallback = koffi.proto('void AsstCallback(int msg, const char *details, void *arg)');
    const AsstCreateEx = lib.func('void* AsstCreateEx(AsstCallback *callback, void *arg)');
    const AsstDestroy = lib.func('void AsstDestroy(void *handle)');
    const AsstAttachWindow = lib.func('bool AsstAttachWindow(void *handle, void *hwnd, uint64_t screencap, uint64_t mouse, uint64_t keyboard)');
    const AsstConnect = lib.func('bool AsstConnect(void *handle, const char *adb_path, const char *address, const char *config)');
    const AsstConnected = lib.func('bool AsstConnected(void *handle)');
    const AsstAppendTask = lib.func('int AsstAppendTask(void *handle, const char *type, const char *params)');
    const AsstStart = lib.func('bool AsstStart(void *handle)');
    const AsstStop = lib.func('bool AsstStop(void *handle)');
    const AsstRunning = lib.func('bool AsstRunning(void *handle)');

    const version = typeof AsstGetVersion === 'function' ? String(AsstGetVersion()) : 'unknown';

    // 全局预加载主资源
    AsstLoadResource(normalizeMaaResourceDir(maaDir));

    const registeredCallbacks = new Map<unknown, any>();

    const maaCore: MaaCoreLib = {
      version,
      create(callback) {
        if (callback) {
          const registered = koffi.register((msg: number, details: string) => {
            try {
              callback(msg, details || '');
            } catch {
              // ignore callback error
            }
          }, koffi.pointer(AsstCallback));
          const handle = AsstCreateEx(registered, null);
          if (handle) {
            registeredCallbacks.set(handle, registered);
          } else {
            try { koffi.unregister(registered); } catch {}
          }
          return handle;
        }
        return AsstCreate();
      },
      async destroy(handle) {
        if (!handle) return;
        const reg = registeredCallbacks.get(handle);
        try {
          // 异步化调用 AsstDestroy，避免 C++ 析构清理线程派发回调时与 Node.js 同步主线程死锁
          const destroyPromise = new Promise<void>((resolve, reject) => {
            AsstDestroy.async(handle, (err: unknown) => {
              if (err) reject(err);
              else resolve();
            });
          });
          const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 3000));
          await Promise.race([destroyPromise, timeoutPromise]);
        } catch {
          // 忽略析构异常
        } finally {
          if (reg) {
            try { koffi.unregister(reg); } catch {}
            registeredCallbacks.delete(handle);
          }
        }
      },
      loadResource(dir) {
        return AsstLoadResource(normalizeMaaResourceDir(dir));
      },
      setUserDir(userDir) {
        return AsstSetUserDir(userDir);
      },
      attachWindow(handle, hwnd, screencap = MAA_WIN32_SCREENCAP.DXGI_OR_GDI, mouse = MAA_WIN32_INPUT.SendMessageWithCursorPos, keyboard = MAA_WIN32_INPUT.SendMessage) {
        if (!handle) return false;
        try {
          const hwndPtr = typeof hwnd === 'bigint' ? hwnd : BigInt(hwnd);
          const sc = typeof screencap === 'bigint' ? screencap : BigInt(screencap);
          const ms = typeof mouse === 'bigint' ? mouse : BigInt(mouse);
          const kb = typeof keyboard === 'bigint' ? keyboard : BigInt(keyboard);
          return Boolean(AsstAttachWindow(handle, hwndPtr, sc, ms, kb));
        } catch {
          return false;
        }
      },
      connect(handle, adbPath, address, config = '{}') {
        if (!handle) return false;
        return AsstConnect(handle, adbPath, address, config);
      },
      connected(handle) {
        if (!handle) return false;
        return AsstConnected(handle);
      },
      appendTask(handle, taskType, params) {
        if (!handle) return 0;
        const paramStr = typeof params === 'string' ? params : JSON.stringify(params);
        return AsstAppendTask(handle, taskType, paramStr);
      },
      start(handle) {
        if (!handle) return false;
        return AsstStart(handle);
      },
      stop(handle) {
        if (!handle) return false;
        return AsstStop(handle);
      },
      running(handle) {
        if (!handle) return false;
        return AsstRunning(handle);
      },
    };

    cachedLib = maaCore;
    cachedDir = maaDir;
    return maaCore;
  } catch (error) {
    console.error(`[MaaCore] 加载 DLL 失败（${maaDir}）：`, error);
    return null;
  }
}
