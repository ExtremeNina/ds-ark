/**
 * 战场状态解析：把 OCR 文字行按区域折成结构化字段。
 *
 * 只做几何归类与数字清洗，不做任何推断：读不到就是 `null`，绝不用 0 或「未暂停」冒充结果。
 * 数字清洗含一次受限的字符纠错（`O/o→0`、`I/l/|→1`），只在纯数字语境生效——否则 `PAUSE`
 * 会被改成 `PA0SE`，暂停横幅就认不出来了。
 * 暂停态是三态——`true` 表示认到了横幅，`null` 表示没认到（**不等于**没暂停）。
 */
import type { OcrLine } from '../mfw/ocr.ts';
import { regionOf } from './regions.ts';

export interface BattleState {
  readonly cost: number | null;
  readonly life: number | null;
  readonly enemies: string | null;
  /** 只表示「认到/没认到暂停横幅」，没认到不等于未暂停。 */
  readonly paused: boolean | null;
  readonly handCosts: ReadonlyArray<{ readonly cost: number; readonly x: number }>;
}

/** 纯数字（允许中间有空格，OCR 常把三位数拆成「1 2」）。 */
const INTEGER = /^\d+$/;
/** 「0/11」这种剩余敌人形状。 */
const RATIO = /^(\d+)\/(\d+)$/;
/** 暂停横幅上的字：PAUSE 可能被认成 PAUS/PAUSF，中文则是「暂停中」。 */
const PAUSE_BANNER = /paus|暂停/i;
/** 只含数字与常见误识字符：0↔O/o、1↔I/l/|，外加分隔用的斜杠。 */
const DIGIT_LIKE = /^[0-9OoIl|/]+$/;
/** 手牌卡费：最多两个非数字前缀（卡面图标被认成字母，如 `N16`），后面接 1~2 位数字。 */
const CARD_COST = /^[^\d]{0,2}(\d{1,2})$/;
/** 三位数的情形：邻卡粘连（`118` = 邻卡的 1 + 18，`167` = 16 + 邻卡的 7）。 */
const CARD_COST_BLEED = /^[^\d]{0,2}(\d{3})$/;
/** 干员部署费用的上限：6★ 实测最高 34~36，留一点余量；不存在三位数的卡费。 */
const CARD_COST_MAX = 40;

