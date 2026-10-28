import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MaaResourceLike, MaaTaskJobLike, MaaTaskerLike } from '../src/mfw/native.ts';
import type { CopilotPlan } from '../src/battle/copilot.ts';
import { findMaaResourceDir, isMaaCoreBattleSupported, runMaaCoreCopilot } from '../src/battle/copilot-maacore.ts';

const mockPlan: CopilotPlan = {
  stage_name: '1-7',
  actions: [
    { type: 'SpeedUp' },
    { type: 'Deploy', name: '芬', location: [4, 3], direction: 'Right', costs: 9 },
  ],
};

function createMockTasker(succeeds = true): { tasker: MaaTaskerLike; postTaskSpy: any; stopSpy: any; sinks: any[] } {
  const sinks: any[] = [];
  const postTaskSpy = vi.fn().mockImplementation((entry: string, param: any) => {
    return {
      id: 101,
      succeeded: succeeds,
      status: succeeds ? 2 : 4,
      wait: async () => {
        // 模拟触发 sink
        for (const s of sinks) {
          s('Node_Deploy', { operator: '芬' });
          s('Copilot_Accomplished', { stars: 3 });
        }
        return { succeeded: succeeds, status: succeeds ? 2 : 4 };
      },
      get: () => ({}),
    } as unknown as MaaTaskJobLike;
  });

  const stopSpy = vi.fn().mockReturnValue({
    succeeded: true,
    status: 0,
    wait: async () => ({ succeeded: true, status: 0 }),
  });

  const tasker: MaaTaskerLike = {
    resource: null,
    controller: null,
    post_task: postTaskSpy,
    post_stop: stopSpy,
    post_recognition: vi.fn(),
    add_sink: vi.fn((sink) => {
      sinks.push(sink);
      return sinks.length;
    }),
    remove_sink: vi.fn(),
    node_detail: vi.fn(),
    recognition_detail: vi.fn(),
    destroy: vi.fn(),
  };

  return { tasker, postTaskSpy, stopSpy, sinks };
}

function createMockResource(): MaaResourceLike {
  return {
    loaded: true,
    post_ocr_model: vi.fn().mockReturnValue({ succeeded: true, status: 0, wait: async () => ({ succeeded: true }) }),
    post_bundle: vi.fn().mockReturnValue({ succeeded: true, status: 0, wait: async () => ({ succeeded: true }) }),
    destroy: vi.fn(),
  };
}

describe('MaaCore Copilot 战斗驱动', () => {
  it('findMaaResourceDir 能正确验证有效 MAA 资源目录', () => {
    const fakeDir = join(tmpdir(), `fake_maa_res_${Date.now()}`);
    mkdirSync(join(fakeDir, 'pipeline'), { recursive: true });

    try {
      expect(findMaaResourceDir(fakeDir)).toBe(fakeDir);
      expect(findMaaResourceDir('C:/NonExistentPath_XYZ')).toBeNull();
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('isMaaCoreBattleSupported 在缺少 Tasker 或资源包时返回 false', () => {
    expect(isMaaCoreBattleSupported(null, null)).toBe(false);
    const { tasker } = createMockTasker();
    expect(isMaaCoreBattleSupported(tasker, null)).toBe(false);
  });

  it('runMaaCoreCopilot 成功启动任务、收集 Sink 日志并回报胜利', async () => {
    const fakeDir = join(tmpdir(), `fake_maa_run_${Date.now()}`);
    mkdirSync(join(fakeDir, 'image'), { recursive: true });

    const { tasker, postTaskSpy } = createMockTasker(true);
    const resource = createMockResource();

    try {
      const outcome = await runMaaCoreCopilot({
        plan: mockPlan,
        tasker,
        resource,
        maaResourceDir: fakeDir,
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.resultText).toContain('作战胜利');
      expect(postTaskSpy).toHaveBeenCalledWith('Copilot', expect.objectContaining({ formation: false }));
      expect(outcome.logs.some((l) => l.includes('[MaaCore] Node_Deploy'))).toBe(true);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('runMaaCoreCopilot 任务失败时如实返回失败状态', async () => {
    const fakeDir = join(tmpdir(), `fake_maa_fail_${Date.now()}`);
    mkdirSync(join(fakeDir, 'pipeline'), { recursive: true });

    const { tasker } = createMockTasker(false);
    const resource = createMockResource();

    try {
      const outcome = await runMaaCoreCopilot({
        plan: mockPlan,
        tasker,
        resource,
        maaResourceDir: fakeDir,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.resultText).toContain('作战失败或已中断');
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });
});
