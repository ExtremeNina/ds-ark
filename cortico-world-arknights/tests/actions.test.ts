import { describe, expect, it } from 'vitest';
import { planClick, planSwipe } from '../src/battle/actions.ts';

const SIZE = [1280, 720] as const;

describe('通用点击', () => {
  it('把归一化坐标换算成像素，边界落在首尾像素上', () => {
    expect(planClick({ x: 0.5, y: 0.5 }, SIZE)).toEqual({ ok: true, plan: { at: { x: 640, y: 360 } } });
    expect(planClick({ x: 0, y: 1 }, SIZE)).toEqual({ ok: true, plan: { at: { x: 0, y: 719 } } });
  });

  it('越界、非数字、缺坐标都拒绝，并且不带任何像素落点', () => {
    const bad: unknown[] = [
      { x: 1.2, y: 0.5 },
      { x: 0.5, y: -0.01 },
      { x: Number.NaN, y: 0.5 },
      { x: '0.5', y: 0.5 },
      { x: 0.5 },
      null,
    ];
    for (const point of bad) {
      const result = planClick(point, SIZE);
      expect(result.ok, JSON.stringify(point)).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('点击失败');
        expect(result.error).not.toContain('NaN');
      }
    }
  });

  it('尺寸未知时拒绝，而不是按 0 去点左上角', () => {
    const result = planClick({ x: 0.5, y: 0.5 }, [0, 0]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('画面尺寸');
  });

  it('支持连点 double 与长按 holdMs 参数', () => {
    const doubleClick = planClick({ x: 0.5, y: 0.5 }, SIZE, { double: true });
    expect(doubleClick).toEqual({ ok: true, plan: { at: { x: 640, y: 360 }, double: true } });

    const holdClick = planClick({ x: 0.5, y: 0.5 }, SIZE, { holdMs: 150 });
    expect(holdClick).toEqual({ ok: true, plan: { at: { x: 640, y: 360 }, holdMs: 150 } });

    const clampedHold = planClick({ x: 0.5, y: 0.5 }, SIZE, { holdMs: 5000 });
    expect(clampedHold).toEqual({ ok: true, plan: { at: { x: 640, y: 360 }, holdMs: 3000 } });
  });
});

describe('通用拖拽', () => {
  it('两端换算成像素，时长原样带出，默认只拖一次', () => {
    const result = planSwipe({ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }, 400, SIZE);
    expect(result).toEqual({
      ok: true,
      plan: {
        from: { x: 128, y: 360 },
        to: { x: 640, y: 360 },
        durationMs: 400,
        repeats: 1,
        intervalMs: 120,
      },
    });
  });

  it('重复次数 1~5、间隔 0~1000，越界都夹住', () => {
    const of = (repeats: unknown, intervalMs: unknown) => {
      const result = planSwipe({ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }, 300, SIZE, { repeats, intervalMs });
      if (!result.ok) throw new Error(result.error);
      return result.plan;
    };
    expect(of(3, 200)).toMatchObject({ repeats: 3, intervalMs: 200 });
    expect(of(0, -5)).toMatchObject({ repeats: 1, intervalMs: 0 });
    expect(of(9, 5000)).toMatchObject({ repeats: 5, intervalMs: 1000 });
    expect(of('x', Number.NaN)).toMatchObject({ repeats: 1, intervalMs: 120 });
  });

  it('时长缺省 300ms，过短夹到 80、过长夹到 2000', () => {
    const of = (durationMs: unknown) => {
      const result = planSwipe({ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }, durationMs, SIZE);
      if (!result.ok) throw new Error(result.error);
      return result.plan.durationMs;
    };
    expect(of(undefined)).toBe(300);
    expect(of(Number.NaN)).toBe(300);
    expect(of(10)).toBe(80);
    expect(of(99_999)).toBe(2000);
  });

  it('完全重合时拒绝；1 像素微拖拽放行（3D 地图上用它当点击）', () => {
    const same = planSwipe({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 300, SIZE);
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error).toContain('重合');

    // 0.501 在 1280 宽上与 0.5 恰好差 1 像素：这是 3D 地图上「点开关卡牌」的正确手势，
    // 真机实测 ark_click 会被游戏当镜头微移，微拖拽反而能点开。
    const micro = planSwipe({ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.5 }, 300, SIZE);
    expect(micro.ok).toBe(true);
    if (micro.ok) {
      expect(micro.plan.from.x).toBe(640);
      expect(micro.plan.to.x).toBe(641);
    }
  });

  it('坐标非法或尺寸未知时拒绝', () => {
    expect(planSwipe({ x: 0.1, y: 0.5 }, { x: 2, y: 0.5 }, 300, SIZE).ok).toBe(false);
    expect(planSwipe(null, { x: 0.5, y: 0.5 }, 300, SIZE).ok).toBe(false);
    expect(planSwipe({ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }, 300, [0, 0]).ok).toBe(false);
  });
});
