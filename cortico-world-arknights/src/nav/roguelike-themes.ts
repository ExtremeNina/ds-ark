/**
 * 集成战略主题的关键词。
 *
 * 只用于「找到并点进指定主题页」，不参与推层；主题页出现「开始探索」即停。
 * 关键词取主题全名里最稳的一段，避免 OCR 把长名读残时整串匹配失败。
 */
export const ROGUELIKE_THEMES: Readonly<Record<string, readonly string[]>> = {
  傀影: ['傀影', '猩红'],
  水月: ['水月', '深蓝'],
  萨米: ['萨米', '银凇', '探索者'],
  萨卡兹: ['萨卡兹', '无终'],
  界园: ['界园', '岁的'],
  黑流: ['黑流'],
};

export function themeKeywords(theme: string): readonly string[] | null {
  const key = theme.trim();
  return ROGUELIKE_THEMES[key] ?? null;
}

export function supportedThemes(): string[] {
  return Object.keys(ROGUELIKE_THEMES);
}
