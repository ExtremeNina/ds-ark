/**
 * SideStory 活动入口参数。
 *
 * 结构是通用的，数据不是：每个活动的入口关键词、「演出开始」按钮位置、关卡地图 ROI
 * 都不一样（MAA 用 47 个 `tasks/Stages/*.json` 各写一份）。这里先收录少量活动，
 * 新增活动只需加一行，并在真机用 `--ocr-all` 核对 ROI。
 *
 * 来源：MaaAssistantArknights resource/tasks/Stages（快照 2026-10）。
 */

export type Roi = readonly [number, number, number, number];

export interface SideActivity {
  /** 代号前缀，例如 `AD`。 */
  readonly code: string;
  /** 活动列表里的 OCR 关键词，命中任一即可。 */
  readonly keywords: readonly string[];
  /** 作战页要点的页签：当前活动 / 别传 / 插曲。 */
  readonly tab: string;
  /** 「演出开始」按钮的 ROI。 */
  readonly startRoi: Roi;
  /** 关卡地图的 OCR ROI。 */
  readonly stageRoi: Roi;
}

export const SIDE_ACTIVITIES: Readonly<Record<string, SideActivity>> = {
  AD: {
    code: 'AD',
    keywords: ['红丝绒', '为戏剧', '为永恒'],
    tab: '别传',
    startRoi: [900, 360, 380, 260],
    stageRoi: [0, 60, 1280, 580],
  },
};

/** 按代号前缀找活动；未知活动返回 `null`，由调用方给出可读错误。 */
export function sideActivityOf(stageCode: string): SideActivity | null {
  const prefix = stageCode.trim().toUpperCase().split('-')[0] ?? '';
  return SIDE_ACTIVITIES[prefix] ?? null;
}

export function supportedSideActivities(): string[] {
  return Object.keys(SIDE_ACTIVITIES);
}
