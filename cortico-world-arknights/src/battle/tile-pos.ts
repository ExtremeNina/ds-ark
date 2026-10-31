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

export interface TileRawData {
  readonly buildableType: number; // 0=forbidden, 1=melee(地面), 2=ranged(高台)
  readonly heightType: number;
  readonly isEnd: boolean; // 我方保护点（蓝门）
  readonly isStart: boolean; // 敌方生成点（红门）
  readonly tileKey: string;
}

export interface StageMapInfo {
  readonly code: string;
  readonly name: string;
  readonly stageId: string;
  readonly width: number;
  readonly height: number;
  /** ASCII 纯文本战术地图 */
  readonly asciiGrid: string;
  /** 所有地面地块坐标列表 [col, row]，可部署先锋/近卫/重装 */
  readonly meleeTiles: readonly [number, number][];
  /** 所有高台地块坐标列表 [col, row]，可部署狙击/术师/医疗/辅助 */
  readonly rangedTiles: readonly [number, number][];
  /** 敌方红门出生点 [col, row] */
  readonly startTiles: readonly [number, number][];
  /** 我方蓝门保护点 [col, row] */
  readonly endTiles: readonly [number, number][];
  /** 原始地块二维矩阵 tiles[row][col] */
  readonly tiles: readonly (readonly TileRawData[])[];
}

/** 寻找 Arknights-Tile-Pos 目录候选 */
export function resolveTilePosDir(resourceDir?: string): string | null {
  const candidates: string[] = [];
  if (resourceDir) {
    candidates.push(join(resourceDir, 'Arknights-Tile-Pos'), resourceDir);
  }
  candidates.push(
    'D:/soft/MAA-v6/resource/Arknights-Tile-Pos',
    join(process.cwd(), 'assets/resource/Arknights-Tile-Pos'),
    join(process.cwd(), 'resource/Arknights-Tile-Pos'),
  );

  for (const dir of candidates) {
    if (existsSync(join(dir, 'overview.json'))) {
      return dir;
    }
  }
  return null;
}

interface OverviewEntry {
  code: string;
  name: string;
  stageId: string;
  filename: string;
  width: number;
  height: number;
}

/**
 * 从 MAA 静态资源加载关卡地图网格情报
 */
export function loadStageMapInfo(stageCode: string, resourceDir?: string): StageMapInfo | null {
  const dir = resolveTilePosDir(resourceDir);
  if (!dir) return null;

  const normalizedCode = stageCode.trim().toUpperCase();
  const overviewPath = join(dir, 'overview.json');
  if (!existsSync(overviewPath)) return null;

  try {
    const raw = readFileSync(overviewPath, 'utf8');
    const overview = JSON.parse(raw) as Record<string, OverviewEntry>;

    let matchedEntry: OverviewEntry | null = null;
    for (const [key, entry] of Object.entries(overview)) {
      if (entry.code && entry.code.toUpperCase() === normalizedCode) {
        // 优先选用普通主线版本（排除 #f# 突袭标记文件）
        if (!key.includes('#f#')) {
          matchedEntry = entry;
          break;
        }
        if (!matchedEntry) {
          matchedEntry = entry;
        }
      }
    }

    if (!matchedEntry) return null;

    const mapFilePath = join(dir, matchedEntry.filename);
    if (!existsSync(mapFilePath)) return null;

    const mapRaw = readFileSync(mapFilePath, 'utf8');
    const mapData = JSON.parse(mapRaw) as {
      code: string;
      name: string;
      stageId: string;
      tiles: TileRawData[][];
    };

    const tiles = mapData.tiles;
    const height = tiles.length;
    const width = height > 0 ? tiles[0]!.length : 0;

    const meleeTiles: [number, number][] = [];
    const rangedTiles: [number, number][] = [];
    const startTiles: [number, number][] = [];
    const endTiles: [number, number][] = [];

    const lines: string[] = [];
    // 头部列标
    const colHeader = '     ' + Array.from({ length: width }, (_, i) => i.toString().padStart(2, '0')).join(' ');
    lines.push(colHeader);
    lines.push('     ' + Array.from({ length: width }, () => '--').join(' '));

    for (let r = 0; r < height; r++) {
      const rowTiles = tiles[r]!;
      const rowSymbols: string[] = [];
      for (let c = 0; c < width; c++) {
        const t = rowTiles[c]!;
        if (t.isStart) startTiles.push([c, r]);
        if (t.isEnd) endTiles.push([c, r]);

        if (t.isStart) {
          rowSymbols.push(' S'); // 敌方红门
        } else if (t.isEnd) {
          rowSymbols.push(' E'); // 我方蓝门
        } else if (t.buildableType === 2) {
          rangedTiles.push([c, r]);
          rowSymbols.push(' R'); // 高台 (Ranged)
        } else if (t.buildableType === 1) {
          meleeTiles.push([c, r]);
          rowSymbols.push(' M'); // 地面 (Melee)
        } else {
          rowSymbols.push(' .'); // 障碍/禁区
        }
      }
      lines.push(`R${r.toString().padStart(2, '0')}: ` + rowSymbols.join(' '));
    }

    return {
      code: mapData.code || matchedEntry.code,
      name: mapData.name || matchedEntry.name,
      stageId: mapData.stageId || matchedEntry.stageId,
      width,
      height,
      asciiGrid: lines.join('\n'),
      meleeTiles,
      rangedTiles,
      startTiles,
      endTiles,
      tiles,
    };
  } catch {
    return null;
  }
}

/** 常见关卡的内置棋盘尺寸兜底（宽/列数，高/行数） */
export const STAGE_DIMENSIONS: Record<string, MapDimension> = {
  '1-7': { width: 11, height: 7 },
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
