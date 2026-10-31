import { describe, expect, it, vi } from 'vitest';
import { normalizeMaaResourceDir, type MaaCoreLib } from '../src/mfw/asst-ffi.ts';
import {
  normalizeRoguelikeMode,
  normalizeRoguelikeTheme,
  normalizeRoleName,
  normalizeSquadName,
  loadRoguelikeStrategyInfo,
  ROGUELIKE_THEMES,
} from '../src/battle/roguelike.ts';
import {
  executeRoguelike,
  runRoguelikeDirect,
} from '../src/battle/roguelike-executor.ts';

function createMockRoguelikeLib(succeeds = true): {
  lib: MaaCoreLib;
  appendSpy: any;
  attachSpy: any;
  startSpy: any;
  stopSpy: any;
} {
  let callbackRef: ((msg: number, details: string) => void) | null = null;
  let isRunning = false;

  const appendSpy = vi.fn().mockReturnValue(201);
  const attachSpy = vi.fn().mockReturnValue(true);
  const startSpy = vi.fn().mockImplementation(() => {
    isRunning = true;
    setTimeout(() => {
      if (callbackRef) {
        callbackRef(1, JSON.stringify({ sub_task: 'StageSelect' }));
        if (succeeds) {
          callbackRef(10002, JSON.stringify({ result: 'TaskChainCompleted' }));
        } else {
          callbackRef(10000, JSON.stringify({ result: 'TaskChainError' }));
        }
      }
      isRunning = false;
    }, 40);
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
      return 99999n;
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    loadResource: vi.fn().mockReturnValue(true),
    setUserDir: vi.fn().mockReturnValue(true),
    attachWindow: attachSpy,
    connect: vi.fn().mockReturnValue(true),
    connected: vi.fn().mockReturnValue(true),
    appendTask: appendSpy,
    start: startSpy,
    stop: stopSpy,
    running: vi.fn(() => isRunning),
  };

  return { lib, appendSpy, attachSpy, startSpy, stopSpy };
}

describe('集成战略 (Roguelike) 核心模块', () => {
  describe('normalizeRoguelikeTheme 主题标准化映射', () => {
    it('空值或未知主题默认解析为 BlackFlow (黑流树海)', () => {
      expect(normalizeRoguelikeTheme()).toBe('BlackFlow');
      expect(normalizeRoguelikeTheme('')).toBe('BlackFlow');
      expect(normalizeRoguelikeTheme('未知肉鸽')).toBe('BlackFlow');
    });

    it('黑流树海各种中英文别名均精确解析为 BlackFlow', () => {
      expect(normalizeRoguelikeTheme('黑流树海')).toBe('BlackFlow');
      expect(normalizeRoguelikeTheme('黑流')).toBe('BlackFlow');
      expect(normalizeRoguelikeTheme('树海')).toBe('BlackFlow');
      expect(normalizeRoguelikeTheme('blackflow')).toBe('BlackFlow');
      expect(normalizeRoguelikeTheme('BLACKFLOW')).toBe('BlackFlow');
    });

    it('经典肉鸽主题（萨卡兹、萨米、水月、傀影）正确解析', () => {
      expect(normalizeRoguelikeTheme('萨卡兹')).toBe('Sarkaz');
      expect(normalizeRoguelikeTheme('无终奇语')).toBe('Sarkaz');
      expect(normalizeRoguelikeTheme('sarkaz')).toBe('Sarkaz');

      expect(normalizeRoguelikeTheme('萨米')).toBe('Sami');
      expect(normalizeRoguelikeTheme('银霜止境')).toBe('Sami');
      expect(normalizeRoguelikeTheme('sami')).toBe('Sami');

      expect(normalizeRoguelikeTheme('水月')).toBe('Mizuki');
      expect(normalizeRoguelikeTheme('深蓝之树')).toBe('Mizuki');
      expect(normalizeRoguelikeTheme('mizuki')).toBe('Mizuki');

      expect(normalizeRoguelikeTheme('傀影')).toBe('Phantom');
      expect(normalizeRoguelikeTheme('猩红孤钻')).toBe('Phantom');
      expect(normalizeRoguelikeTheme('phantom')).toBe('Phantom');
    });
  });

  describe('normalizeRoleName 职业招募组合别名映射与防呆纠偏', () => {
    it('攻坚备战 / 攻坚 等常见误称精准纠偏为 攻守兼备', () => {
      expect(normalizeRoleName('攻坚备战')).toBe('攻守兼备');
      expect(normalizeRoleName('攻坚')).toBe('攻守兼备');
      expect(normalizeRoleName('攻守兼备')).toBe('攻守兼备');
      expect(normalizeRoleName('备战')).toBe('攻守兼备');
    });

    it('先手 / 取长 / 随心 简称映射为全称', () => {
      expect(normalizeRoleName('先手')).toBe('先手必胜');
      expect(normalizeRoleName('取长')).toBe('取长补短');
      expect(normalizeRoleName('随心')).toBe('随心所欲');
    });

    it('空值或未匹配名称原样返回或 undefined', () => {
      expect(normalizeRoleName(undefined)).toBeUndefined();
      expect(normalizeRoleName('')).toBeUndefined();
      expect(normalizeRoleName('自定义组合')).toBe('自定义组合');
    });
  });

  describe('normalizeSquadName 分队别名映射与防呆纠偏', () => {
    it('远程 / 远程战术 等简称精准映射为 远程战术分队', () => {
      expect(normalizeSquadName('远程')).toBe('远程战术分队');
      expect(normalizeSquadName('远程战术')).toBe('远程战术分队');
      expect(normalizeSquadName('远程战术分队')).toBe('远程战术分队');
    });

    it('突击 / 堡垒 / 指挥 / 机械学者 等精准映射', () => {
      expect(normalizeSquadName('突击')).toBe('突击战术分队');
      expect(normalizeSquadName('堡垒')).toBe('堡垒战术分队');
      expect(normalizeSquadName('指挥')).toBe('指挥分队');
      expect(normalizeSquadName('机械学者')).toBe('机械学者分队');
    });
  });

  describe('loadRoguelikeStrategyInfo 策略秘籍读取', () => {
    it('不存在的资源目录返回 null', () => {
      const info = loadRoguelikeStrategyInfo('BlackFlow', 'D:/non_existent_dir_9999');
      expect(info).toBeNull();
    });

    it('读取真实 MAA 黑流树海策略（包含核心干员与藏品）', () => {
      const info = loadRoguelikeStrategyInfo('BlackFlow');
      if (info) {
        expect(info.theme).toBe('BlackFlow');
        expect(info.themeLabel).toBe('黑流树海');
        expect(info.defaultKeyOperators.length).toBeGreaterThan(0);
        // 黑流树海核心干员通常包含 机械师 或 维什戴尔
        expect(info.priorityGroups.length).toBeGreaterThan(0);
        expect(info.topRelics.length).toBeGreaterThan(0);
      }
    });

    it('读取真实 MAA 萨卡兹策略', () => {
      const info = loadRoguelikeStrategyInfo('Sarkaz');
      if (info) {
        expect(info.theme).toBe('Sarkaz');
        expect(info.themeLabel).toBe('萨卡兹的无终奇语');
        expect(info.priorityGroups.length).toBeGreaterThan(0);
      }
    });
  });

  describe('runRoguelikeDirect 与 executeRoguelike 执行调度', () => {
    it('未提供 libOverride 时 runRoguelikeDirect 返回失败', async () => {
      const outcome = await runRoguelikeDirect({
        params: { theme: 'BlackFlow' },
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.resultText).toContain('未提供有效 lib 实例');
    });

    it('直接模式成功执行并向 MaaCore 传递正确的 Roguelike 任务参数', async () => {
      const { lib, appendSpy, attachSpy } = createMockRoguelikeLib(true);
      const infoSpy = vi.fn();

      const outcome = await runRoguelikeDirect({
        params: {
          theme: 'BlackFlow',
          mode: 0,
          starts_count: 2,
          investment_withdrawn: true,
          stop_at_final_stage: true,
          use_assist: false,
        },
        hwnd: 123456,
        libOverride: lib,
        info: infoSpy,
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.resultText).toContain('执行完成');
      expect(attachSpy).toHaveBeenCalled();
      expect(appendSpy).toHaveBeenCalledWith(
        99999n,
        'Roguelike',
        expect.objectContaining({
          theme: 'BlackFlow',
          mode: 0,
          starts_count: 2,
          investment_withdrawn: true,
          stop_at_final_stage: true,
          use_assist: false,
        }),
      );
      expect(infoSpy).toHaveBeenCalled();
    });

    it('任务失败时如实报告探索中断', async () => {
      const { lib } = createMockRoguelikeLib(false);

      const outcome = await runRoguelikeDirect({
        params: { theme: 'Sarkaz' },
        libOverride: lib,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.resultText).toContain('中途失败');
    });

    it('executeRoguelike 支持直接注入 libOverride 代理执行', async () => {
      const { lib } = createMockRoguelikeLib(true);

      const outcome = await executeRoguelike({
        params: { theme: 'BlackFlow' },
        libOverride: lib,
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.resultText).toContain('执行完成');
    });

    it('normalizeRoguelikeMode：有效限制 mode 为 0 与 1，非法值(如2)自动纠正为 0 防止底核报错', () => {
      expect(normalizeRoguelikeMode(0)).toBe(0);
      expect(normalizeRoguelikeMode(1)).toBe(1);
      expect(normalizeRoguelikeMode('1')).toBe(1);
      expect(normalizeRoguelikeMode(undefined)).toBe(0);
      expect(normalizeRoguelikeMode(null)).toBe(0);
      expect(normalizeRoguelikeMode(2)).toBe(0);
      expect(normalizeRoguelikeMode('2')).toBe(0);
      expect(normalizeRoguelikeMode(-1)).toBe(0);
    });

    it('normalizeMaaResourceDir：去除尾部 resource 避免路径重复拼接', () => {
      expect(normalizeMaaResourceDir('D:\\soft\\MAA-v6\\resource')).toBe('D:/soft/MAA-v6');
      expect(normalizeMaaResourceDir('D:/soft/MAA-v6/resource/')).toBe('D:/soft/MAA-v6');
      expect(normalizeMaaResourceDir('D:/soft/MAA-v6')).toBe('D:/soft/MAA-v6');
    });

    it('支持开局定制分队、职业组合与首发核心干员透传', async () => {
      const { lib, appendSpy } = createMockRoguelikeLib(true);

      await runRoguelikeDirect({
        params: {
          theme: 'BlackFlow',
          squad: '突击战术分队',
          roles: '先手必胜',
          core_char: '维什戴尔',
        },
        libOverride: lib,
      });

      expect(appendSpy).toHaveBeenCalledWith(
        99999n,
        'Roguelike',
        expect.objectContaining({
          theme: 'BlackFlow',
          squad: '突击战术分队',
          roles: '先手必胜',
          core_char: '维什戴尔',
        }),
      );
    });

    it('interactive_recruit 为 true 时遇到招募节点触发 onRecruitPending 回调', async () => {
      let recruitCallback: any = null;
      const { lib } = createMockRoguelikeLib(true);
      const onRecruitSpy = vi.fn();

      lib.create = vi.fn((cb) => {
        recruitCallback = cb;
        return 88888n;
      });

      const promise = runRoguelikeDirect({
        params: { theme: 'BlackFlow', interactive_recruit: true },
        libOverride: lib,
        onRecruitPending: onRecruitSpy,
      });

      // 模拟底层触发招募子任务
      recruitCallback?.(1, JSON.stringify({ sub_task: 'Roguelike@RecruitMain' }));
      expect(onRecruitSpy).toHaveBeenCalledWith(expect.stringContaining('Roguelike@RecruitMain'));

      // 模拟结算完成
      recruitCallback?.(10002, JSON.stringify({ result: 'TaskChainCompleted' }));
      await promise;
    });

    it('interactive_squad 为 true 时遇到分队界面触发 onSquadPending 回调', async () => {
      let squadCallback: any = null;
      const { lib } = createMockRoguelikeLib(true);
      const onSquadSpy = vi.fn();

      lib.create = vi.fn((cb) => {
        squadCallback = cb;
        return 77777n;
      });

      const promise = runRoguelikeDirect({
        params: { theme: 'BlackFlow', interactive_squad: true },
        libOverride: lib,
        onSquadPending: onSquadSpy,
      });

      squadCallback?.(1, JSON.stringify({ sub_task: 'ChooseSquad' }));
      expect(onSquadSpy).toHaveBeenCalledWith(expect.stringContaining('ChooseSquad'));

      squadCallback?.(10002, JSON.stringify({ result: 'TaskChainCompleted' }));
      await promise;
    });

    it('interactive_route 为 true 时遇到地图寻路准备时触发 onNodePending 回调', async () => {
      let nodeCallback: any = null;
      const { lib } = createMockRoguelikeLib(true);
      const onNodeSpy = vi.fn();

      lib.create = vi.fn((cb) => {
        nodeCallback = cb;
        return 66666n;
      });

      const promise = runRoguelikeDirect({
        params: { theme: 'BlackFlow', interactive_route: true },
        libOverride: lib,
        onNodePending: onNodeSpy,
      });

      nodeCallback?.(1, JSON.stringify({ sub_task: 'Stages' }));
      expect(onNodeSpy).toHaveBeenCalledWith(expect.stringContaining('Stages'));

      nodeCallback?.(10002, JSON.stringify({ result: 'TaskChainCompleted' }));
      await promise;
    });

    it('interactive_ticket 为 true 时遇到职业券选择时触发 onTicketPending 回调', async () => {
      let ticketCallback: any = null;
      const { lib } = createMockRoguelikeLib(true);
      const onTicketSpy = vi.fn();

      lib.create = vi.fn((cb) => {
        ticketCallback = cb;
        return 55555n;
      });

      const promise = runRoguelikeDirect({
        params: { theme: 'BlackFlow', interactive_ticket: true },
        libOverride: lib,
        onTicketPending: onTicketSpy,
      });

      ticketCallback?.(1, JSON.stringify({ sub_task: 'GetDropRecruit' }));
      expect(onTicketSpy).toHaveBeenCalledWith(expect.stringContaining('GetDropRecruit'));

      ticketCallback?.(10002, JSON.stringify({ result: 'TaskChainCompleted' }));
      await promise;
    });

    it('interactive_formation 为 true 时进入战斗准备页触发 onFormationPending 回调', async () => {
      let formationCallback: any = null;
      const { lib } = createMockRoguelikeLib(true);
      const onFormationSpy = vi.fn();

      lib.create = vi.fn((cb) => {
        formationCallback = cb;
        return 44444n;
      });

      const promise = runRoguelikeDirect({
        params: { theme: 'BlackFlow', interactive_formation: true },
        libOverride: lib,
        onFormationPending: onFormationSpy,
      });

      formationCallback?.(1, JSON.stringify({ sub_task: 'Page-Combat' }));
      expect(onFormationSpy).toHaveBeenCalledWith(expect.stringContaining('Page-Combat'));

      formationCallback?.(10002, JSON.stringify({ result: 'TaskChainCompleted' }));
      await promise;
    });

    it('onWorkerReady 提供的 kill 方法能够安全终止任务', async () => {
      const { lib, stopSpy } = createMockRoguelikeLib(true);
      let readyControl: any = null;

      const promise = runRoguelikeDirect({
        params: { theme: 'BlackFlow' },
        libOverride: lib,
        onWorkerReady: (control) => {
          readyControl = control;
        },
      });

      expect(readyControl).toBeDefined();
      readyControl.kill();
      expect(stopSpy).toHaveBeenCalled();

      await promise;
    });

    it('当传入 mode: 2 等非法模式时，在任务注入时自动归一化为 0', async () => {
      const { lib, appendSpy } = createMockRoguelikeLib(true);

      await runRoguelikeDirect({
        params: {
          theme: 'BlackFlow',
          mode: 2,
        },
        libOverride: lib,
      });

      expect(appendSpy).toHaveBeenCalledWith(
        99999n,
        'Roguelike',
        expect.objectContaining({
          theme: 'BlackFlow',
          mode: 0,
        }),
      );
    });

    it('SubTaskStart (20001) 正式消息事件能精准触发 onSquadPending 拦截', async () => {
      let squadCallback: any = null;
      const { lib } = createMockRoguelikeLib(true);
      const onSquadSpy = vi.fn();

      lib.create = vi.fn((cb) => {
        squadCallback = cb;
        return 66666n;
      });

      const promise = runRoguelikeDirect({
        params: { theme: 'BlackFlow', interactive_squad: true },
        libOverride: lib,
        onSquadPending: onSquadSpy,
      });

      // 模拟 MAA C++ 发送 SubTaskStart (20001)
      squadCallback?.(20001, JSON.stringify({ task: 'Squad-EnterPoint', class: 'asst::ProcessTask' }));
      expect(onSquadSpy).toHaveBeenCalledWith(expect.stringContaining('Squad-EnterPoint'));

      squadCallback?.(10002, JSON.stringify({ result: 'TaskChainCompleted' }));
      await promise;
    });

    it('启动探索时，分队与组合参数自动经过 normalizeSquadName 与 normalizeRoleName 注入 payload', async () => {
      const { lib, appendSpy } = createMockRoguelikeLib(true);

      await runRoguelikeDirect({
        params: {
          theme: 'BlackFlow',
          squad: '远程',
          roles: '攻坚备战',
          core_char: '维什戴尔',
        },
        libOverride: lib,
      });

      expect(appendSpy).toHaveBeenCalledWith(
        99999n,
        'Roguelike',
        expect.objectContaining({
          theme: 'BlackFlow',
          squad: '远程战术分队',
          roles: '攻守兼备',
          core_char: '维什戴尔',
        }),
      );
    });
  });
});
