/**
 * 集成战略（肉鸽）核心定义与参数类型规范
 * 覆盖黑流树海 (BlackFlow)、萨卡兹 (Sarkaz)、萨米 (Sami)、水月 (Mizuki)、傀影 (Phantom)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type RoguelikeTheme = 'BlackFlow' | 'Sarkaz' | 'Sami' | 'Mizuki' | 'Phantom';

export interface RoguelikeOperatorPriority {
  readonly name: string;
  readonly skill?: number;
  readonly alternate_skill?: number;
  readonly is_key?: boolean;
  readonly is_start?: boolean;
  readonly recruit_priority?: number;
  readonly promote_priority?: number;
}

export interface RoguelikeStrategyGroup {
  readonly name: string;
  readonly opers: RoguelikeOperatorPriority[];
}

export interface RoguelikeStrategyInfo {
  readonly theme: RoguelikeTheme;
  readonly themeLabel: string;
  readonly defaultKeyOperators: string[];
  readonly priorityGroups: RoguelikeStrategyGroup[];
  readonly topRelics: Array<{ name: string; effect?: string }>;
  readonly popularSquads: string[];
  readonly popularRoles: string[];
}

export interface RoguelikeTaskParams {
  readonly theme: RoguelikeTheme;
  readonly mode?: number;                  // 0: 常规探索通关(默认), 1: 刷源石锭(存钱模式)
  readonly starts_count?: number;          // 探索轮数 (默认 1)
  readonly investment_withdrawn?: boolean; // 缺钱时是否取款
  readonly stop_at_final_stage?: boolean;  // 是否在关底 Boss 前停手交给人机共战
  readonly use_assist?: boolean;           // 是否借助战
  readonly custom_recruitment?: RoguelikeOperatorPriority[];
  readonly squad?: string;                 // 开局分队名称 (如 "指挥分队", "突击战术分队", "蓝图测绘分队")
  readonly roles?: string;                 // 开局招募职业组合 (如 "先手必胜", "取长补短", "随心所欲")
  readonly core_char?: string;             // 开局首选核心干员 (如 "维什戴尔", "机械师")
  readonly interactive_recruit?: boolean;  // 局中招募是否暂停交由大模型自主挑选 (方案A, 默认 true)
  readonly interactive_squad?: boolean;    // 分队选择是否暂停交由大模型自主挑选 (默认 true)
  readonly interactive_route?: boolean;    // 大地图路线规划是否暂停交由大模型自主决策 (默认 true)
  readonly interactive_ticket?: boolean;   // 招募券选择是否暂停交由大模型自主挑选 (默认 true)
  readonly interactive_formation?: boolean;// 战前编队是否暂停交由大模型自主挑选 (默认 true)
}

/**
 * 标准化肉鸽探索模式
 * MAA 原生仅支持：
 * 0: 常规探索与通关 (Exp)
 * 1: 刷源石锭 / 快速投资 (Investment)
 * 其余输入（如 2、负数、未知模式等）一律防呆纠正为 0，防止 MaaCore 报错 "Unknown mode"。
 */
export function normalizeRoguelikeMode(raw?: unknown): number {
  if (raw === 1 || raw === '1') return 1;
  return 0;
}

export const ROLE_ALIASES: Record<string, string> = {
  攻坚备战: '攻守兼备',
  攻坚: '攻守兼备',
  攻守: '攻守兼备',
  先手: '先手必胜',
  先手必胜: '先手必胜',
  备战: '攻守兼备',
  取长: '取长补短',
  取长补短: '取长补短',
  随心: '随心所欲',
  随心所欲: '随心所欲',
  坚不可摧: '坚不可摧',
  灵活部署: '灵活部署',
};

/** 标准化职业组合名称（防呆纠偏，如将常见的“攻坚备战”纠正为游戏内正式名称“攻守兼备”） */
export function normalizeRoleName(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  for (const [alias, canonical] of Object.entries(ROLE_ALIASES)) {
    if (trimmed.includes(alias)) return canonical;
  }
  return trimmed;
}

