/**
 * 原生调用一律过超时。绑定卡住时 `wait()` 永不返回，会挂起 Coopanion 的主循环，
 * 代价远高于一次失败回执；这里不做重试，避免向游戏重复发点击。
 */

export class MaaTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}超过 ${ms} 毫秒没有返回`);
    this.name = 'MaaTimeoutError';
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MaaTimeoutError(label, ms)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
