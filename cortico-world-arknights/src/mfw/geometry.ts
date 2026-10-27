/**
 * 归一化坐标到像素的换算，全是纯函数。
 * 坐标按相对位置存（0~1），换分辨率不用重新校准；越界与脏值一律夹回画面内。
 */

/** 夹到 [0, 1]；NaN / Infinity 归 0。 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** 归一化位置换算成像素下标；尺寸非法时返回 0，边缘值落在最后一个像素上。 */
export function toPixel(normalized: number, size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  const last = Math.max(0, Math.floor(size) - 1);
  return Math.min(last, Math.max(0, Math.round(clamp01(normalized) * last)));
}

/** 一次点击的落点。 */
export function toPoint(
  norm: { readonly x: number; readonly y: number },
  size: readonly [number, number],
): { x: number; y: number } {
  const [width, height] = size;
  return { x: toPixel(norm?.x ?? 0, width), y: toPixel(norm?.y ?? 0, height) };
}
