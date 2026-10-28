/**
 * 代号 → pipeline 入口 + override。
 *
 * 这里是「选哪条路线」的全部逻辑：pipeline 只认哨兵文本，路由负责把它换成真实代号；
 * 忘记传 override 时哨兵匹配失败，不会误点。
 */
import { chapterKeywords, chapterLabel } from './chapters.ts';
import { sideActivityOf, supportedSideActivities, type Roi } from './side-activities.ts';
import { supportedThemes, themeKeywords } from './roguelike-themes.ts';
import {
  isChipStage,
  isMainStage,
  isResourceStage,
  isSideStage,
  mainChapterOf,
  normalizeStageCode,
  stagePattern,
} from './stage-code.ts';

export interface NavRoute {
  readonly entry: string;
  readonly label: string;
  readonly overrides: Record<string, unknown>;
  /** 成功标准：到编队页，或到集成战略主题页。 */
  readonly stopAt: 'formation' | 'theme';
}

export type RouteResult = { readonly ok: true; readonly route: NavRoute } | { readonly ok: false; readonly error: string };

export interface RouteOptions {
  /** 覆盖 pipeline 里滚动节点的 `max_hit`；不传则用 JSON 里的默认值。 */
  readonly maxScrolls?: number;
}

/** 资源本 5 级与 6 级在列表里的位置不同（MAA 实测 ROI），不能共用一个窄框。 */
const RESOURCE_ROI_5: Roi = [820, 120, 320, 260];
const RESOURCE_ROI_6: Roi = [900, 80, 340, 200];
/** 芯片本两级各有一套 ROI。 */
const CHIP_ROI_1: Roi = [27, 260, 742, 400];
const CHIP_ROI_2: Roi = [472, 0, 793, 502];
/** 主线地图上关卡名所在的那条窄带，放宽一点容忍 PC 端字号差异。 */
const MAIN_STAGE_ROI: Roi = [0, 140, 1080, 380];

function addScroll(
  overrides: Record<string, unknown>,
  node: string,
  options?: RouteOptions,
): Record<string, unknown> {
  if (options?.maxScrolls === undefined) return overrides;
  overrides[node] = {
    ...(typeof overrides[node] === 'object' && overrides[node] !== null ? overrides[node] as object : {}),
    max_hit: options.maxScrolls,
  };
  return overrides;
}

function route(
  entry: string,
  label: string,
  overrides: Record<string, unknown>,
  stopAt: NavRoute['stopAt'],
): RouteResult {
  return { ok: true, route: { entry, label, overrides, stopAt } };
}

/** 关卡代号 → 路线；不认识就返回可读错误，调用方一次点击都不发。 */
export function routeFor(stageCode: string, options?: RouteOptions): RouteResult {
  const code = normalizeStageCode(stageCode);
  if (code === '') {
    return { ok: false, error: '关卡代号是空的：像是「1-7」「CE-5」「AD-8」这样写。' };
  }

  if (isResourceStage(code)) {
    const level = Number(code.split('-')[1]);
    const roi = level >= 6 ? RESOURCE_ROI_6 : RESOURCE_ROI_5;
    const overrides: Record<string, unknown> = {
      'NavResource@FindStage': { expected: stagePattern(code), roi: [...roi] },
    };
    addScroll(overrides, 'NavResource@Scroll', options);
    return route('NavResource@Begin', `资源本 ${code}`, overrides, 'formation');
  }

  if (isChipStage(code)) {
    const level = code.endsWith('-1') ? 1 : 2;
    const roi = level === 1 ? CHIP_ROI_1 : CHIP_ROI_2;
    const overrides: Record<string, unknown> = {
      'NavChip@FindStage': { expected: stagePattern(code), roi: [...roi] },
    };
    addScroll(overrides, 'NavChip@Scroll', options);
    return route('NavChip@Begin', `芯片本 ${code}`, overrides, 'formation');
  }

  if (isMainStage(code)) {
    const chapter = mainChapterOf(code);
    if (chapter === null) return { ok: false, error: `主线代号读不出章节：${stageCode}` };
    const keywords = chapterKeywords(chapter);
    const overrides: Record<string, unknown> = {
      'NavMain@Chapter': { expected: [...keywords] },
      'NavMain@FindStage': { expected: stagePattern(code), roi: [...MAIN_STAGE_ROI] },
    };
    addScroll(overrides, 'NavMain@ScrollStage', options);
    return route('NavMain@Begin', `主线 ${code}（${chapterLabel(chapter)}）`, overrides, 'formation');
  }

  if (isSideStage(code)) {
    const activity = sideActivityOf(code);
    if (!activity) {
      return {
        ok: false,
        error: `还没支持这个活动关卡：${code}。当前支持的活动：${supportedSideActivities().join('、') || '（无）'}；`
          + '新增活动需要在 src/nav/side-activities.ts 里补一行入口关键词与 ROI。',
      };
    }
    const overrides: Record<string, unknown> = {
      'NavSide@EnterTab': { expected: activity.tab },
      'NavSide@FindActivity': { expected: [...activity.keywords] },
      'NavSide@Start': { roi: [...activity.startRoi] },
      'NavSide@FindStage': { expected: stagePattern(code), roi: [...activity.stageRoi] },
    };
    addScroll(overrides, 'NavSide@ScrollActivities', options);
    addScroll(overrides, 'NavSide@ScrollStage', options);
    return route('NavSide@Begin', `活动 ${code}`, overrides, 'formation');
  }

  return {
    ok: false,
    error: `不认识的关卡代号：${stageCode}。目前支持主线（1-7）、资源本（CE-5 / LS-5 / CA-5 / AP-5 / SK-5）、`
      + `芯片本（PR-A-1 等）与已收录的 SideStory（${supportedSideActivities().join('、') || '（无）'}）。`,
  };
}

/** 集成战略：只到指定主题主页，不点「开始探索」。 */
export function roguelikeRoute(theme: string, options?: RouteOptions): RouteResult {
  const keywords = themeKeywords(theme);
  if (!keywords) {
    return {
      ok: false,
      error: `不认识这个集成战略主题：${theme}。目前支持：${supportedThemes().join('、')}。`,
    };
  }
  const overrides: Record<string, unknown> = {
    'NavRoguelike@FindTheme': { expected: [...keywords] },
  };
  addScroll(overrides, 'NavRoguelike@ScrollTheme', options);
  return route('NavRoguelike@Begin', `集成战略 ${theme}`, overrides, 'theme');
}
