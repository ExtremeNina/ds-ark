/** 窗口枚举结果的纯逻辑：关键字解析与命中选取，不碰原生模块，便于单测。 */
import type { MaaDesktopDevice } from './native.ts';

export interface WindowInfo {
  readonly handle: string;
  readonly className: string;
  readonly windowName: string;
}

/** 配置里没写关键字时用这两个兜底；不同发行版标题不一样，所以给多个。 */
export const DEFAULT_WINDOW_KEYWORDS = ['明日方舟', 'Arknights'] as const;

/**
 * 把配置里的逗号分隔关键字拆成数组，去掉空白与空项。
 * 一项都没写时退回 `fallback`（不修改传入数组）。
 */
export function parseKeywords(raw: string, fallback: readonly string[] = DEFAULT_WINDOW_KEYWORDS): string[] {
  const parsed = String(raw ?? '')
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return parsed.length > 0 ? parsed : [...fallback];
}

/**
 * 按关键字顺序找窗口：第一个关键字命中的第一台设备胜出，结果可预测。
 * 关键字与窗口名都按小写比较，避免大小写差异导致找不到。
 */
export function pickWindow(
  devices: readonly MaaDesktopDevice[] | null | undefined,
  keywords: readonly string[],
): WindowInfo | null {
  if (!devices || devices.length === 0) return null;
  for (const keyword of keywords) {
    const needle = keyword.trim().toLowerCase();
    if (needle === '') continue;
    for (const device of devices) {
      if (!Array.isArray(device) || device.length < 3) continue;
      const [handle, className, windowName] = device;
      if (typeof windowName !== 'string' || windowName.trim() === '') continue;
      if (windowName.toLowerCase().includes(needle)) {
        return { handle, className, windowName };
      }
    }
  }
  return null;
}

/** 回执里给人看的窗口清单，最多 8 条，避免把整个桌面倒进上下文。 */
export function describeDevices(devices: readonly MaaDesktopDevice[] | null | undefined, limit = 8): string {
  if (!devices || devices.length === 0) return '（没有可截图的窗口）';
  const named = devices
    .filter((device) => Array.isArray(device) && device.length >= 3 && String(device[2] ?? '').trim() !== '')
    .slice(0, limit)
    .map((device) => `「${device[2]}」`);
  return named.length > 0 ? named.join('、') : '（窗口名都为空）';
}
