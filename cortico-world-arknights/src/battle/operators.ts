/**
 * 干员识别与名册匹配模块。
 *
 * 结合本地 OCR 结果，将编队页、干员选择列表或手牌中的文字框过滤、对齐到标准干员名，
 * 并计算其在当前帧中的归一化中心坐标（0~1），供大模型认知编队或直接调用 ark_click 点选。
 */
import type { OcrLine } from '../mfw/ocr.ts';

/**
 * 明日方舟标准干员名称库（包含 1~6 星核心干员与名册干员）。
 * 来源：MaaAssistantArknights 资源与公招/基建配置。
 */
export const OPERATOR_NAMES: readonly string[] = [
  // 6星核心干员
  '能天使', '推进之王', '伊芙利特', '艾雅法拉', '安洁莉娜', '闪灵', '夜莺', '星熊', '塞雷娅', '银灰',
  '斯卡蒂', '陈', '黑', '赫拉格', '麦哲伦', '莫斯提马', '煌', '阿', '刻俄柏', '风笛',
  '傀影', '温蒂', '早露', '铃兰', '棘刺', '森蚺', '史尔特尔', '瑕光', '泥岩', '山',
  '空弦', '嵯峨', '异客', '凯尔希', '卡涅利安', '帕拉斯', '水月', '琴柳', '远牙', '焰尾',
  '灵知', '令', '澄闪', '菲亚梅塔', '号角', '归溟幽灵鲨', '黑键', '多萝西', '百炼嘉维尔', '玛恩纳',
  '白铁', '斥罪', '缄默德克萨斯', '焰影苇草', '重岳', '仇白', '仇白', '伊内丝', '霍尔海雅', '缪尔赛思',
  '圣约送葬人', '提丰', '纯烬艾雅法拉', '琳琅诗怀雅', '涤火杰西卡', '止颂', '薇薇安娜', '塑心', '锏', '莱伊',
  '左乐', '黍', '阿斯卡纶', '魔王', 'logos', 'Logos', '维什戴尔', '乌尔比安', '佩佩', '娜斯提',
  // 5星主力与常用干员
  '白面鸮', '凛冬', '德克萨斯', '红', '雷蛇', '临光', '赫默', '华法琳', '初雪', '天火',
  '梅尔', '崖心', '幽灵鲨', '蓝毒', '白金', '陨星', '普罗旺斯', '拉普兰德', '芙兰卡', '因陀罗',
  '爱丽丝', '狮蝎', '空', '真理', '极境', '贾维', '布洛卡', '苇草', '慑砂', '槐琥',
  '送葬人', '星极', '格劳克斯', '诗怀雅', '夜魔', '月见夜', '巫恋', '极境', '断崖', '安哲拉',
  '燧石', '四月', '奥斯塔', '卡达', '罗宾', '卡夫卡', '爱丽丝', '熔泉', '赤冬', '羽毛笔',
  '桑葚', '蜜蜡', '蜜莓', '夏栎', '洛洛', '海蒂', '风丸', '濯尘芙蓉', '埃拉托', '承曦格雷伊',
  '明椒', '截云', '洋灰', '火哨', '铎铃', '休谟斯', '寒檀', '杏仁', '导灯', '烈夏',
  // 4星基石干员
  '桃金娘', '红豆', '讯使', '清道夫', '白雪', '流星', '杰西卡', '远山', '夜烟', '梅',
  '苏苏洛', '末药', '嘉维尔', '调香师', '蛇屠箱', '古米', '角峰', '角峰', '暗索', '阿消',
  '地灵', '深海色', '霜叶', '缠丸', '杜宾', '猎蜂', '慕斯', '艾丝黛尔', '刻刀', '波登可',
  '孑', '酸糖', '芳汀', '卡达', '泡泡', '杰克', '豆苗', '罗比菈塔', '铅踝', '休谟斯',
  // 1~3星基础干员
  '芬', '香草', '翎羽', '玫兰莎', '米格鲁', '克洛丝', '炎熔', '芙蓉', '安赛尔', '史都华德',
  '梓兰', '空爆', '月见夜', '泡普卡', '斑点', '夜刀', '黑角', '巡林者', '杜林', '12F',
  'Lancet-2', 'Castle-3', 'THRM-EX', '正义骑士号', 'Friston-3', 'PhonoR-0',
];

const OPERATOR_SET: ReadonlySet<string> = new Set(OPERATOR_NAMES.map((n) => n.toLowerCase()));

/** 常见的 UI 杂字，防止把按钮当作干员名字 */
const EXCLUDED_KEYWORDS = new Set([
  '编队中', '等级', '精英', '技能', '潜能', '干员', '信赖', '助战', '未选择', '开始行动', '代理指挥', '返回',
]);

export interface OperatorMatch {
  readonly name: string;
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** 归一化中心点 (0~1) */
  readonly center: { readonly x: number; readonly y: number };
}

/** 清洗 OCR 文本并与干员白名单匹配 */
export function matchOperatorName(text: string): string | null {
  const clean = text.replace(/[\s\-_—·.,:;!?()[\]【】「」]/g, '');
  if (clean.length < 1 || EXCLUDED_KEYWORDS.has(clean)) return null;

  // 1. 完全相等匹配
  const lower = clean.toLowerCase();
  for (const name of OPERATOR_NAMES) {
    if (name.toLowerCase() === lower) return name;
  }

  // 2. 包含匹配（干员名至少 2 个字，避免单字误报）
  for (const name of OPERATOR_NAMES) {
    if (name.length >= 2 && clean.includes(name)) {
      return name;
    }
  }

  return null;
}

/**
 * 从当前帧的全部 OCR 行中提炼可见干员列表。
 *
 * 自动排除杂字，按从左到右 (center.x) 排序，同一干员邻近重复项自动归并。
 */
export function parseVisibleOperators(lines: readonly OcrLine[]): OperatorMatch[] {
  const rawMatches: OperatorMatch[] = [];

  for (const line of lines) {
    const matched = matchOperatorName(line.text);
    if (!matched) continue;

    const center = {
      x: Number((line.box.x + line.box.w / 2).toFixed(3)),
      y: Number((line.box.y + line.box.h / 2).toFixed(3)),
    };
    rawMatches.push({
      name: matched,
      box: line.box,
      center,
    });
  }

  // 空间去重：同一个干员如果因为双行识别导致两次命中且距离极近 (dx < 0.05, dy < 0.05)，只保留一个
  const deduped: OperatorMatch[] = [];
  for (const item of rawMatches) {
    const exists = deduped.some(
      (d) => d.name === item.name && Math.abs(d.center.x - item.center.x) < 0.05 && Math.abs(d.center.y - item.center.y) < 0.05,
    );
    if (!exists) {
      deduped.push(item);
    }
  }

  // 按横向位置从左到右排序（与编队 1~12 号位及卡片列表排版一致）
  return deduped.sort((a, b) => a.center.x - b.center.x);
}

/** 查找指定名字的干员（支持模糊搜索） */
export function findOperatorByName(lines: readonly OcrLine[], targetName: string): OperatorMatch | null {
  const all = parseVisibleOperators(lines);
  const target = targetName.trim().toLowerCase();
  if (!target) return null;

  return all.find((item) => item.name.toLowerCase() === target || item.name.includes(targetName)) ?? null;
}