export const SQUAD_ALIASES: Record<string, string> = {
  远程: '远程战术分队',
  远程战术: '远程战术分队',
  远程战术分队: '远程战术分队',
  突击: '突击战术分队',
  突击战术: '突击战术分队',
  突击战术分队: '突击战术分队',
  堡垒: '堡垒战术分队',
  堡垒战术: '堡垒战术分队',
  堡垒战术分队: '堡垒战术分队',
  破坏: '破坏战术分队',
  破坏战术: '破坏战术分队',
  破坏战术分队: '破坏战术分队',
  指挥: '指挥分队',
  指挥分队: '指挥分队',
  集群: '集群分队',
  集群分队: '集群分队',
  后勤: '后勤分队',
  后勤分队: '后勤分队',
  研究: '研究分队',
  研究分队: '研究分队',
  机械学者: '机械学者分队',
  机械学者分队: '机械学者分队',
  因地制宜: '因地制宜分队',
  因地制宜分队: '因地制宜分队',
  科学主义: '科学主义分队',
  科学主义分队: '科学主义分队',
  心胜于物: '心胜于物分队',
  心胜于物分队: '心胜于物分队',
};

/** 标准化分队名称（防呆纠偏，将“远程”映射为“远程战术分队”等） */
export function normalizeSquadName(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  for (const [alias, canonical] of Object.entries(SQUAD_ALIASES)) {
    if (trimmed.includes(alias)) return canonical;
  }
  return trimmed;
}

export const ROGUELIKE_THEMES: Record<string, {
  theme: RoguelikeTheme;
  label: string;
  aliases: string[];
  squads: string[];
  roles: string[];
}> = {
  blackflow: {
    theme: 'BlackFlow',
    label: '黑流树海',
    aliases: ['黑流树海', '黑流', '树海', 'blackflow'],
    squads: ['指挥分队', '集群分队', '后勤分队', '突击战术分队', '堡垒战术分队', '远程战术分队', '破坏战术分队', '研究分队', '机械学者分队'],
    roles: ['先手必胜 (先锋/近卫/特种)', '攻守兼备 (重装/狙击/术师)', '取长补短 (近卫/狙击/医疗)', '随心所欲 (随机职业组合)'],
  },
  sarkaz: {
    theme: 'Sarkaz',
    label: '萨卡兹的无终奇语',
    aliases: ['萨卡兹', '萨卡兹肉鸽', '无终奇语', 'sarkaz'],
    squads: ['指挥分队', '集群分队', '后勤分队', '突击战术分队', '堡垒战术分队', '远程战术分队', '破坏战术分队', '研究分队', '因地制宜分队'],
    roles: ['先手必胜 (先锋/近卫/特种)', '攻守兼备 (重装/狙击/术师)', '取长补短 (近卫/狙击/医疗)', '随心所欲 (随机职业组合)'],
  },
  sami: {
    theme: 'Sami',
    label: '探索者的银霜止境',
    aliases: ['萨米', '萨米肉鸽', '银霜止境', 'sami'],
    squads: ['指挥分队', '集群分队', '后勤分队', '突击战术分队', '堡垒战术分队', '远程战术分队', '破坏战术分队', '科学主义分队'],
    roles: ['先手必胜 (先锋/近卫/特种)', '攻守兼备 (重装/狙击/术师)', '取长补短 (近卫/狙击/医疗)', '随心所欲 (随机职业组合)'],
  },
  mizuki: {
    theme: 'Mizuki',
    label: '水月与深蓝之树',
    aliases: ['水月', '水月肉鸽', '深蓝之树', 'mizuki'],
    squads: ['指挥分队', '集群分队', '后勤分队', '突击战术分队', '堡垒战术分队', '远程战术分队', '破坏战术分队', '心胜于物分队'],
    roles: ['先手必胜 (先锋/近卫/特种)', '攻守兼备 (重装/狙击/术师)', '取长补短 (近卫/狙击/医疗)', '随心所欲 (随机职业组合)'],
  },
  phantom: {
    theme: 'Phantom',
    label: '傀影与猩红孤钻',
    aliases: ['傀影', '傀影肉鸽', '猩红孤钻', 'phantom'],
    squads: ['指挥分队', '集群分队', '后勤分队', '突击战术分队', '堡垒战术分队', '远程战术分队', '破坏战术分队'],
    roles: ['先手必胜 (先锋/近卫/特种)', '攻守兼备 (重装/狙击/术师)', '取长补短 (近卫/狙击/医疗)', '随心所欲 (随机职业组合)'],
  },
};