function squeeze(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 数字语境归一化：只在「整串都是数字或易混字符、且至少有一个真数字」时，
 * 把 `O/o` 换成 `0`、`I/l/|` 换成 `1`；否则返回 null。
 *
 * 必须限定语境：`PAUSE` 里也有 O，全局替换会变成 `PA0SE`，暂停横幅就认不出来了。
 */
function digitsOnly(text: string): string | null {
  const value = squeeze(text);
  if (!DIGIT_LIKE.test(value) || !/\d/.test(value)) return null;
  return value.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
}

function toNumber(text: string): number | null {
  const value = digitsOnly(text);
  return value !== null && INTEGER.test(value) ? Number(value) : null;
}

/**
 * 手牌卡费：允许图标被认成字母的前缀，取末尾的数字。
 *
 * 三位数是「邻卡粘连」的产物（`118` = 邻卡的 1 + 18，`167` = 16 + 邻卡的 7）。
 * 卡费上限是 40，所以先试去掉首位（左侧邻卡和卡框更容易并进来），不合法再去掉末位；
 * 两个候选都超限、或位数更多时仍然丢弃，不猜。
 */
function toCardCost(text: string): number | null {
  const value = digitsOnly(text) ?? squeeze(text);
  const strict = CARD_COST.exec(value);
  if (strict) return Number(strict[1]);

  const bleed = CARD_COST_BLEED.exec(value);
  if (!bleed) return null;
  const digits = bleed[1]!;
  const droppedFirst = Number(digits.slice(1));
  if (droppedFirst <= CARD_COST_MAX) return droppedFirst;
  const droppedLast = Number(digits.slice(0, 2));
  return droppedLast <= CARD_COST_MAX ? droppedLast : null;
}

/** 手牌候选：除费用外还留着中心 y，用来判断它是不是和别的卡费在同一排。 */
interface HandCandidate {
  readonly cost: number;
  readonly x: number;
  readonly y: number;
}

/** 同一排卡费的中心 y 离散只有 0.01 上下；偏出这个范围的，多半是卡面上别的图案。 */
const HAND_ROW_TOLERANCE = 0.02;
/** 少于三项就不聚类：两个点分不清哪一排是真的。 */
const HAND_ROW_MIN_SAMPLES = 3;

/**
 * 丢掉不在卡费那一排的候选。
 *
 * 卡面下半部分还有别的图案，被识别成数字时能通过 `toCardCost`（比如「4」），
 * 单靠区间收边容易在 UI 微调后再漏一次，所以按 y 的中位数再筛一道。
 */
function keepHandRow(cards: readonly HandCandidate[]): HandCandidate[] {
  if (cards.length < HAND_ROW_MIN_SAMPLES) return [...cards];
  const ys = cards.map((card) => card.y).sort((a, b) => a - b);
  const median = ys[Math.floor(ys.length / 2)]!;
  return cards.filter((card) => Math.abs(card.y - median) <= HAND_ROW_TOLERANCE);
}

/** 同一张卡被整帧与手牌条各读到一次时，两个框的 x 中心只差几个像素。 */
const HAND_DUPLICATE_X = 0.015;

/**
 * 归并两路结果：按 x 排序后丢掉挨得太近的重复项。
 *
 * 排序是稳定的，所以同一位置先出现的那条（整帧那一路）胜出；手牌条只补整帧没读到的位置。
 */
function dedupeByX(cards: readonly HandCandidate[]): HandCandidate[] {
  const sorted = [...cards].sort((a, b) => a.x - b.x);
  const unique: HandCandidate[] = [];
  for (const card of sorted) {
    const last = unique.at(-1);
    if (last && card.x - last.x < HAND_DUPLICATE_X) continue;
    unique.push(card);
  }
  return unique;
}

/** 把识别行折成战场状态；同一位置出现多次时取第一个认到的值。 */
export function parseBattleState(lines: readonly OcrLine[]): BattleState {
  let cost: number | null = null;
  let life: number | null = null;
  let enemies: string | null = null;
  let paused: boolean | null = null;
  const handCandidates: HandCandidate[] = [];

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;

    switch (regionOf(line.box)) {
      case 'banner':
        if (PAUSE_BANNER.test(text)) paused = true;
        break;
      case 'top': {
        const ratio = RATIO.exec(digitsOnly(text) ?? '');
        if (ratio) {
          enemies ??= `${ratio[1]}/${ratio[2]}`;
        } else {
          life ??= toNumber(text);
        }
        break;
      }
      case 'hand': {
        const value = toCardCost(text);
        if (value !== null) {
          handCandidates.push({
            cost: value,
            x: line.box.x + line.box.w / 2,
            y: line.box.y + line.box.h / 2,
          });
        }
        break;
      }
      case 'cost':
        cost ??= toNumber(text);
        break;
      default:
        // 画面里其它文字（关卡名、提示语）与状态无关，直接丢掉。
        break;
    }
  }

  const handCosts = dedupeByX(keepHandRow(handCandidates))
    .map(({ cost: value, x }) => ({ cost: value, x }));
  return { cost, life, enemies, paused, handCosts };
}

/** 读不到的项，用中文列出来，供回执如实说明。 */
export function missingFields(state: BattleState): string[] {
  const missing: string[] = [];
  if (state.cost === null) missing.push('费用');
  if (state.life === null) missing.push('生命值');
  if (state.enemies === null) missing.push('剩余敌人');
  if (state.handCosts.length === 0) missing.push('手牌费用');
  return missing;
}

/** 生成给人/模型看的中文摘要；短语替换由调用方追加。 */
export function describeBattleState(state: BattleState): string {
  const known: string[] = [];
  if (state.cost !== null) known.push(`费用 ${state.cost}`);
  if (state.life !== null) known.push(`生命 ${state.life}`);
  if (state.enemies !== null) known.push(`剩余敌人 ${state.enemies}`);
  if (state.handCosts.length > 0) {
    known.push(`手牌费用从左到右 ${state.handCosts.map((card) => card.cost).join(' / ')}`);
  }

  const parts = [known.length > 0 ? `识别到：${known.join('，')}。` : '这一帧没有识别出任何数字。'];
  parts.push(
    state.paused === true
      ? '画面里有暂停横幅（PAUSE / 暂停中）。'
      : '没有识别到暂停横幅，但这不代表游戏没有暂停。',
  );
  const missing = missingFields(state);
  if (missing.length > 0) parts.push(`没读到：${missing.join('、')}。`);
  parts.push('这些数字来自本机 OCR，可能有误，请以附件画面为准。');
  return parts.join('');
}
