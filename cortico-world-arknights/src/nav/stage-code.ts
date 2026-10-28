/**
 * 关卡代号归一化与匹配。
 *
 * 只做「形状」层面的清洗，不猜语义：OCR 把 `1-7` 读成 `I-7`、`1—7`、`1 7` 都能救回来，
 * 但 `S1-7`、`11-7`、`1-70` 不会被当成 `1-7`——匹配必须整串相等。
 */

/** 各种破折号/分隔符统一成 `-`。 */
const DASHES = /[－—–−‑_~·。]/g;
/** 全角 ASCII（！到 ～）转半角。 */
const FULL_WIDTH = /[\uFF01-\uFF5E]/g;
/** OCR 常把数字旁的符号读成这些字符。 */
const DIGIT_LIKE = /^[0-9OoIl|]+$/;
/** 代号里允许出现的形状：资源本/主线/芯片本/活动。 */
const MAIN_SHAPE = /^\d+-\d+$/;
const RESOURCE_SHAPE = /^(CE|LS|CA|AP|SK)-\d$/;
const CHIP_SHAPE = /^PR-[A-D]-\d$/;
const SIDE_SHAPE = /^[A-Z]{2,3}-\d+$/;

function halfWidth(text: string): string {
  return text.replace(FULL_WIDTH, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/** 配置/用户输入用的归一化：去空格、统一破折号、转大写。 */
export function normalizeStageCode(raw: string): string {
  return halfWidth(String(raw ?? ''))
    .replace(DASHES, '-')
    .replace(/\s+/g, '')
    .toUpperCase();
}

/** 单个编号段只在该段全是数字或易混字符时纠错，避免把 `LS` 改坏。 */
function normalizeSegment(segment: string): string {
  if (!DIGIT_LIKE.test(segment)) return segment;
  return segment.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
}

/**
 * OCR 文本用的归一化：在配置归一化之外，去掉引号/括号/标点，
 * 并把 `LS5` 补成 `LS-5`（只对字母前缀的代号做，纯数字 `17` 不补）。
 */
export function normalizeOcrCode(text: string): string {
  const cleaned = String(text ?? '').replace(/[「」『』【】[\]()（）:：,，.!?]/g, '');
  // 小写 `l` 在数字段里几乎总是 `1`；先转成 `I`，再由数字段规则统一纠成 `1`。
  // 大写 `L` 不动，避免把 `LS-5` 改坏。
  const base = normalizeStageCode(cleaned.replace(/l/g, 'I'));
  const withDash = /^[A-Z]{2,3}\d+$/.test(base) ? base.replace(/^([A-Z]{2,3})(\d+)$/, '$1-$2') : base;
  return withDash.split('-').filter((part) => part !== '').map(normalizeSegment).join('-');
}

/** 目标代号与 OCR 文本是否同一个关卡。 */
export function sameStage(ocrText: string, stageCode: string): boolean {
  return normalizeOcrCode(ocrText) === normalizeStageCode(stageCode);
}

/**
 * 给 MaaFramework OCR 的 `expected`：允许数字两侧有空格、破折号被读成别的横线，
 * 但锚定首尾，避免 `1-7` 命中 `S1-7`。
 */
export function stagePattern(stageCode: string): string {
  const parts = normalizeStageCode(stageCode).split('-').filter((part) => part !== '');
  const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `^\\s*${escaped.join('\\s*[-—–]\\s*')}\\s*$`;
}

export function isMainStage(code: string): boolean {
  return MAIN_SHAPE.test(normalizeStageCode(code));
}

export function isResourceStage(code: string): boolean {
  return RESOURCE_SHAPE.test(normalizeStageCode(code));
}

export function isChipStage(code: string): boolean {
  return CHIP_SHAPE.test(normalizeStageCode(code));
}

export function isSideStage(code: string): boolean {
  return SIDE_SHAPE.test(normalizeStageCode(code));
}

/** 主线代号的第一段就是章节号；其它代号返回 `null`。 */
export function mainChapterOf(code: string): number | null {
  const normalized = normalizeStageCode(code);
  if (!MAIN_SHAPE.test(normalized)) return null;
  const [chapter] = normalized.split('-');
  const value = Number(chapter);
  return Number.isFinite(value) ? value : null;
}
