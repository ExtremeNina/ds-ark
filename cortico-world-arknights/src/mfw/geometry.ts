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

/** 16:9 的宽高比；暂停键默认值就是按这个比例标定的。 */
export const ASPECT_16_9 = 16 / 9;

/**
 * 判断画面是否接近 16:9。容差 0.02 足够把 1280×720（1.778）与 1152×720（1.600）分开，
 * 又不会因为一两个像素的取整误差误报。
 */
export function is16by9(width: number, height: number, tolerance = 0.02): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  return Math.abs(width / height - ASPECT_16_9) <= tolerance;
}

/** 一次点击的落点。 */
export function toPoint(
  norm: { readonly x: number; readonly y: number },
  size: readonly [number, number],
): { x: number; y: number } {
  const [width, height] = size;
  return { x: toPixel(norm?.x ?? 0, width), y: toPixel(norm?.y ?? 0, height) };
}
