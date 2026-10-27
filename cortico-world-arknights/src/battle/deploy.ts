/**
 * 部署几何：模型给出「手牌位置 + 地块位置 + 朝向」（都是 0~1 归一化），这里换算成两次拖拽。
 *
 * 只算端点与时长，不碰原生：调用方拿到 `plan` 后依次发「手牌 → 地块」「地块 → 朝向」。
 * 朝向偏移按画面高度取比例，换分辨率不用改代码；夹回画面内之后如果与地块重合，
 * 说明这个朝向在这个位置根本拖不出来（地块贴边），直接拒绝，而不是发一次零长度拖拽。
 */
import { toPoint } from '../mfw/geometry.ts';

export const DEPLOY_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type DeployDirection = (typeof DEPLOY_DIRECTIONS)[number];

export interface DeployPoint {
  readonly x: number;
  readonly y: number;
}

export interface DeployPlan {
  /** 手牌上的按下点（像素）。 */
  readonly card: DeployPoint;
  /** 地块中心（像素），也是第二步拖拽的起点。 */
  readonly tile: DeployPoint;
  /** 抬手指的位置（像素），决定朝向。 */
  readonly release: DeployPoint;
  /** 第一步拖拽时长（毫秒）。 */
  readonly holdMs: number;
  /** 两步之间的停顿（毫秒）：给游戏留出进入「选朝向」状态的时间。 */
  readonly gapMs: number;
  /** 第二步定向拖拽时长（毫秒）。 */
  readonly directionMs: number;
}

/** 可调的拖拽时序；不传就用默认值，行为与旧版本一致。 */
export interface DeployTiming {
  readonly holdMs?: number;
  readonly gapMs?: number;
  readonly directionMs?: number;
}

export type DeployResult = { readonly ok: true; readonly plan: DeployPlan } | { readonly ok: false; readonly error: string };

/** 取卡到落位给足时间，让游戏进入「按住拖拽」状态；定向只求一次干净的短滑动。 */
const HOLD_MS = 260;
const DIRECTION_MS = 160;
/** 定向位移相对画面高度的比例：720 高约 79 像素，够触发方向选择又不至于滑出屏幕。 */
const DIRECTION_OFFSET_RATIO = 0.11;

/** 毫秒参数的兜底：非数字、负数走默认值，超过上限就夹住，避免把工具卡死。 */
function clampMs(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, Math.round(value)));
}

function isUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function clampPixel(value: number, size: number): number {
  const last = Math.max(0, Math.floor(size) - 1);
  return Math.min(last, Math.max(0, Math.round(value)));
}

function pointOf(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return isUnit(x) && isUnit(y) ? { x, y } : null;
}

export function planDeploy(
  card: unknown,
  tile: unknown,
  direction: unknown,
  size: readonly [number, number],
  timing?: DeployTiming,
): DeployResult {
  const [width, height] = size;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, error: '部署失败：还不知道画面尺寸，先调用 ark_screencap 取一帧。' };
  }

  if (typeof direction !== 'string' || !(DEPLOY_DIRECTIONS as readonly string[]).includes(direction)) {
    return { ok: false, error: `部署失败：朝向必须是 ${DEPLOY_DIRECTIONS.join(' / ')} 之一。` };
  }

  const cardPoint = pointOf(card);
  if (!cardPoint) {
    return { ok: false, error: '部署失败：card 必须是 0~1 的归一化坐标 { x, y }，从附件画面里取手牌位置。' };
  }
  const tilePoint = pointOf(tile);
  if (!tilePoint) {
    return { ok: false, error: '部署失败：tile 必须是 0~1 的归一化坐标 { x, y }，从附件画面里取目标地块。' };
  }

  const cardPx = toPoint(cardPoint, [width, height]);
  const tilePx = toPoint(tilePoint, [width, height]);
  const step = Math.max(1, Math.round(height * DIRECTION_OFFSET_RATIO));
  const dx = direction === 'left' ? -step : direction === 'right' ? step : 0;
  const dy = direction === 'up' ? -step : direction === 'down' ? step : 0;
  const release = {
    x: clampPixel(tilePx.x + dx, width),
    y: clampPixel(tilePx.y + dy, height),
  };

  if (release.x === tilePx.x && release.y === tilePx.y) {
    return {
      ok: false,
      error: '部署失败：地块贴着画面边缘，这个朝向拖不出方向选择。换一个更靠里的地块，或换个朝向。',
    };
  }

  return {
    ok: true,
    plan: {
      card: cardPx,
      tile: tilePx,
      release,
      // 上限 5 秒：拖拽本来就是毫秒级动作，配错成 60000 不该把一次调用挂在那儿。
      holdMs: clampMs(timing?.holdMs, HOLD_MS, 5000),
      gapMs: clampMs(timing?.gapMs, 0, 3000),
      directionMs: clampMs(timing?.directionMs, DIRECTION_MS, 5000),
    },
  };
}
