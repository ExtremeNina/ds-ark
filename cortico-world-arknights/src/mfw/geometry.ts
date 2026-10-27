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

/**
 * 暂停按钮的落点。
 *
 * 16:9 下与 `toPoint` 完全一致（默认值在 1280×720 上都是 1236, 51），已标定过的坐标不会失效。
 * 其他比例下按钮仍然贴着右边缘、余量随画面高度缩放，所以用「距右边缘的像素余量」换算，
 * 而不是宽度比例——后者在 4:3 的画面上会偏 10 px 以上。y 不受宽度影响，照旧按高度换算。
 */
export function pausePoint(
  norm: { readonly x: number; readonly y: number },
  size: readonly [number, number],
): { x: number; y: number } {
  const [width, height] = size;
  if (is16by9(width, height)) return toPoint(norm, size);
  const last = Math.max(0, Math.floor(width) - 1);
  // 16:9 的参照宽度是 16/9 × 高度；把 x 换算成「距右边缘多少像素」，再贴到当前帧的右边缘。
  const margin = Math.round((1 - clamp01(norm?.x ?? 0)) * ASPECT_16_9 * Math.max(0, Math.floor(height) - 1));
  return { x: Math.min(last, Math.max(0, last - margin)), y: toPixel(norm?.y ?? 0, height) };
}
