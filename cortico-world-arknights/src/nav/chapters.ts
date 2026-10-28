/**
 * 主线章节页签的显示名与 OCR 匹配关键词。
 *
 * 现版明日方舟主线已整合为篇章制：
 * - 序章与第 1 章：觉醒篇 · 黑暗时代 PART.1 / PART.2
 * - 第 2 章与第 3 章：觉醒篇 · 异卵同生 / 二次呼吸
 * - 第 4~8 章：残阳篇
 *
 * 来源：MaaAssistantArknights tasks.json 实测与现行 PC 客户端卡片名称（快照 2026-10）。
 */
export const MAIN_CHAPTERS: Readonly<Record<number, string>> = {
  0: '觉醒',
  1: '觉醒',
  2: '异卵同生',
  3: '异卵同生',
  4: '残阳',
  5: '残阳',
  6: '残阳',
  7: '残阳',
  8: '残阳',
};

export function chapterLabel(chapter: number): string {
  return MAIN_CHAPTERS[chapter] ?? `第${chapter}章`;
}

/**
 * 给 MaaFramework OCR 的章节卡片匹配关键词列表。
 *
 * 支持多关键词匹配（OR 逻辑），同时容忍部分客户端字号或繁简异体，
 * 优先匹配具体卡片名（如「异卵同生」），次选篇章名（如「觉醒」）与代号。
 */
export function chapterKeywords(chapter: number): string[] {
  switch (chapter) {
    case 0:
    case 1:
      return ['黑暗时代', '觉醒', 'EPISODE 01', 'EP01', '第1章'];
    case 2:
      return ['异卵同生', '黑暗时代', '觉醒', 'EPISODE 02', 'EP02', '第2章'];
    case 3:
      return ['异卵同生', '二次呼吸', '觉醒', 'EPISODE 03', 'EP03', '第3章'];
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
      return ['残阳', `第${chapter}章`, `EPISODE 0${chapter}`];
    default:
      return [`第${chapter}章`, `EPISODE ${chapter}`];
  }
}
