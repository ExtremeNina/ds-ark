/**
 * 明日方舟干员静态属性数据库：
 * 从 MAA 本地资源 (battle_data.json) 读取干员全量静态属性，
 * 提供干员职业（中英文）、站位类型（地面/高台）、分支类型与稀有度查询。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type OperatorPosition = 'MELEE' | 'RANGED' | 'ALL';

export interface OperatorDetail {
  readonly id: string;
  readonly name: string;
  readonly nameEn?: string;
  /** 职业代码（如 PIONEER, WARRIOR, SNIPER） */
  readonly professionCode: string;
  /** 职业中文名（如 先锋, 近卫, 狙击） */
  readonly profession: string;
  /** 站位类型（MELEE 地面, RANGED 高台, ALL 高低台均可） */
  readonly position: OperatorPosition;
  /** 站位中文描述 */
  readonly positionZh: string;
  /** 子职业/分支标识（如 crusher 重剑手, loopshooter 回环射手） */
  readonly subProfessionId?: string;
  /** 稀有度（星级，1~6） */
  readonly rarity: number;
}

const PROFESSION_ZH_MAP: Record<string, string> = {
  PIONEER: '先锋',
  WARRIOR: '近卫',
  SNIPER: '狙击',
  TANK: '重装',
  MEDIC: '医疗',
  SUPPORT: '辅助',
  CASTER: '术师',
  SPECIAL: '特种',
};

const POSITION_ZH_MAP: Record<OperatorPosition, string> = {
  MELEE: '地面',
  RANGED: '高台',
  ALL: '高低台均可',
};

interface RawBattleDataChar {
  name: string;
  name_en?: string;
  position?: string;
  profession?: string;
  subProfessionId?: string;
  rarity?: number;
}

interface RawBattleData {
  chars?: Record<string, RawBattleDataChar>;
}

export class OperatorDatabase {
  private static instance: OperatorDatabase | null = null;
  private readonly operatorsByName = new Map<string, OperatorDetail>();
  private loaded = false;

  public static getInstance(resourceDir?: string): OperatorDatabase {
    if (!OperatorDatabase.instance) {
      OperatorDatabase.instance = new OperatorDatabase();
      OperatorDatabase.instance.load(resourceDir);
    } else if (!OperatorDatabase.instance.loaded && resourceDir) {
      OperatorDatabase.instance.load(resourceDir);
    }
    return OperatorDatabase.instance;
  }

  /** 测试时允许重置单例 */
  public static resetInstance(): void {
    OperatorDatabase.instance = null;
  }

  public load(resourceDir?: string): boolean {
    const candidates: string[] = [];
    if (resourceDir) {
      candidates.push(join(resourceDir, 'battle_data.json'));
    }
    candidates.push(
      'D:/soft/MAA-v6/resource/battle_data.json',
      join(process.cwd(), 'assets/resource/battle_data.json'),
      join(process.cwd(), 'resource/battle_data.json'),
    );

    for (const filePath of candidates) {
      if (existsSync(filePath)) {
        try {
          const raw = readFileSync(filePath, 'utf8');
          const data = JSON.parse(raw) as RawBattleData;
          if (data.chars && typeof data.chars === 'object') {
            for (const [id, c] of Object.entries(data.chars)) {
              if (!c.name) continue;
              const posRaw = (c.position || 'MELEE').toUpperCase() as OperatorPosition;
              const pos = posRaw === 'RANGED' ? 'RANGED' : posRaw === 'ALL' ? 'ALL' : 'MELEE';
              const profCode = (c.profession || '').toUpperCase();
              const profZh = PROFESSION_ZH_MAP[profCode] || profCode || '未知';
              const detail: OperatorDetail = {
                id,
                name: c.name.trim(),
                nameEn: c.name_en,
                professionCode: profCode,
                profession: profZh,
                position: pos,
                positionZh: POSITION_ZH_MAP[pos] || '地面',
                subProfessionId: c.subProfessionId,
                rarity: typeof c.rarity === 'number' ? c.rarity : 5,
              };
              this.operatorsByName.set(detail.name.toLowerCase(), detail);
            }
            this.loaded = true;
            return true;
          }
        } catch {
          // 继续尝试下一个候选路径
        }
      }
    }

    return false;
  }

  public getOperator(name: string): OperatorDetail | null {
    if (!name) return null;
    const clean = name.trim().toLowerCase();
    // 1. 精确匹配
    if (this.operatorsByName.has(clean)) {
      return this.operatorsByName.get(clean)!;
    }
    // 2. 去除后缀或前缀的异格模糊匹配
    for (const [opName, detail] of this.operatorsByName.entries()) {
      if (clean.includes(opName) || opName.includes(clean)) {
        return detail;
      }
    }
    return null;
  }

  public get size(): number {
    return this.operatorsByName.size;
  }
}