/** 标准化肉鸽主题名称 */
export function normalizeRoguelikeTheme(raw?: string): RoguelikeTheme {
  if (!raw) return 'BlackFlow';
  const clean = raw.trim().toLowerCase();
  for (const entry of Object.values(ROGUELIKE_THEMES)) {
    if (entry.theme.toLowerCase() === clean) return entry.theme;
    if (entry.aliases.some((a) => clean.includes(a.toLowerCase()))) return entry.theme;
  }
  return 'BlackFlow';
}

/** 读取指定主题的战略秘籍（干员抓位优先级与核心藏品） */
export function loadRoguelikeStrategyInfo(theme: RoguelikeTheme, resourceDir?: string): RoguelikeStrategyInfo | null {
  const maaDir = resourceDir || 'D:/soft/MAA-v6/resource';
  const themeDir = join(maaDir, 'roguelike', theme);
  if (!existsSync(themeDir)) return null;

  const entry = Object.values(ROGUELIKE_THEMES).find((t) => t.theme === theme);
  const themeLabel = entry?.label || theme;
  const popularSquads = entry?.squads || ['指挥分队', '突击战术分队'];
  const popularRoles = entry?.roles || ['先手必胜', '取长补短', '随心所欲'];

  const priorityGroups: RoguelikeStrategyGroup[] = [];
  const defaultKeyOperators: string[] = [];

  // 1. 读取 recruitment.json
  const recruitFile = join(themeDir, 'recruitment.json');
  if (existsSync(recruitFile)) {
    try {
      const data = JSON.parse(readFileSync(recruitFile, 'utf8')) as { priority?: RoguelikeStrategyGroup[] };
      if (Array.isArray(data.priority)) {
        for (const g of data.priority) {
          priorityGroups.push(g);
          for (const op of g.opers) {
            if (op.is_key || op.is_start || (op.recruit_priority && op.recruit_priority >= 900)) {
              if (!defaultKeyOperators.includes(op.name)) {
                defaultKeyOperators.push(op.name);
              }
            }
          }
        }
      }
    } catch {}
  }

  // 2. 读取 shopping.json (核心藏品)
  const topRelics: Array<{ name: string; effect?: string }> = [];
  const shopFile = join(themeDir, 'shopping.json');
  if (existsSync(shopFile)) {
    try {
      const data = JSON.parse(readFileSync(shopFile, 'utf8')) as { priority?: Array<{ name: string; effect?: string }> };
      if (Array.isArray(data.priority)) {
        for (const item of data.priority.slice(0, 10)) {
          topRelics.push({ name: item.name, effect: item.effect });
        }
      }
    } catch {}
  }

  return {
    theme,
    themeLabel,
    defaultKeyOperators,
    priorityGroups,
    topRelics,
    popularSquads,
    popularRoles,
  };
}

/** 格式化战略秘籍文本以供大模型与博士战前讨论 */
export function formatRoguelikeStrategyText(info: RoguelikeStrategyInfo): string {
  const keyOpsText = info.defaultKeyOperators.length > 0
    ? info.defaultKeyOperators.slice(0, 12).join('、')
    : '机械师、维什戴尔';

  const relicsText = info.topRelics.length > 0
    ? info.topRelics.slice(0, 8).map((r) => `  * 「${r.name}」: ${r.effect || '战略核心'}`).join('\n')
    : '  * 暂无关键藏品数据';

  const groupsText = info.priorityGroups.slice(0, 5).map((g) => {
    const ops = g.opers.slice(0, 4).map((o) => `${o.name}${o.is_key ? '★' : ''}`).join('、');
    return `  * 【${g.name}分组】: ${ops}`;
  }).join('\n');

  const squadsText = info.popularSquads.slice(0, 6).join('、');
  const rolesText = info.popularRoles.slice(0, 4).join('、');

  return `【集成战略战略秘籍】主题：${info.themeLabel} (${info.theme})\n`
    + `- 核心推荐首发干员：${keyOpsText}\n`
    + `- 推荐开局分队选项：${squadsText}\n`
    + `- 推荐职业招募组合：${rolesText}\n`
    + `- 抓位优先级分组精选：\n${groupsText}\n`
    + `- 商店最高价值藏品推荐：\n${relicsText}\n\n`
    + `博士，开打前你可以向我提出偏好的干员；确认后即可调用 ark_run_roguelike 启动全权托管！`;
}
