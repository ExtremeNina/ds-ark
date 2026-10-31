/**
 * MaaCore 集成战略独立子进程工作器 (Roguelike Worker)
 * 运行在独立的 Node 进程中，负责加载外部 MaaCore.dll、挂载窗口并执行 Roguelike 探索任务。
 *
 * 核心优势：
 * 1. 进程级隔离：无论肉鸽探索中外部 C++ 发生何种异常，主进程绝对免疫崩溃；
 * 2. 实时 IPC 日志流：将每一步节点推进与探索阶段以消息通知主进程；
 * 3. 局中招募拦截（方案A）：检测到招募界面时自动暂停底层点击，交由大模型决策并支持安全看门狗。
 */
import { loadMaaCoreLib, MAA_WIN32_INPUT, MAA_WIN32_SCREENCAP } from '../mfw/asst-ffi.ts';
import { normalizeRoleName, normalizeRoguelikeMode, normalizeSquadName, type RoguelikeTaskParams } from './roguelike.ts';

export interface RoguelikeWorkerPayload {
  readonly params: RoguelikeTaskParams;
  readonly hwnd?: string | number | bigint | null;
  readonly maaResourceDir?: string;
  readonly maxMinutes?: number;
}

export type RoguelikeWorkerMessage =
  | { readonly type: 'log'; readonly message: string }
  | { readonly type: 'info'; readonly message: string }
  | {
      readonly type: 'done';
      readonly ok: boolean;
      readonly resultText: string;
      readonly logs: string[];
      readonly durationMs: number;
    }
  | { readonly type: 'error'; readonly error: string }
  | { readonly type: 'ticket_pending'; readonly details: string; readonly timestamp: number }
  | { readonly type: 'recruit_pending'; readonly details: string; readonly timestamp: number }
  | { readonly type: 'squad_pending'; readonly details: string; readonly timestamp: number }
  | { readonly type: 'formation_pending'; readonly details: string; readonly timestamp: number }
  | { readonly type: 'node_pending'; readonly details: string; readonly timestamp: number };

function sendMsg(msg: RoguelikeWorkerMessage): void {
  if (typeof process.send === 'function') {
    process.send(msg);
  }
}

