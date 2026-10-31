import { describe, expect, it, vi } from 'vitest';
import type { MaaCoreLib } from '../src/mfw/asst-ffi.ts';
import type { CopilotPlan } from '../src/battle/copilot.ts';
import { isMaaCoreBattleSupported, runMaaCoreCopilot } from '../src/battle/copilot-maacore.ts';

const mockPlan: CopilotPlan = {
  stage_name: '1-7',
  actions: [
    { type: 'SpeedUp' },
    { type: 'Deploy', name: '芬', location: [4, 3], direction: 'Right', costs: 9 },
  ],
};

function createMockMaaLib(succeeds = true): { lib: MaaCoreLib; appendSpy: any; startSpy: any; stopSpy: any } {
  let callbackRef: ((msg: number, details: string) => void) | null = null;
  let isRunning = false;

  const appendSpy = vi.fn().mockReturnValue(101);
  const startSpy = vi.fn().mockImplementation(() => {
    isRunning = true;
    setTimeout(() => {
      if (callbackRef) {
        callbackRef(1, JSON.stringify({ sub_task: 'Deploy', operator: '芬' }));
        callbackRef(2, JSON.stringify({ result: succeeds ? 'Accomplished' : 'Failed' }));
      }
      isRunning = false;
    }, 50);
    return true;
  });
  const stopSpy = vi.fn().mockImplementation(() => {
    isRunning = false;
    return true;
  });

  const lib: MaaCoreLib = {
    version: 'v6.20.1',
    create: vi.fn((cb) => {
      callbackRef = cb;
      return 12345n;
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    loadResource: vi.fn().mockReturnValue(true),
    setUserDir: vi.fn().mockReturnValue(true),
    attachWindow: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockReturnValue(true),
    connected: vi.fn().mockReturnValue(true),
    appendTask: appendSpy,
    start: startSpy,
    stop: stopSpy,
    running: vi.fn(() => isRunning),
  };

  return { lib, appendSpy, startSpy, stopSpy };
}

describe('MaaCore Copilot 战斗驱动 (方案B 原生直连)', () => {
  it('isMaaCoreBattleSupported 在提供 lib 时返回 true', () => {
    const { lib } = createMockMaaLib();
    expect(isMaaCoreBattleSupported(undefined, lib)).toBe(true);
  });

  it('runMaaCoreCopilot 成功启动任务、收集回调日志并回报胜利', async () => {
    const { lib, appendSpy, startSpy } = createMockMaaLib(true);

    const outcome = await runMaaCoreCopilot({
      plan: mockPlan,
      hwnd: 0x1234,
      maxSeconds: 5,
      lib,
    });



    expect(outcome.ok).toBe(true);
    expect(outcome.resultText).toContain('作战胜利');
    expect(appendSpy).toHaveBeenCalledWith(12345n, 'Copilot', expect.objectContaining({ formation: false }));
    expect(startSpy).toHaveBeenCalled();
    expect(outcome.logs.some((l) => l.includes('MaaCore Msg'))).toBe(true);
  });

  it('runMaaCoreCopilot 任务失败时如实返回失败状态', async () => {
    const { lib } = createMockMaaLib(false);

    const outcome = await runMaaCoreCopilot({
      plan: mockPlan,
      hwnd: 0x1234,
      maxSeconds: 5,
      lib,
    });



    expect(outcome.ok).toBe(false);
    expect(outcome.resultText).toContain('作战失败或已中断');
  });

  it('runMaaCoreCopilot 当底层反馈 UnsupportedResolution 时精确返回非 16:9 错误说明', async () => {
    const { lib } = createMockMaaLib(false);
    // 重载 startSpy，使其回调报出 UnsupportedResolution
    lib.start = vi.fn().mockImplementation(() => {
      setTimeout(() => {
        const createCall = vi.mocked(lib.create).mock.calls[0];
        const callback = createCall ? createCall[0] : null;
        if (callback) {
          callback(1, JSON.stringify({ what: 'UnsupportedResolution', why: 'Not 16:9' }));
        }
      }, 30);
      return true;
    });

    const outcome = await runMaaCoreCopilot({
      plan: mockPlan,
      hwnd: 0x1234,
      maxSeconds: 5,
      lib,
    });



    expect(outcome.ok).toBe(false);
    expect(outcome.resultText).toContain('窗口分辨率非 16:9，MaaCore 拒绝挂载');
  });

  it('runMaaCoreCopilot 即使遇到 BattleStartPre 预检告警，只要收到 Msg 10002 依然判定任务胜利', async () => {
    const { lib } = createMockMaaLib(true);
    lib.start = vi.fn().mockImplementation(() => {
      setTimeout(() => {
        const createCall = vi.mocked(lib.create).mock.calls[0];
        const callback = createCall ? createCall[0] : null;
        if (callback) {
          // 模拟编队页进战导致的非致命 BattleStartPre SubTaskError
          callback(20000, JSON.stringify({ class: 'asst::ProcessTask', first: ['BattleStartPre'], details: { err: 'Failed' } }));
          // 模拟部署成功
          callback(1, JSON.stringify({ sub_task: 'Deploy', operator: '乌尔比安' }));
          // 模拟最终 TaskChainCompleted (Msg 10002) 和 AllTasksCompleted (Msg 3)
          callback(10002, JSON.stringify({ taskchain: 'Copilot', taskid: 1 }));
          callback(3, JSON.stringify({ finished_tasks: [1] }));
        }
      }, 50);
      return true;
    });

    const outcome = await runMaaCoreCopilot({
      plan: mockPlan,
      hwnd: 0x1234,
      maxSeconds: 5,
      lib,
    });



    expect(outcome.ok).toBe(true);
    expect(outcome.resultText).toContain('作战胜利');
  });
});
