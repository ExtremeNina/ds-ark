import { describe, it, expect } from 'vitest';
import { planDeploy } from '../src/battle/deploy.ts';

const SIZE = [1280, 720] as const;
const center = { x: 0.5, y: 0.5 };

function planOf(...args: Parameters<typeof planDeploy>) {
  const result = planDeploy(...args);
  if (!result.ok) throw new Error(`本该成功：${result.error}`);
  return result.plan;
}

describe('部署几何', () => {
  it('把归一化坐标换算成两次拖拽的端点', () => {
    const plan = planOf({ x: 0.1, y: 0.9 }, center, 'up', SIZE);
    expect(plan.card).toEqual({ x: 128, y: 647 });
    expect(plan.tile).toEqual({ x: 640, y: 360 });
    // 720 高 × 0.11 ≈ 79 像素
    expect(plan.release).toEqual({ x: 640, y: 281 });
    expect(plan.holdMs).toBe(260);
    expect(plan.gapMs).toBe(0);
    expect(plan.directionMs).toBe(160);
  });

  it('时序可取配置值；非法值回落默认，超限被夹住', () => {
    const custom = planOf({ x: 0.1, y: 0.9 }, center, 'up', SIZE, {
      holdMs: 600,
      gapMs: 150,
      directionMs: 250,
    });
    expect(custom.holdMs).toBe(600);
    expect(custom.gapMs).toBe(150);
    expect(custom.directionMs).toBe(250);

    const messy = planOf({ x: 0.1, y: 0.9 }, center, 'up', SIZE, {
      holdMs: Number.NaN,
      gapMs: -5,
      directionMs: 99_999,
    });
    expect(messy.holdMs).toBe(260); // 非数字回落默认
    expect(messy.gapMs).toBe(0); // 负数夹到 0
    expect(messy.directionMs).toBe(5000); // 上限
  });

  it('四个朝向的偏移方向都对，且偏移量只跟画面高度有关', () => {
    const up = planOf({ x: 0.1, y: 0.9 }, center, 'up', SIZE).release;
    const down = planOf({ x: 0.1, y: 0.9 }, center, 'down', SIZE).release;
    const left = planOf({ x: 0.1, y: 0.9 }, center, 'left', SIZE).release;
    const right = planOf({ x: 0.1, y: 0.9 }, center, 'right', SIZE).release;

    expect(up).toEqual({ x: 640, y: 281 });
    expect(down).toEqual({ x: 640, y: 439 });
    expect(left).toEqual({ x: 561, y: 360 });
    expect(right).toEqual({ x: 719, y: 360 });

    // 换分辨率（同样是 16:9）只改像素，不改方向关系
    const hd = planOf({ x: 0.1, y: 0.9 }, center, 'up', [1920, 1080]).release;
    expect(hd.y).toBeLessThan(1080 / 2);
  });

  it('坐标越界、朝向不认识都拒绝，并且不发手势', () => {
    const bad: Array<Parameters<typeof planDeploy>> = [
      [{ x: 1.2, y: 0.5 }, center, 'up', SIZE],
      [{ x: 0.5, y: -0.01 }, center, 'up', SIZE],
      [{ x: 0.5, y: 0.5 }, { x: Number.NaN, y: 0.5 }, 'up', SIZE],
      [{ x: 0.5, y: 0.5 }, center, 'north', SIZE],
      [{ x: 0.5, y: 0.5 }, center, 3, SIZE],
      [null, center, 'up', SIZE],
      [{ x: '0.5', y: 0.5 }, center, 'up', SIZE],
    ];
    for (const args of bad) {
      const result = planDeploy(...args);
      expect(result.ok, JSON.stringify(args)).toBe(false);
      if (!result.ok) expect(result.error).toContain('部署失败');
    }
  });

  it('没有画面尺寸时拒绝，而不是拿猜测值算', () => {
    const result = planDeploy({ x: 0.5, y: 0.5 }, center, 'up', [0, 0]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('画面尺寸');
  });

  it('地块贴边导致朝向拖不出来时拒绝，并说明怎么改', () => {
    const result = planDeploy({ x: 0.1, y: 0.9 }, { x: 1, y: 0.5 }, 'right', SIZE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('边缘');
      expect(result.error).toContain('换个朝向');
    }
  });

  it('归一化的 0 / 1 边界本身是合法的', () => {
    const plan = planOf({ x: 0, y: 1 }, { x: 1, y: 0 }, 'down', SIZE);
    expect(plan.card).toEqual({ x: 0, y: 719 });
    expect(plan.tile).toEqual({ x: 1279, y: 0 });
    expect(plan.release).toEqual({ x: 1279, y: 79 });
  });
});
