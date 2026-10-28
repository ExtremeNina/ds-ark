/**
 * 地图地块坐标换算：把 Copilot JSON 中的逻辑网格坐标 [col, row] 转换为归一化屏幕坐标 (0~1)。
 *
 * 明日方舟战斗场景在 16:9 分辨率下，棋盘地块位于画面中央：
 * - 顶部留出状态栏与敌人路线空间
 * - 底部留出手牌卡面区（y > 0.83）
 * - 左右留出战术边缘
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TilePos {
  readonly x: number;
  readonly y: number;
}

export interface MapDimension {
  readonly width: number;
  readonly height: number;
}

/** 常见关卡的内置棋盘尺寸兜底（宽/列数，高/行数） */
export const STAGE_DIMENSIONS: Record<string, MapDimension> = {
  '1-7': { width: 10, height: 7 },
  '2-10': { width: 11, height: 8 },
  '0-1': { width: 9, height: 6 },
  'PR-A-1': { width: 10, height: 7 },
  'PR-B-1': { width: 10, height: 7 },
};

/** 战场棋盘在 16:9 画面中的标准有效边界（归一化坐标） */
export const BATTLE_GRID_BOUNDS = {
  minX: 0.16,
  maxX: 0.84,
  minY: 0.16,
  maxY: 0.76,
} as const;

/**
 * 尝试从 MAA 资源目录读取关卡棋盘尺寸
 */
export function getStageDimension(stageCode: string, resourceDir?: string): MapDimension {
  const normalizedCode = stageCode.trim().toUpperCase();
  if (STAGE_DIMENSIONS[normalizedCode]) {
    return STAGE_DIMENSIONS[normalizedCode]!;
  }

  if (resourceDir) {
    const tilePosDir = join(resourceDir, 'Arknights-Tile-Pos');
    const overviewPath = join(tilePosDir, 'overview.json');
    if (existsSync(overviewPath)) {
      try {
        const raw = readFileSync(overviewPath, 'utf8');
        const overview = JSON.parse(raw) as Record<string, { code: string; width: number; height: number }>;
        for (const entry of Object.values(overview)) {
          if (entry.code.toUpperCase() === normalizedCode && entry.width > 0 && entry.height > 0) {
            return { width: entry.width, height: entry.height };
          }
        }
      } catch {
        // 读取失败时走通用默认兜底
      }
    }
  }

  // 默认中等关卡尺寸
  return { width: 11, height: 8 };
}

/**
 * 把 Copilot 的 [col, row] 转换为归一化屏幕坐标
 * @param location 数组 [col, row]（0-indexed 或 1-indexed），或已归一化的对象 { x, y }
 * @param dimension 地图行列尺寸
 */
export function tileToScreen(
  location: readonly [number, number] | { x: number; y: number },
  dimension: MapDimension,
): TilePos {
  if ('x' in location && 'y' in location) {
    // 已经由模型指定了归一化坐标 (0~1)
    return {
      x: Math.max(0, Math.min(1, location.x)),
      y: Math.max(0, Math.min(1, location.y)),
    };
  }

  let [col, row] = location;
  const { width, height } = dimension;

  // 容错处理：当坐标触及或超过 0-indexed 上限但符合 1-indexed 时（如 col === width），转为 0-indexed
  if ((col >= width || row >= height) && col <= width && row <= height && col >= 1 && row >= 1) {
    col = col - 1;
    row = row - 1;
  }

  // 钳位在合法范围内
  const safeCol = Math.max(0, Math.min(width - 1, col));
  const safeRow = Math.max(0, Math.min(height - 1, row));

  const stepX = (BATTLE_GRID_BOUNDS.maxX - BATTLE_GRID_BOUNDS.minX) / width;
  const stepY = (BATTLE_GRID_BOUNDS.maxY - BATTLE_GRID_BOUNDS.minY) / height;

  const screenX = BATTLE_GRID_BOUNDS.minX + (safeCol + 0.5) * stepX;
  const screenY = BATTLE_GRID_BOUNDS.minY + (safeRow + 0.5) * stepY;

  return {
    x: Number(screenX.toFixed(4)),
    y: Number(screenY.toFixed(4)),
  };
}
