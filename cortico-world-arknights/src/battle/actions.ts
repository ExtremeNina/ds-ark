/**
 * 通用动作：把模型给的 0~1 坐标换算成像素点，顺带做参数校验。
 *
 * 与 `deploy.ts` 同构——只算计划、不碰原生；参数不合法时一次手势都不发。
 * 导航（首页 → 终端 → 关卡列表 → 开始行动）与战斗内点击共用这一层。
 */
import { toPoint } from '../mfw/geometry.ts';

export interface ActionPoint {
  readonly x: number;
  readonly y: number;
}

export interface ClickPlan {
  readonly at: ActionPoint;
}

export type ClickResult =
  | { readonly ok: true; readonly plan: ClickPlan }
  | { readonly ok: false; readonly error: string };

export interface SwipePlan {
  readonly from: ActionPoint;
  readonly to: ActionPoint;
  readonly durationMs: number;
  /** 连续拖几次（关卡列表要滑好几屏时用）。 */
  readonly repeats: number;
  /** 两次拖拽之间停多久，毫秒。 */
  readonly intervalMs: number;
}

export type SwipeResult =
  | { readonly ok: true; readonly plan: SwipePlan }
  | { readonly ok: false; readonly error: string };

/**
 * 两端至少要差这么多像素。
 *
 * 阈值是 1 不是 2：3D 章节地图/战场里 `post_click` 会被游戏当成镜头微移，
 * 1 像素的微拖拽（down → move → up）反而是点开关卡牌的可靠手势，不能拦掉。
 */
const MIN_SWIPE_DISTANCE = 1;
const MIN_DURATION_MS = 80;
const MAX_DURATION_MS = 2000;
const DEFAULT_DURATION_MS = 300;
const MAX_REPEATS = 5;
const DEFAULT_INTERVAL_MS = 120;
const MAX_INTERVAL_MS = 1000;

function isUsableSize(size: readonly [number, number]): boolean {
  const [width, height] = size;
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

function unitOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function pointOf(value: unknown): ActionPoint | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  const unitX = unitOf(x);
  const unitY = unitOf(y);
  return unitX === null || unitY === null ? null : { x: unitX, y: unitY };
}

/** 点一下：越界、非数字、尺寸未知都在发手势之前拒绝。 */
export function planClick(point: unknown, size: readonly [number, number]): ClickResult {
  if (!isUsableSize(size)) {
    return { ok: false, error: '点击失败：还不知道画面尺寸，先调用 ark_screencap 取一帧。' };
  }
  const unit = pointOf(point);
  if (!unit) {
    return { ok: false, error: '点击失败：x / y 必须是 0~1 的归一化坐标，从附件画面里量。' };
  }
  return { ok: true, plan: { at: toPoint(unit, size) } };
}

/** 拖一下：用于滚动列表、切章节、拖动滑块。零长度会被当成点击，直接拒绝。 */
export function planSwipe(
  from: unknown,
  to: unknown,
  durationMs: unknown,
  size: readonly [number, number],
  options?: { readonly repeats?: unknown; readonly intervalMs?: unknown },
): SwipeResult {
  if (!isUsableSize(size)) {
    return { ok: false, error: '拖拽失败：还不知道画面尺寸，先调用 ark_screencap 取一帧。' };
  }
  const startUnit = pointOf(from);
  const endUnit = pointOf(to);
  if (!startUnit || !endUnit) {
    return { ok: false, error: '拖拽失败：from / to 都必须是 0~1 的归一化坐标 { x, y }。' };
  }

  const start = toPoint(startUnit, size);
  const end = toPoint(endUnit, size);
  const distance = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
  if (distance < MIN_SWIPE_DISTANCE) {
    return { ok: false, error: '拖拽失败：起点与终点几乎重合，游戏会把它当成点击。换一个更远的终点。' };
  }

  const raw = typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.round(durationMs) : DEFAULT_DURATION_MS;
  const duration = Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, raw));

  const rawRepeats = typeof options?.repeats === 'number' && Number.isFinite(options.repeats)
    ? Math.round(options.repeats)
    : 1;
  const repeats = Math.min(MAX_REPEATS, Math.max(1, rawRepeats));

  const rawInterval = typeof options?.intervalMs === 'number' && Number.isFinite(options.intervalMs)
    ? Math.round(options.intervalMs)
    : DEFAULT_INTERVAL_MS;
  const intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(0, rawInterval));

  return { ok: true, plan: { from: start, to: end, durationMs: duration, repeats, intervalMs } };
}
