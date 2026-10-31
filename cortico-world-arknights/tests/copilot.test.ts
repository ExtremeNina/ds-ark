import { describe, expect, it, vi } from 'vitest';
import { normalizeDirection, parseCopilotPlan, resolveActionTile, resolveHandCardPosition } from '../src/battle/copilot.ts';
import { compareFormation, fetchCopilotPlan, fetchOnlineCopilot } from '../src/battle/copilot-fetch.ts';

describe('copilot 计划解析与校验', () => {
  it('正确解析标准的 Copilot JSON', () => {
    const raw = {
      stage_name: '2-10',
      actions: [
        { type: 'SpeedUp' },
        { type: 'Deploy', name: '芬', location: [4, 4], direction: 'Right', costs: 9 },
      ],
    };
    const parsed = parseCopilotPlan(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.plan.stage_name).toBe('2-10');
      expect(parsed.plan.actions.length).toBe(2);
      expect(parsed.plan.actions[1]!.name).toBe('芬');
      expect(parsed.plan.actions[1]!.costs).toBe(9);
    }
  });

  it('缺少 stage_name 或 actions 时返回可读错误', () => {
    expect(parseCopilotPlan({}).ok).toBe(false);
    expect(parseCopilotPlan({ stage_name: '2-10' }).ok).toBe(false);
    expect(parseCopilotPlan({ stage_name: '2-10', actions: 'invalid' }).ok).toBe(false);
  });

  it('正确解析 pre_delay 与 rear_delay 字段', () => {
    const raw = {
      stage_name: '1-7',
      actions: [
        { type: 'SpeedUp' },
        { type: 'Deploy', name: '凛御银灰', location: [1, 3], direction: 'Right', costs: 12 },
        { type: 'Skill', name: '凛御银灰', location: [1, 3], pre_delay: 5000 },
        { type: 'Deploy', name: '娜仁图亚', location: [1, 2], direction: 'Right', costs: 19 },
        { type: 'Skill', name: '娜仁图亚', location: [1, 2], pre_delay: 3000, rear_delay: 1000 },
      ],
    };
    const parsed = parseCopilotPlan(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.plan.actions[2]!.pre_delay).toBe(5000);
      expect(parsed.plan.actions[4]!.pre_delay).toBe(3000);
      expect(parsed.plan.actions[4]!.rear_delay).toBe(1000);
    }
  });

  it('方向标准化', () => {
    expect(normalizeDirection('Up')).toBe('up');
    expect(normalizeDirection('上')).toBe('up');
    expect(normalizeDirection('LEFT')).toBe('left');
    expect(normalizeDirection('右')).toBe('right');
    expect(normalizeDirection(undefined)).toBe('right');
  });

  it('地块坐标正确解析', () => {
    const dim = { width: 10, height: 10 };
    const tile = resolveActionTile({ type: 'Deploy', location: [5, 5] }, dim);
    expect(tile).not.toBeNull();
    expect(tile!.x).toBeGreaterThan(0.4);
  });
});

describe('copilot-fetch 抄作业与编队比对', () => {
  it('能正确获取内置 2-10 和 1-7 作业', async () => {
    const plan210 = await fetchCopilotPlan('2-10');
    expect(plan210).not.toBeNull();
    expect(plan210?.stage_name).toBe('2-10');
    expect(plan210?.actions.length).toBeGreaterThan(0);

    const plan17 = await fetchCopilotPlan('1-7');
    expect(plan17).not.toBeNull();
    expect(plan17?.stage_name).toBe('1-7');
  });

  it('比对队伍包含全部所需干员时，允许直接执行', async () => {
    const plan = (await fetchCopilotPlan('1-7'))!;
    const team = ['芬', '克洛丝', '阿米娅', '安洁莉娜'];
    const cmp = compareFormation(plan, team);

    expect(cmp.canExecuteDirectly).toBe(true);
    expect(cmp.missing.length).toBe(0);
    expect(cmp.matched).toContain('芬');
    expect(cmp.matched).toContain('克洛丝');
  });

  it('比对队伍缺少干员时，明确指出缺漏并建议询问用户', async () => {
    const plan = (await fetchCopilotPlan('2-10'))!;
    const team = ['安洁莉娜', '阿米娅']; // 缺少 芬、香草、米格鲁、克洛丝
    const cmp = compareFormation(plan, team);

    expect(cmp.canExecuteDirectly).toBe(false);
    expect(cmp.missing).toContain('芬');
    expect(cmp.notes).toContain('请向用户询问');
  });

  it('fetchOnlineCopilot 成功对接作业站返回并校验计划', async () => {
    const mockPlan = {
      stage_name: '3-8',
      actions: [{ type: 'SpeedUp' }, { type: 'Deploy', name: '芬', location: [3, 3] }],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/copilot/query')) {
        return {
          ok: true,
          json: async () => ({ data: [{ id: 9999, title: '3-8 作业' }] }),
        } as unknown as Response;
      }
      if (url.includes('/copilot/get/9999')) {
        return {
          ok: true,
          json: async () => ({ data: { content: JSON.stringify(mockPlan) } }),
        } as unknown as Response;
      }
      return { ok: false } as unknown as Response;
    });

    try {
      const plan = await fetchOnlineCopilot('3-8', 'https://mock.prts.plus');
      expect(plan).not.toBeNull();
      expect(plan?.stage_name).toBe('3-8');
      expect(plan?.actions.length).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fetchOnlineCopilot 当网络超时或异常时静默降级为 null', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    try {
      const plan = await fetchOnlineCopilot('3-8');
      expect(plan).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe('resolveHandCardPosition 手牌动态卡槽定位', () => {
    it('当识别到手牌费用且精确匹配时，返回真实手牌坐标', () => {
      const handCosts = [
        { cost: 10, x: 0.25 },
        { cost: 14, x: 0.50 },
        { cost: 20, x: 0.85 },
      ];
      const pos = resolveHandCardPosition({ type: 'Deploy', name: '芬', costs: 10 }, { handCosts });
      expect(pos.x).toBe(0.25);
      expect(pos.y).toBe(0.88);
    });

    it('当费用存在 ±1 潜能公差时，依然能精准命中', () => {
      const handCosts = [{ cost: 9, x: 0.32 }];
      const pos = resolveHandCardPosition({ type: 'Deploy', name: '芬', costs: 10 }, { handCosts });
      expect(pos.x).toBe(0.32);
    });

    it('当费用未匹配但有手牌时，按 deployedCount 顺位选择而不是抓空', () => {
      const handCosts = [
        { cost: 12, x: 0.30 },
        { cost: 18, x: 0.60 },
      ];
      const pos = resolveHandCardPosition({ type: 'Deploy', name: '未知' }, { handCosts, deployedCount: 1 });
      expect(pos.x).toBe(0.60);
    });

    it('当没有任何 OCR 手牌数据时，随部署次数动态偏移，绝不抓死同一坐标', () => {
      const pos0 = resolveHandCardPosition({ type: 'Deploy' }, { deployedCount: 0 });
      const pos1 = resolveHandCardPosition({ type: 'Deploy' }, { deployedCount: 1 });
      const pos2 = resolveHandCardPosition({ type: 'Deploy' }, { deployedCount: 2 });
      expect(pos0.x).toBe(0.82);
      expect(pos1.x).toBeLessThan(pos0.x);
      expect(pos2.x).toBeLessThan(pos1.x);
    });
  });
});
