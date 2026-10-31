import { describe, expect, it, vi } from 'vitest';
import type { ArknightsConfigSection } from '../src/config.ts';
import { ARKNIGHTS_DEFAULTS } from '../src/config.ts';
import type { CopilotPlan } from '../src/battle/copilot.ts';
import { evaluateBattleOutcome, executeCopilotPlan, validatePlanTiles } from '../src/battle/copilot-executor.ts';
import * as maacoreModule from '../src/battle/copilot-maacore.ts';

const mockPlan: CopilotPlan = {
  stage_name: '1-7',
  actions: [{ type: 'SpeedUp' }],
};

function createMockSession(inBattle = false) {
  let callCount = 0;
  return {
    connected: true,
    resolution: [1280, 720] as const,
    screencap: vi.fn().mockResolvedValue({ ok: true, png: new Uint8Array([1, 2, 3]) }),
    recognizeFrame: vi.fn().mockImplementation(async () => {
      callCount++;
      if (!inBattle && callCount === 1) {
        return {
          ok: true,
          lines: [{ text: '开始行动', box: { x: 0.85, y: 0.85, w: 0.1, h: 0.05 } }],
        };
      }
      return {
        ok: true,
        lines: [{ text: '行动结束', box: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 } }],
      };
    }),
    click: vi.fn().mockResolvedValue({ ok: true }),
    swipe: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

describe('CopilotExecutor 统一执行调度器', () => {
  it('当 engine 为 maacore 但未找到资源包时，返回清晰配置错误', async () => {
    vi.spyOn(maacoreModule, 'isMaaCoreBattleSupported').mockReturnValue(false);

    const cfg: ArknightsConfigSection = {
      ...ARKNIGHTS_DEFAULTS,
      copilotEngine: 'maacore',
    };

    const session = createMockSession();
    const result = await executeCopilotPlan({
      plan: mockPlan,
      cfg,
      session,
      tasker: null,
      resource: null,
    });

    expect(result.ok).toBe(false);
    expect(result.engine).toBe('maacore');
    expect(result.resultText).toContain('强制 MaaCore 模式');
    expect(result.logs.some((l) => l.includes('worlds.arknights.maaResourceDir'))).toBe(true);
  });

  it('当 engine 为 maacore 且资源就绪时，成功调度 MaaCore 执行', async () => {
    vi.spyOn(maacoreModule, 'isMaaCoreBattleSupported').mockReturnValue(true);
    vi.spyOn(maacoreModule, 'runMaaCoreCopilot').mockResolvedValue({
      ok: true,
      resultText: '作战胜利（行动结束）',
      logs: ['[MaaCore] 调度成功'],
      durationMs: 5000,
    });

    const cfg: ArknightsConfigSection = {
      ...ARKNIGHTS_DEFAULTS,
      copilotEngine: 'maacore',
    };

    const session = createMockSession();
    const result = await executeCopilotPlan({
      plan: mockPlan,
      cfg,
      session,
      tasker: {} as any,
      resource: {} as any,
    });

    expect(result.ok).toBe(true);
    expect(result.engine).toBe('maacore');
    expect(result.resultText).toContain('作战胜利');
  });

  it('当 engine 为 auto 且资源缺失时，平滑降级为 builtin 解释器', async () => {
    vi.spyOn(maacoreModule, 'isMaaCoreBattleSupported').mockReturnValue(false);

    const cfg: ArknightsConfigSection = {
      ...ARKNIGHTS_DEFAULTS,
      copilotEngine: 'auto',
    };

    const session = createMockSession();
    const result = await executeCopilotPlan({
      plan: mockPlan,
      cfg,
      session,
      tasker: null,
      resource: null,
    });

    expect(result.engine).toBe('builtin');
    expect(result.logs.some((l) => l.includes('自动降级'))).toBe(true);
    expect(result.resultText).toContain('作战胜利');
  });

  it('当 engine 为 auto，且 MaaCore 执行报错时，双保险无缝回退到 builtin 解释器打完', async () => {
    vi.spyOn(maacoreModule, 'isMaaCoreBattleSupported').mockReturnValue(true);
    vi.spyOn(maacoreModule, 'runMaaCoreCopilot').mockResolvedValue({
      ok: false,
      resultText: '启动失败：AsstCreate 创建实例返回 null。',
      logs: ['MaaCore 启动异常'],
      durationMs: 200,
    });

    const cfg: ArknightsConfigSection = {
      ...ARKNIGHTS_DEFAULTS,
      copilotEngine: 'auto',
    };

    const session = createMockSession();
    const result = await executeCopilotPlan({
      plan: mockPlan,
      cfg,
      session,
    });

    expect(result.engine).toBe('builtin');
    expect(result.logs.some((l) => l.includes('原生 MaaCore 执行异常'))).toBe(true);
    expect(result.resultText).toContain('作战胜利');
  });

  it('当 MaaCore 因非 16:9 分辨率拦截失败时，降级日志中包含明确的建议和底层诊断日志', async () => {
    vi.spyOn(maacoreModule, 'isMaaCoreBattleSupported').mockReturnValue(true);
    vi.spyOn(maacoreModule, 'runMaaCoreCopilot').mockResolvedValue({
      ok: false,
      resultText: '窗口分辨率非 16:9，MaaCore 拒绝挂载',
      logs: [
        '挂载明日方舟窗口句柄 (12345)：失败',
        '[MaaCore Msg 1] {"what":"UnsupportedResolution","why":"Not 16:9"}',
      ],
      durationMs: 300,
    });

    const cfg: ArknightsConfigSection = {
      ...ARKNIGHTS_DEFAULTS,
      copilotEngine: 'auto',
    };

    const session = createMockSession();
    const result = await executeCopilotPlan({
      plan: mockPlan,
      cfg,
      session,
    });

    expect(result.engine).toBe('builtin');
    expect(result.logs.some((l) => l.includes('窗口非 16:9 标准比例'))).toBe(true);
    expect(result.logs.some((l) => l.includes('1920x1080'))).toBe(true);
    expect(result.logs.some((l) => l.includes('MaaCore 诊断信息'))).toBe(true);
    expect(result.logs.some((l) => l.includes('UnsupportedResolution'))).toBe(true);
  });

  it('当画面检测到已处于战场内时，安全拦截并拒绝在战中提交新的 Copilot JSON', async () => {
    vi.spyOn(maacoreModule, 'isMaaCoreBattleSupported').mockReturnValue(true);
    const maaSpy = vi.spyOn(maacoreModule, 'runMaaCoreCopilot');

    const cfg: ArknightsConfigSection = {
      ...ARKNIGHTS_DEFAULTS,
      copilotEngine: 'auto',
    };

    // 模拟已经在战斗中（读到战场费用与剩余敌人）
    const session = createMockSession(true);
    session.recognizeFrame = vi.fn().mockResolvedValue({
      ok: true,
      lines: [
        { text: 'COST 15', box: { x: 0.9, y: 0.9, w: 0.08, h: 0.05 } },
        { text: '剩余可部署角色', box: { x: 0.8, y: 0.1, w: 0.1, h: 0.04 } },
        { text: '行动结束', box: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 } },
      ],
    });

    const result = await executeCopilotPlan({
      plan: mockPlan,
      cfg,
      session,
    });

    expect(result.ok).toBe(false);
    expect(maaSpy).not.toHaveBeenCalled();
    expect(result.resultText).toContain('战斗已在进行中');
    expect(result.logs.some((l) => l.includes('安全拦截'))).toBe(true);
  });

  it('当编队界面按钮为分行「开始」+「行动」且存在干员等级数字时，准确识别为编队页，不误拦为战斗中', async () => {
    vi.spyOn(maacoreModule, 'isMaaCoreBattleSupported').mockReturnValue(true);
    const maaSpy = vi.spyOn(maacoreModule, 'runMaaCoreCopilot').mockResolvedValue({
      ok: true,
      resultText: '作战胜利（行动结束）',
      logs: ['MaaCore 启动战斗托管'],
      durationMs: 5000,
    });

    const cfg: ArknightsConfigSection = {
      ...ARKNIGHTS_DEFAULTS,
      copilotEngine: 'auto',
    };

    // 模拟真机编队页：分行「开始」与「行动」、编队名称「第四编队」、卡片等级「60」（误入费用区）
    const session = createMockSession(false);
    session.recognizeFrame = vi.fn().mockResolvedValue({
      ok: true,
      lines: [
        { text: '开始', box: { x: 0.88, y: 0.72, w: 0.08, h: 0.04 } },
        { text: '行动', box: { x: 0.88, y: 0.77, w: 0.08, h: 0.04 } },
        { text: '第四编队', box: { x: 0.45, y: 0.95, w: 0.1, h: 0.03 } },
        { text: '60', box: { x: 0.86, y: 0.65, w: 0.04, h: 0.03 } }, // 落在 cost 区域的等级数字
      ],
    });

    const result = await executeCopilotPlan({
      plan: mockPlan,
      cfg,
      session,
    });

    expect(result.ok).toBe(true);
    expect(maaSpy).toHaveBeenCalled();
    expect(result.resultText).toContain('作战胜利');
  });

  it('当 MaaCore 执行报错且画面一直停留在编队界面（无法进战）时，状态守卫安全终止，不执行盲目下人', async () => {
    vi.spyOn(maacoreModule, 'isMaaCoreBattleSupported').mockReturnValue(true);
    vi.spyOn(maacoreModule, 'runMaaCoreCopilot').mockResolvedValue({
      ok: false,
      resultText: '战斗超时已强制终止',
      logs: ['等待进战超时 60s'],
      durationMs: 71000,
    });

    const cfg: ArknightsConfigSection = {
      ...ARKNIGHTS_DEFAULTS,
      copilotEngine: 'auto',
    };

    const session = createMockSession(false);
    // 始终识别为编队页，未进战
    session.recognizeFrame = vi.fn().mockResolvedValue({
      ok: true,
      lines: [
        { text: '开始行动', box: { x: 0.85, y: 0.7, w: 0.1, h: 0.05 } },
        { text: '代理指挥', box: { x: 0.7, y: 0.7, w: 0.1, h: 0.05 } },
      ],
    });

    const result = await executeCopilotPlan({
      plan: mockPlan,
      cfg,
      session,
    });

    expect(result.ok).toBe(false);
    expect(result.resultText).toContain('未能进入战场');
    expect(result.logs.some((l) => l.includes('安全中止'))).toBe(true);
  });

  it('validatePlanTiles：当高台干员落到地面格时前置拦截并报错', () => {
    const invalidPlan: CopilotPlan = {
      stage_name: '1-7',
      actions: [
        { type: 'SpeedUp' },
        // 娜仁图亚为高台狙击，[3, 2] 为地面道路 (buildableType: 1)
        { type: 'Deploy', name: '娜仁图亚', location: [3, 2], direction: 'Right' },
      ],
    };

    const res = validatePlanTiles(invalidPlan, 'D:/soft/MAA-v6/resource');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('高台');
    expect(res.reason).toContain('地面道路');
    expect(res.reason).toContain('无法部署');
  });

  it('validatePlanTiles：当高台干员落到高台格时放行通过', () => {
    const validPlan: CopilotPlan = {
      stage_name: '1-7',
      actions: [
        { type: 'SpeedUp' },
        // 乌尔比安为地面近卫，[4, 3] 为地面
        { type: 'Deploy', name: '乌尔比安', location: [4, 3], direction: 'Right' },
        // 娜仁图亚为高台狙击，[3, 1] 为高台 (buildableType: 2)
        { type: 'Deploy', name: '娜仁图亚', location: [3, 1], direction: 'Right' },
      ],
    };

    const res = validatePlanTiles(validPlan, 'D:/soft/MAA-v6/resource');
    expect(res.ok).toBe(true);
  });

  it('evaluateBattleOutcome：当结算画面检测到「理智返还」时如实裁定为作战失败', async () => {
    const session = createMockSession();
    session.recognizeFrame = vi.fn().mockResolvedValue({
      ok: true,
      lines: [
        { text: '行动结束', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 } },
        { text: '理智返还 6', box: { x: 0.2, y: 0.8, w: 0.2, h: 0.05 } },
      ],
    });

    const outcome = await evaluateBattleOutcome(new Uint8Array([1, 2, 3]), undefined, session);
    expect(outcome.isVictory).toBe(false);
    expect(outcome.reason).toContain('作战失败');
    expect(outcome.reason).toContain('理智返还');
  });
});
