/**
 * 战场状态解析：把 OCR 文字行按区域折成结构化字段。
 *
 * 只做几何归类与数字清洗，不做任何推断：读不到就是 `null`，绝不用 0 或「未暂停」冒充结果。
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

function squeeze(text: string): string {
  return text.replace(/\s+/g, '');
}

function toNumber(text: string): number | null {
  const value = squeeze(text);
  return INTEGER.test(value) ? Number(value) : null;
}

/** 把识别行折成战场状态；同一位置出现多次时取第一个认到的值。 */
export function parseBattleState(lines: readonly OcrLine[]): BattleState {
  let cost: number | null = null;
  let life: number | null = null;
  let enemies: string | null = null;
  let paused: boolean | null = null;
  const handCosts: Array<{ cost: number; x: number }> = [];

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;

    switch (regionOf(line.box)) {
      case 'banner':
        if (PAUSE_BANNER.test(text)) paused = true;
        break;
      case 'top': {
        const ratio = RATIO.exec(squeeze(text));
        if (ratio) {
          enemies ??= `${ratio[1]}/${ratio[2]}`;
        } else {
          life ??= toNumber(text);
        }
        break;
      }
      case 'hand': {
        const value = toNumber(text);
        if (value !== null) handCosts.push({ cost: value, x: line.box.x + line.box.w / 2 });
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

  handCosts.sort((a, b) => a.x - b.x);
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
