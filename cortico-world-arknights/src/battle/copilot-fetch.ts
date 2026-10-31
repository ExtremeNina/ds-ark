/**
 * 抄作业与保底策略检索：
 * 1. 提供内置经过验证的标准关卡低配/通用 Copilot 作业
 * 2. 支持从本地 MAA copilot 资源目录检索已有作业
 * 3. 对比玩家当前队伍干员与作业所需干员，识别缺漏并提供组队建议
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCopilotPlan, type CopilotPlan } from './copilot.ts';

const DEFAULT_ONLINE_COPILOT_API = 'https://prts.maa.plus';

/** 从 MAA 在线作业站 (PRTS Plus) 检索并拉取指定关卡的作业 */
export async function fetchOnlineCopilot(
  stageCode: string,
  apiBase = DEFAULT_ONLINE_COPILOT_API,
): Promise<CopilotPlan | null> {
  const code = stageCode.trim();
  if (!code) return null;

  try {
    const queryUrl = `${apiBase.replace(/\/+$/, '')}/copilot/query?page=1&limit=3&levelKeyword=${encodeURIComponent(code)}`;
    const queryRes = await fetch(queryUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });
    if (!queryRes.ok) return null;

    const listData = (await queryRes.json()) as { data?: Array<{ id: number | string; title?: string }> };
    const items = Array.isArray(listData?.data) ? listData.data : [];
    if (items.length === 0 || !items[0]?.id) return null;

    const targetId = items[0].id;
    const detailUrl = `${apiBase.replace(/\/+$/, '')}/copilot/get/${targetId}`;
    const detailRes = await fetch(detailUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });
    if (!detailRes.ok) return null;

    const detailData = (await detailRes.json()) as { data?: { content?: unknown } | unknown; content?: unknown };
    const rawContent = (detailData as any)?.data?.content ?? (detailData as any)?.content ?? detailData;
    let planObj = rawContent;
    if (typeof rawContent === 'string') {
      try {
        planObj = JSON.parse(rawContent);
      } catch {
        return null;
      }
    }

    const verified = parseCopilotPlan(planObj);
    if (verified.ok) {
      return verified.plan;
    }
  } catch {
    // 网络受限或 API 异常时静默降级到本地
  }

  return null;
}

/** 内置常见关卡保底低配作业（3星/基础干员） */
export const PRESET_COPILOT_PLANS: Record<string, CopilotPlan> = {
  '1-7': {
    stage_name: '1-7',
    doc: {
      title: '1-7 低配速刷',
      details: '先锋地面阻挡 + 高台单狙输出。',
    },
    opers: [
      { name: '芬' },
      { name: '克洛丝' },
    ],
    actions: [
      { type: 'SpeedUp' },
      { type: 'Deploy', name: '芬', location: [4, 3], direction: 'Right', costs: 9 },
      { type: 'Deploy', name: '克洛丝', location: [3, 1], direction: 'Right', costs: 10 },
    ],
  },
  '2-10': {
    stage_name: '2-10',
    doc: {
      title: '2-10 病入膏肓 双先锋双狙击双重装',
      details: '碎骨关卡：先锋开局产费，狙击补充输出，重装阻挡碎骨并配合医疗维持血线。',
    },
    opers: [
      { name: '芬' },
      { name: '香草' },
      { name: '克洛丝' },
      { name: '米格鲁' },
      { name: '安洁莉娜' },
    ],
    actions: [
      { type: 'SpeedUp' },
      // 1. 中路先锋阻挡产费
      { type: 'Deploy', name: '芬', location: [4, 4], direction: 'Right', costs: 9 },
      // 2. 高台狙击向右输出
      { type: 'Deploy', name: '克洛丝', location: [3, 3], direction: 'Right', costs: 11 },
      // 3. 辅助/术师补充伤害
      { type: 'Deploy', name: '安洁莉娜', location: [2, 3], direction: 'Down', costs: 14 },
      // 4. 重装接替下路阻挡
      { type: 'Deploy', name: '米格鲁', location: [5, 4], direction: 'Right', costs: 16 },
    ],
  },
  '0-1': {
    stage_name: '0-1',
    doc: {
      title: '0-1 教学关',
      details: '单先锋部署即可。',
    },
    opers: [{ name: '芬' }],
    actions: [
      { type: 'Deploy', name: '芬', location: [4, 3], direction: 'Right', costs: 8 },
    ],
  },
};

/**
 * 检索指定关卡的 Copilot 作业
 */
/**
 * 检索指定关卡的 Copilot 作业：
 * 1. 优先查本地内置预制（0-1、1-7、2-10 等常用关）
 * 2. 查本地 MAA 资源目录
 * 3. 查 MAA Copilot 线上作业站 (prts.maa.plus)
 */
export async function fetchCopilotPlan(
  stageCode: string,
  resourceDir?: string,
  onlineApiUrl?: string,
): Promise<CopilotPlan | null> {
  const code = stageCode.trim().toUpperCase();

  // 1. 优先查内置预制
  for (const [key, plan] of Object.entries(PRESET_COPILOT_PLANS)) {
    if (key.toUpperCase() === code) {
      return plan;
    }
  }

  // 2. 若配置了 resourceDir，尝试在 MAA 目录及子目录搜索
  if (resourceDir) {
    const copilotDir = join(resourceDir, 'copilot');
    if (existsSync(copilotDir)) {
      const match = searchJsonInDir(copilotDir, code);
      if (match) return match;
    }
  }

  // 3. 尝试从线上 MAA 作业站拉取
  const online = await fetchOnlineCopilot(code, onlineApiUrl);
  if (online) return online;

  return null;
}

function searchJsonInDir(dir: string, targetCode: string): CopilotPlan | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = searchJsonInDir(fullPath, targetCode);
        if (sub) return sub;
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const raw = readFileSync(fullPath, 'utf8');
          const data = JSON.parse(raw) as CopilotPlan;
          if (data && typeof data === 'object' && typeof data.stage_name === 'string') {
            if (data.stage_name.toUpperCase() === targetCode || entry.name.toUpperCase().includes(targetCode)) {
              return data;
            }
          }
        } catch {
          // ignore corrupted json
        }
      }
    }
  } catch {
    // ignore dir errors
  }
  return null;
}

export interface FormationComparison {
  readonly matched: string[];
  readonly missing: string[];
  readonly canExecuteDirectly: boolean;
  readonly notes: string;
}

/**
 * 将作业要求的干员与当前队伍干员比对
 */
export function compareFormation(
  plan: CopilotPlan,
  currentTeam: readonly string[],
): FormationComparison {
  const required = new Set<string>();
  if (plan.opers) {
    for (const o of plan.opers) {
      if (o.name) required.add(o.name);
    }
  }
  for (const act of plan.actions) {
    if (act.type === 'Deploy' || act.type === '部署') {
      if (act.name) required.add(act.name);
    }
  }

  const teamSet = new Set(currentTeam.map((c) => c.trim()));
  const matched: string[] = [];
  const missing: string[] = [];

  for (const req of required) {
    if (teamSet.has(req)) {
      matched.push(req);
    } else {
      missing.push(req);
    }
  }

  const canExecuteDirectly = missing.length === 0;
  let notes = '';
  if (canExecuteDirectly) {
    notes = `当前编队包含作业所需的全部干员（${matched.join('、')}），可直接执行。`;
  } else {
    notes = `当前编队缺少干员【${missing.join('、')}】。请向用户询问是否使用同定位下位干员替代，或征得同意后调整编队。`;
  }

  return {
    matched,
    missing,
    canExecuteDirectly,
    notes,
  };
}