async function runWorker(payload: RoguelikeWorkerPayload): Promise<void> {
  const { params, hwnd, maaResourceDir, maxMinutes = 45 } = payload;
  const logs: string[] = [];
  const startTime = Date.now();

  const lib = loadMaaCoreLib(maaResourceDir);
  if (!lib) {
    sendMsg({
      type: 'done',
      ok: false,
      resultText: '启动失败：未找到或无法加载 MaaCore.dll。',
      logs: ['未能加载 MaaCore.dll 原生动态库，请检查 MAA 安装目录。'],
      durationMs: 0,
    });
    return;
  }

  const startMsg = `【集成战略执行引擎：MaaCore 原生 (v${lib.version})】已直连官方原生引擎 (子进程隔离模式)`;
  logs.push(startMsg);
  sendMsg({ type: 'log', message: startMsg });
  sendMsg({
    type: 'info',
    message: `MaaCore 启动集成战略托管：主题【${params.theme}】，分队【${params.squad || '默认'}】，核心干员【${params.core_char || '默认'}】`,
  });

  let taskSuccess = false;
  let taskFailed = false;
  let handle: unknown = null;

  const interactiveRecruit = params.interactive_recruit !== false;
  const interactiveSquad = params.interactive_squad !== false;
  const interactiveRoute = params.interactive_route !== false;
  const interactiveTicket = params.interactive_ticket !== false;
  const interactiveFormation = params.interactive_formation !== false;

  const normalizedSquad = normalizeSquadName(params.squad);
  const normalizedRoles = normalizeRoleName(params.roles);

  const taskPayload: Record<string, unknown> = {
    theme: params.theme,
    mode: normalizeRoguelikeMode(params.mode),
    starts_count: params.starts_count ?? 1,
    investment_withdrawn: params.investment_withdrawn ?? false,
    stop_at_final_stage: params.stop_at_final_stage ?? false,
    use_assist: params.use_assist ?? false,
  };
  // 必须透传标准化后的分队与组合参数！
  // 若不传 squad/roles，MAA 原生流水线将 fallback 至 SquadDefault.png (指挥分队) 与 RolesDefault.png (取长补短)
  if (normalizedSquad) taskPayload.squad = normalizedSquad;
  if (normalizedRoles) taskPayload.roles = normalizedRoles;
  if (params.core_char) taskPayload.core_char = params.core_char;

  let isPending = false;
  let pendingWatchdog: ReturnType<typeof setTimeout> | null = null;

  const resumeTask = (reason = '收到恢复指令') => {
    if (!isPending || !handle) return;
    isPending = false;
    if (pendingWatchdog) {
      clearTimeout(pendingWatchdog);
      pendingWatchdog = null;
    }
    const log = `[Roguelike] ${reason}，重新挂载并恢复 MaaCore 跑图与战斗...`;
    logs.push(log);
    sendMsg({ type: 'log', message: log });
    lib.appendTask(handle, 'Roguelike', taskPayload);
    lib.start(handle);
  };

  // 监听父进程 IPC 指令
  process.on('message', (msg: any) => {
    if (msg?.type === 'resume') {
      resumeTask('收到大模型决策完成指令');
    } else if (msg?.type === 'kill') {
      sendMsg({
        type: 'done',
        ok: false,
        resultText: '大模型或博士下达紧急停止指令，已安全终止探索。',
        logs: ['收到 kill 指令，子进程立即退出'],
        durationMs: Date.now() - startTime,
      });
      process.exit(0);
    }
  });

  // MAA C-API AsstMsg 官方常量 (Asst.h)
  const ASST_MSG = {
    ConnectionInfo: 1,
    AllTasksCompleted: 2,
    AsyncCallInfo: 3,
    TaskChainError: 10000,
    TaskChainStart: 10001,
    TaskChainCompleted: 10002,
    TaskChainExtraInfo: 10003,
    TaskChainStopped: 10004,
    SubTaskError: 20000,
    SubTaskStart: 20001,
    SubTaskCompleted: 20002,
    SubTaskExtraInfo: 20003,
    SubTaskStopped: 20004,
  };

  const isSubTaskEvent = (m: number) =>
    m === ASST_MSG.SubTaskStart ||
    m === ASST_MSG.SubTaskCompleted ||
    m === ASST_MSG.SubTaskExtraInfo ||
    m === ASST_MSG.ConnectionInfo ||
    m === ASST_MSG.AsyncCallInfo;

  try {
    handle = lib.create((msg: number, details: string) => {
      try {
        const parsed = details ? JSON.parse(details) : {};
        const detailStr = typeof parsed === 'object' ? JSON.stringify(parsed) : String(details);
        const logLine = `[MaaCore Roguelike Msg ${msg}] ${detailStr.slice(0, 120)}`;
        logs.push(logLine);
        sendMsg({ type: 'log', message: logLine });

        if (msg === ASST_MSG.TaskChainError) {
          taskFailed = true;
        } else if (msg === ASST_MSG.TaskChainCompleted || msg === ASST_MSG.AsyncCallInfo) {
          taskSuccess = true;
        }

        // 1. 分队与开局招募组合选择拦截 (抢在 MAA 触发自动插件或滑屏前彻底冻结)
        if (interactiveSquad && !isPending && isSubTaskEvent(msg)) {
          if (
            typeof details === 'string' &&
            (details.includes('Squad') ||
              details.includes('ChooseSquad') ||
              details.includes('Squad-EnterPoint') ||
              details.includes('RoguelikeCustomStartTaskPlugin') ||
              details.includes('SquadSlowlySwipe') ||
              details.includes('RolesDefault') ||
              details.includes('ChooseRoles'))
          ) {
            isPending = true;
            lib.stop(handle);
            const notice = `【分队/组合选择感知】发现开局分队或职业组合选择界面，已暂停底层自动操作，交由大模型自主决策！`;
            logs.push(notice);
            sendMsg({ type: 'log', message: notice });
            sendMsg({ type: 'squad_pending', details, timestamp: Date.now() });

            pendingWatchdog = setTimeout(() => {
              if (isPending) {
                resumeTask('大模型分队/组合决策超时 (75s)，自动恢复 MAA 兜底执行');
              }
            }, 75000);
          }
        }

        // 2. 招募券选择拦截 (在 MAA 触发预设选券前抢先挂起)
        if (interactiveTicket && !isPending && isSubTaskEvent(msg)) {
          if (
            typeof details === 'string' &&
            (details.includes('GetDropRecruit') ||
              details.includes('GetDropSelect') ||
              details.includes('RecruitTicket') ||
              details.includes('InitialDrop'))
          ) {
            isPending = true;
            lib.stop(handle);
            const notice = `【招募券感知】发现可选职业招募券，已暂停底层自动选券，交由大模型自主决策！`;
            logs.push(notice);
            sendMsg({ type: 'log', message: notice });
            sendMsg({ type: 'ticket_pending', details, timestamp: Date.now() });

            pendingWatchdog = setTimeout(() => {
              if (isPending) {
                resumeTask('大模型选券决策超时 (75s)，自动恢复 MAA 兜底执行');
              }
            }, 75000);
          }
        }

        // 3. 局中招募干员大模型自主挑选拦截
        if (interactiveRecruit && !isPending && isSubTaskEvent(msg)) {
          if (
            typeof details === 'string' &&
            (details.includes('Recruit') || details.includes('ChooseOper') || details.includes('RoguelikeRecruitTaskPlugin'))
          ) {
            isPending = true;
            lib.stop(handle);
            const notice = `【招募节点感知】发现干员招募界面，已暂停底层自动点击与滑屏，交由大模型自主决策！`;
            logs.push(notice);
            sendMsg({ type: 'log', message: notice });
            sendMsg({ type: 'recruit_pending', details, timestamp: Date.now() });

            // 75 秒安全超时看门狗保护，防止大模型异常挂死
            pendingWatchdog = setTimeout(() => {
              if (isPending) {
                resumeTask('大模型招募决策超时 (75s)，自动恢复 MAA 兜底执行');
              }
            }, 75000);
          }
        }

        // 4. 战前编队决策拦截 (阻止 MAA 盲目 QuickFormation)
        if (interactiveFormation && !isPending && isSubTaskEvent(msg)) {
          if (
            typeof details === 'string' &&
            (details.includes('Page-Combat') ||
              details.includes('QuickFormation') ||
              details.includes('RoguelikeFormationTaskPlugin') ||
              details.includes('StageEnterBattle'))
          ) {
            isPending = true;
            lib.stop(handle);
            const notice = `【战前编队感知】进入作战准备阶段，已拦截 MAA 自动编队，交由大模型自主挑选精锐阵容！`;
            logs.push(notice);
            sendMsg({ type: 'log', message: notice });
            sendMsg({ type: 'formation_pending', details, timestamp: Date.now() });

            pendingWatchdog = setTimeout(() => {
              if (isPending) {
                resumeTask('大模型编队决策超时 (75s)，自动恢复 MAA 兜底执行');
              }
            }, 75000);
          }
        }

        // 5. 大地图路线规划拦截
        if (interactiveRoute && !isPending && isSubTaskEvent(msg)) {
          if (typeof details === 'string' && (details.includes('Stages-MapReady') || details.includes('Stages_default') || details.includes('StageSelect'))) {
            isPending = true;
            lib.stop(handle);
            const notice = `【路线节点感知】发现大地图分岔路，已暂停底层自动寻路，交由大模型自主决策！`;
            logs.push(notice);
            sendMsg({ type: 'log', message: notice });
            sendMsg({ type: 'node_pending', details, timestamp: Date.now() });

            pendingWatchdog = setTimeout(() => {
              if (isPending) {
                resumeTask('大模型路线决策超时 (75s)，自动恢复 MAA 兜底执行');
              }
            }, 75000);
          }
        }
      } catch {
        const rawLog = `[MaaCore Roguelike Msg ${msg}] ${String(details).slice(0, 120)}`;
        logs.push(rawLog);
        sendMsg({ type: 'log', message: rawLog });
      }
    });

    if (!handle) {
      sendMsg({
        type: 'done',
        ok: false,
        resultText: '创建 Asst 句柄失败。',
        logs: ['lib.create() 返回空句柄'],
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // 挂载 Win32 游戏窗口
    if (hwnd) {
      const hwndBigInt = typeof hwnd === 'bigint' ? hwnd : BigInt(hwnd);
      lib.attachWindow(
        handle,
        hwndBigInt,
        MAA_WIN32_SCREENCAP.DXGI_OR_GDI,
        MAA_WIN32_INPUT.SendMessageWithCursorPos,
        MAA_WIN32_INPUT.SendMessage,
      );
    }

    // 装载 MaaCore 官方资源
    if (maaResourceDir) {
      lib.loadResource(maaResourceDir);
    }

    // 注入 Roguelike 任务
    const taskId = lib.appendTask(handle, 'Roguelike', taskPayload);

    if (taskId <= 0) {
      sendMsg({
        type: 'done',
        ok: false,
        resultText: '添加 Roguelike 任务失败，请检查参数或当前游戏画面是否处于肉鸽页面。',
        logs: [`appendTask 返回非法 taskId: ${taskId}`],
        durationMs: Date.now() - startTime,
      });
      return;
    }

    lib.start(handle);

    // 轮询直至任务结束或超时
    const pollInterval = 1000;
    const maxMs = maxMinutes * 60 * 1000;

    while (Date.now() - startTime < maxMs) {
      if (isPending) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (!lib.running(handle)) {
        break;
      }
      if (taskSuccess || taskFailed) {
        break;
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    lib.stop(handle);

    const isOk = taskSuccess || (!taskFailed && logs.length > 5);
    const resultText = taskSuccess
      ? `集成战略【${params.theme}】探索顺利达成！`
      : taskFailed
      ? `集成战略【${params.theme}】探索中止或中途失败。`
      : `集成战略【${params.theme}】流程执行结束。`;

    sendMsg({
      type: 'done',
      ok: isOk,
      resultText,
      logs,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    sendMsg({
      type: 'done',
      ok: false,
      resultText: `集成战略子进程运行异常: ${String(err)}`,
      logs: [`捕获未处理异常: ${String(err)}`],
      durationMs: Date.now() - startTime,
    });
  } finally {
    if (pendingWatchdog) {
      clearTimeout(pendingWatchdog);
    }
    if (handle && lib) {
      try {
        await Promise.race([
          lib.destroy(handle),
          new Promise((r) => setTimeout(r, 1000)),
        ]);
      } catch {}
    }
  }
}

process.on('message', async (msg: { type: string; payload: RoguelikeWorkerPayload }) => {
  if (msg?.type === 'start') {
    try {
      await runWorker(msg.payload);
    } finally {
      // 保证 IPC 消息发送缓冲写入后退出子进程
      setTimeout(() => process.exit(0), 50);
    }
  }
});

sendMsg({ type: 'info', message: 'Roguelike Worker 子进程就绪，等待启动载荷...' });
