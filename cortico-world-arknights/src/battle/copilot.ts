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
