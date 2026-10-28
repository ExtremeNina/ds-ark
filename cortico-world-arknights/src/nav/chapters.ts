/**
 * 主线章节页签的显示名。
 *
 * 前三章沿用 MAA 资源里实测的页签文字（`ClickChapter1/2/3`），其余章节在旧版本里可能
 * 是「第N章」，也可能随 UI 改版变化；未知章节退回「第N章」，让真机 OCR 决定命不命得中。
 * 来源：MaaAssistantArknights resource/tasks/tasks.json（快照 2026-10）。
 */
export const MAIN_CHAPTERS: Readonly<Record<number, string>> = {
  1: '觉醒',
  2: '幻灭',
  3: '残阳',
};

export function chapterLabel(chapter: number): string {
  return MAIN_CHAPTERS[chapter] ?? `第${chapter}章`;
}
