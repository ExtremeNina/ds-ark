import { describe, it, expect } from 'vitest';
import { aspectDeviation, clamp01, is16by9, pausePoint, toPixel, toPoint } from '../src/mfw/geometry.ts';

describe('画面比例判定', () => {
  it('16:9 的各种分辨率都算命中', () => {
    expect(is16by9(1280, 720)).toBe(true);
    expect(is16by9(1920, 1080)).toBe(true);
    expect(is16by9(2560, 1440)).toBe(true);
    expect(is16by9(3840, 2160)).toBe(true);
  });

  it('16:10 与 21:9 判为非 16:9', () => {
    expect(is16by9(1152, 720)).toBe(false);
    expect(is16by9(1680, 720)).toBe(false);
    expect(is16by9(1024, 768)).toBe(false);
  });

  it('取整误差不误报，非法尺寸判否', () => {
    expect(is16by9(1279, 720)).toBe(true);
    expect(is16by9(1281, 720)).toBe(true);
    expect(is16by9(0, 720)).toBe(false);
    expect(is16by9(Number.NaN, 720)).toBe(false);
  });

  it('容差边界：720p 下 1266~1294 命中，再往外判否', () => {
    // 容差 0.02 对应宽度 1265.6 ~ 1294.4，两侧各留一格取整误差
    expect(is16by9(1266, 720)).toBe(true);
    expect(is16by9(1294, 720)).toBe(true);
    expect(is16by9(1265, 720)).toBe(false);
    expect(is16by9(1295, 720)).toBe(false);
  });

  it('偏差值：16:9 为 0，1.71:1 约 0.065，16:10 约 0.178', () => {
    expect(aspectDeviation(1280, 720)).toBeCloseTo(0, 10);
    expect(aspectDeviation(1233, 720)).toBeCloseTo(0.0653, 3);
    expect(aspectDeviation(1152, 720)).toBeCloseTo(0.1778, 3);
    expect(aspectDeviation(0, 720)).toBe(Number.POSITIVE_INFINITY);
    expect(aspectDeviation(Number.NaN, 720)).toBe(Number.POSITIVE_INFINITY);
  });
});

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

describe('暂停落点', () => {
  const pause = { x: 0.966, y: 0.071 };

  it('16:9 下与 toPoint 完全一致，已标定的坐标不失效', () => {
    expect(pausePoint(pause, [1280, 720])).toEqual(toPoint(pause, [1280, 720]));
    expect(pausePoint(pause, [1280, 720])).toEqual({ x: 1236, y: 51 });
  });

  it('轻微非 16:9 时与按比例换算只差 1px', () => {
    const point = pausePoint(pause, [1233, 720]);
    expect(point).toEqual({ x: 1189, y: 51 });
    expect(Math.abs(point.x - toPoint(pause, [1233, 720]).x)).toBeLessThanOrEqual(2);
  });

  it('4:3 时按比例会偏 10px，按右边缘余量仍然贴边', () => {
    const point = pausePoint(pause, [960, 720]);
    expect(point.x).toBe(916);
    expect(toPoint(pause, [960, 720]).x - point.x).toBe(10);
    expect(point.y).toBe(51);
  });

  it('越界与脏值不产生 NaN', () => {
    expect(pausePoint({ x: Number.NaN, y: Number.NaN }, [0, 0])).toEqual({ x: 0, y: 0 });
    expect(pausePoint({ x: 2, y: -1 }, [960, 720])).toEqual({ x: 959, y: 0 });
  });
});
