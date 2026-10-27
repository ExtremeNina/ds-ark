import { describe, it, expect } from 'vitest';
import { clamp01, toPixel, toPoint } from '../src/mfw/geometry.ts';

describe('归一化坐标换算', () => {
  it('把 0~1 映射到 0~尺寸-1，边缘落在最后一个像素', () => {
    expect(toPixel(0, 1000)).toBe(0);
    expect(toPixel(1, 1000)).toBe(999);
    expect(toPixel(0.5, 1000)).toBe(500);
    expect(toPixel(0.9999, 1000)).toBe(999);
  });

  it('越界值夹回画面内', () => {
    expect(toPixel(-3, 800)).toBe(0);
    expect(toPixel(42, 800)).toBe(799);
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.2)).toBe(1);
  });

  it('脏值与非法尺寸不产生 NaN 坐标', () => {
    expect(toPixel(Number.NaN, 800)).toBe(0);
    expect(toPixel(Number.POSITIVE_INFINITY, 800)).toBe(0);
    expect(toPixel(0.5, 0)).toBe(0);
    expect(toPixel(0.5, -100)).toBe(0);
    expect(toPoint({ x: Number.NaN, y: 0.5 }, [0, 0])).toEqual({ x: 0, y: 0 });
  });

  it('极小分辨率也不会越界', () => {
    expect(toPoint({ x: 1, y: 1 }, [1, 1])).toEqual({ x: 0, y: 0 });
    expect(toPoint({ x: 1, y: 1 }, [2, 3])).toEqual({ x: 1, y: 2 });
  });
});
