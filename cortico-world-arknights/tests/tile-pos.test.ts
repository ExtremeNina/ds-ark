import { describe, expect, it } from 'vitest';
import { getStageDimension, loadStageMapInfo, tileToScreen } from '../src/battle/tile-pos.ts';

describe('tile-pos 地块换算', () => {
  it('正确获取已知内置关卡尺寸', () => {
    const dim17 = getStageDimension('1-7');
    expect(dim17).toEqual({ width: 11, height: 7 });

    const dim210 = getStageDimension('2-10');
    expect(dim210).toEqual({ width: 11, height: 8 });

    const unknown = getStageDimension('unknown-stage');
    expect(unknown).toEqual({ width: 11, height: 8 });
  });

  it('能成功解析 1-7 的静态地图地块与高低台分布', () => {
    const mapInfo = loadStageMapInfo('1-7', 'D:/soft/MAA-v6/resource');
    expect(mapInfo).not.toBeNull();
    expect(mapInfo?.code).toBe('1-7');
    expect(mapInfo?.width).toBe(11);
    expect(mapInfo?.height).toBe(7);

    // 验证高台与地面列表包含预期的点位
    expect(mapInfo?.meleeTiles.length).toBeGreaterThan(0);
    expect(mapInfo?.rangedTiles.length).toBeGreaterThan(0);
    // [3, 2] 应在地面列表中
    const hasRoadAt32 = mapInfo?.meleeTiles.some(([c, r]) => c === 3 && r === 2);
    expect(hasRoadAt32).toBe(true);
    // [1, 1] 应在高台列表中
    const hasWallAt11 = mapInfo?.rangedTiles.some(([c, r]) => c === 1 && r === 1);
    expect(hasWallAt11).toBe(true);

    // 验证 ASCII 战术缩略图
    expect(mapInfo?.asciiGrid).toContain('R01:');
    expect(mapInfo?.asciiGrid).toContain(' M');
    expect(mapInfo?.asciiGrid).toContain(' R');
  });

  it('网格坐标正确映射到屏幕有效区域', () => {
    const dim = { width: 10, height: 10 };
    const center = tileToScreen([5, 5], dim);

    // 屏幕中央 (0.5, 0.5 附近)
    expect(center.x).toBeGreaterThan(0.45);
    expect(center.x).toBeLessThan(0.60);
    expect(center.y).toBeGreaterThan(0.45);
    expect(center.y).toBeLessThan(0.60);
  });

  it('边界网格 [0, 0] 与 [width, height] 映射到合法区间', () => {
    const dim = { width: 10, height: 10 };
    const topLeft = tileToScreen([0, 0], dim);
    const bottomRight = tileToScreen([10, 10], dim);

    expect(topLeft.x).toBeGreaterThanOrEqual(0.16);
    expect(topLeft.y).toBeGreaterThanOrEqual(0.16);
    expect(bottomRight.x).toBeLessThanOrEqual(0.84);
    expect(bottomRight.y).toBeLessThanOrEqual(0.76);
  });

  it('支持直接传入归一化对象', () => {
    const custom = tileToScreen({ x: 0.55, y: 0.65 }, { width: 10, height: 10 });
    expect(custom).toEqual({ x: 0.55, y: 0.65 });
  });
});
