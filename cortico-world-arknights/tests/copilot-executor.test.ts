import { describe, expect, it, vi } from 'vitest';
import type { ArknightsConfigSection } from '../src/config.ts';
import { ARKNIGHTS_DEFAULTS } from '../src/config.ts';
import type { CopilotPlan } from '../src/battle/copilot.ts';
import { executeCopilotPlan } from '../src/battle/copilot-executor.ts';
import * as maacoreModule from '../src/battle/copilot-maacore.ts';

const mockPlan: CopilotPlan = {
  stage_name: '1-7',
  actions: [{ type: 'SpeedUp' }],
};

function createMockSession() {
  return {
    connected: true,
    resolution: [1280, 720] as const,
    screencap: vi.fn().mockResolvedValue({ ok: true, png: new Uint8Array([1, 2, 3]) }),
    recognizeFrame: vi.fn().mockResolvedValue({
      ok: true,
      lines: [{ text: '行动结束', box: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 } }],
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
});
