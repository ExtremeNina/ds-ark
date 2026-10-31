/**
 * Copilot 作业定义与执行：
 * 遵循 MAA Copilot JSON 标准格式规范，负责计划校验、动作解析与战场指令生成。
 */
import type { DeployDirection } from './deploy.ts';
import { getStageDimension, type MapDimension, tileToScreen } from './tile-pos.ts';

export type CopilotActionType =
  | 'Deploy'
  | '部署'
  | 'Skill'
  | '技能'
  | 'Retreat'
  | '撤退'
  | 'SpeedUp'
  | '二倍速'
  | 'Wait'
  | '等待';

export interface CopilotAction {
  type: CopilotActionType;
  name?: string;
  location?: [number, number] | { x: number; y: number };
  direction?: string;
  costs?: number;
  kills?: number;
  delay?: number;
  pre_delay?: number;
  rear_delay?: number;
}

export interface CopilotPlan {
  stage_name: string;
  actions: CopilotAction[];
  opers?: Array<{ name: string; skill?: number; skill_usage?: number }>;
  groups?: Array<{ name: string; opers: Array<{ name: string; skill?: number }> }>;
  doc?: { title?: string; details?: string };
}

/** 规范化朝向 */
export function normalizeDirection(raw?: string): DeployDirection {
  if (!raw) return 'right';
  const lower = raw.trim().toLowerCase();
  if (lower === 'up' || lower === '上') return 'up';
  if (lower === 'down' || lower === '下') return 'down';
  if (lower === 'left' || lower === '左') return 'left';
  return 'right';
}

/** 校验并解析 Copilot JSON */
export function parseCopilotPlan(raw: unknown): { ok: true; plan: CopilotPlan } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: '作业格式错误：输入必须是 JSON 对象。' };
  }
  const obj = raw as Record<string, unknown>;
  const stageName = typeof obj.stage_name === 'string' ? obj.stage_name.trim() : '';
  if (!stageName) {
    return { ok: false, error: '作业格式错误：缺少 stage_name（例如 "2-10" 或 "1-7"）。' };
  }

  if (!Array.isArray(obj.actions)) {
    return { ok: false, error: '作业格式错误：缺少 actions 动作列表数组。' };
  }

  const actions: CopilotAction[] = [];
  for (let i = 0; i < obj.actions.length; i++) {
    const item = obj.actions[i];
    if (!item || typeof item !== 'object') {
      return { ok: false, error: `第 ${i + 1} 个动作格式错误：必须为对象。` };
    }
    const act = item as Record<string, unknown>;
    const type = String(act.type || '').trim() as CopilotActionType;
    if (!type) {
      return { ok: false, error: `第 ${i + 1} 个动作缺少 type 类型。` };
    }

    const action: CopilotAction = { type };
    if (typeof act.name === 'string') action.name = act.name.trim();
    if (typeof act.direction === 'string') action.direction = act.direction.trim();
    if (typeof act.costs === 'number' && Number.isFinite(act.costs)) action.costs = act.costs;
    if (typeof act.kills === 'number' && Number.isFinite(act.kills)) action.kills = act.kills;
    if (typeof act.delay === 'number' && Number.isFinite(act.delay)) action.delay = act.delay;
    if (typeof act.pre_delay === 'number' && Number.isFinite(act.pre_delay)) action.pre_delay = act.pre_delay;
    if (typeof act.rear_delay === 'number' && Number.isFinite(act.rear_delay)) action.rear_delay = act.rear_delay;

    if (Array.isArray(act.location) && act.location.length >= 2) {
      const col = Number(act.location[0]);
      const row = Number(act.location[1]);
      if (Number.isFinite(col) && Number.isFinite(row)) {
        action.location = [col, row];
      }
    } else if (act.location && typeof act.location === 'object') {
      const loc = act.location as { x?: unknown; y?: unknown };
      if (typeof loc.x === 'number' && typeof loc.y === 'number') {
        action.location = { x: loc.x, y: loc.y };
      }
    }

    actions.push(action);
  }

  return {
    ok: true,
    plan: {
      stage_name: stageName,
      actions,
      opers: Array.isArray(obj.opers) ? (obj.opers as CopilotPlan['opers']) : undefined,
      groups: Array.isArray(obj.groups) ? (obj.groups as CopilotPlan['groups']) : undefined,
      doc: obj.doc && typeof obj.doc === 'object' ? (obj.doc as CopilotPlan['doc']) : undefined,
    },
  };
}

/** 换算动作中的目标地块归一化坐标 */
export function resolveActionTile(action: CopilotAction, dimension: MapDimension): { x: number; y: number } | null {
  if (!action.location) return null;
  return tileToScreen(action.location, dimension);
}

export interface HandCardResolutionContext {
  readonly handCosts?: ReadonlyArray<{ readonly cost: number; readonly x: number }>;
  readonly actionIndex?: number;
  readonly deployedCount?: number;
}

/**
 * 动态计算待部署卡牌在屏幕底部的归一化位置 (x, y)，彻底解决固定硬编码盲拖问题。
 * 1. 优先度 1：若 OCR 识别到了手牌费用，且与待部署动作费用相符（或相差不超过 1 费潜能公差），使用该卡牌真实坐标。
 * 2. 优先度 2：若 OCR 识别到了手牌但费用未匹配，按已部署干员数在识别到的手牌队列中顺位选取。
 * 3. 优先度 3（保底）：若 OCR 未能识别到手牌，根据已部署干员数动态偏移，避免死抓同一坐标。
 */
export function resolveHandCardPosition(
  action: CopilotAction,
  ctx: HandCardResolutionContext = {},
): { x: number; y: number } {
  const y = 0.88;
  const handCosts = ctx.handCosts ?? [];

  if (handCosts.length > 0) {
    if (typeof action.costs === 'number' && Number.isFinite(action.costs)) {
      // 容差 ±1（潜能减费常为 1 点）
      const matched = handCosts.find((c) => Math.abs(c.cost - action.costs!) <= 1);
      if (matched) {
        return { x: matched.x, y };
      }
    }
    // 没按费用精准匹配，按已部署数量在当前手牌从右往左（或从左往右）顺位选取
    const index = Math.min(ctx.deployedCount ?? 0, handCosts.length - 1);
    return { x: handCosts[index]!.x, y };
  }

  // 保底：默认从右侧主力手牌区 (0.82) 开始，随部署动作依次向左切换槽位
  const step = (ctx.deployedCount ?? 0) % 5;
  const x = Math.max(0.30, Math.min(0.88, 0.82 - step * 0.11));
  return { x, y };
}

