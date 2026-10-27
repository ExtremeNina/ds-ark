/**
 * 战场界面区域：把一帧切成几个「读数区」，好让识别结果按位置归类。
 *
 * 坐标全部是相对整帧的 0~1 比例（与截图缩放无关），数值来自 1280×720 真机帧的目测：
 * - 顶部条：左侧「剩余敌人 0/11」，右侧「生命值 20」，都在画面上沿 10% 以内；
 * - 中央横幅：暂停时出现「PAUSE / ----暂停中----」，纵向落在画面中段；
 * - 费用：右下角菱形图标旁的数字，紧贴屏幕右缘；
 * - 手牌：底部一排卡面的费用数字，卡费中心实测 y≈0.85，占最下面约 17%。
 *
 * 这些是**宽区间**，宁可多框一点也不漏；误框进来的文字由 `state.ts` 用「纯数字 / a/b 形状」
 * 过滤掉。真机标定后如果发现某项一直读不到，改这里的区间即可（冒烟脚本会打印每行落在哪一区）。
 */

export interface NormalizedBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 区域名：`top` 是顶部条（敌人与生命都在里面，按文字形状再分）。 */
export type RegionName = 'banner' | 'top' | 'cost' | 'hand' | 'unknown';

interface Band {
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
}

export const BATTLE_REGIONS: Record<Exclude<RegionName, 'unknown'>, Band> = {
  banner: { x: [0.25, 0.75], y: [0.30, 0.60] },
  top: { x: [0.25, 0.72], y: [0, 0.10] },
  // 卡费数字的中心 y 实测：16:9 帧 0.848~0.849，1.71:1 帧 0.852~0.863，所以取 [0.83, 0.875]：
  // 下界与 cost 带（≤0.82）留 0.01 空档，上界挡住卡面下沿那个会被读成数字的图案（中心 ≥0.886）。
  hand: { x: [0, 1], y: [0.83, 0.875] },
  // 右下角那块：屏幕右缘、手牌区之上。DP 中心实测 y≈0.72、「剩余可放置角色」≈0.78，
  // 上限收到 0.82，与 hand 的 0.83 之间留 0.01 空档；宽度靠「纯数字」过滤兜底。
  cost: { x: [0.85, 1], y: [0.55, 0.82] },
};

function inBand(center: { x: number; y: number }, band: Band): boolean {
  return center.x >= band.x[0] && center.x <= band.x[1] && center.y >= band.y[0] && center.y <= band.y[1];
}

/**
 * 判断一个文本框落在哪个区域。
 * 顺序是固定的：横幅 → 顶部条 → 手牌 → 费用。手牌排在费用前面，
 * 否则最右一张卡的费用数字会同时落在「右缘」里，被误当成部署费用。
 */
export function regionOf(box: NormalizedBox): RegionName {
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  if (inBand(center, BATTLE_REGIONS.banner)) return 'banner';
  if (inBand(center, BATTLE_REGIONS.top)) return 'top';
  if (inBand(center, BATTLE_REGIONS.hand)) return 'hand';
  if (inBand(center, BATTLE_REGIONS.cost)) return 'cost';
  return 'unknown';
}
