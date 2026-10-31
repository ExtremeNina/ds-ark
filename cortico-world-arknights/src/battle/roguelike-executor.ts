/**
 * 基于经典 MaaCore.dll (Asst.h) 的集成战略全权托管执行调度器
 * 支持进程级安全隔离执行与实时结果聚合
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findMaaCoreDir, type MaaCoreLib, MAA_WIN32_INPUT, MAA_WIN32_SCREENCAP } from '../mfw/asst-ffi.ts';
import { normalizeRoleName, normalizeRoguelikeMode, normalizeSquadName, type RoguelikeTaskParams } from './roguelike.ts';
import type { RoguelikeWorkerMessage } from './roguelike-worker.ts';

export interface RoguelikeControl {
  resume(): void;
  kill(): void;
}

export interface RoguelikeExecutionOptions {
  readonly params: RoguelikeTaskParams;
  readonly hwnd?: string | number | bigint | null;
  readonly maaResourceDir?: string;
  readonly maxMinutes?: number;
  readonly info?: (line: string) => void;
  readonly libOverride?: MaaCoreLib | null;
  readonly onSquadPending?: (details?: string) => void;
  readonly onTicketPending?: (details?: string) => void;
  readonly onNodePending?: (details?: string) => void;
  readonly onRecruitPending?: (details?: string) => void;
  readonly onFormationPending?: (details?: string) => void;
  readonly onWorkerReady?: (control: RoguelikeControl) => void;
}

export interface RoguelikeExecutionOutcome {
  readonly ok: boolean;
  readonly resultText: string;
  readonly logs: string[];
  readonly durationMs: number;
}

/** 直接在进程内执行（用于单元测试注入 mock lib） */
export async function runRoguelikeDirect(options: RoguelikeExecutionOptions): Promise<RoguelikeExecutionOutcome> {
  const {
    params,
    hwnd,
    maaResourceDir,
    maxMinutes = 45,
    info,
    libOverride,
    onSquadPending,
    onTicketPending,
    onNodePending,
    onRecruitPending,
    onFormationPending,
    onWorkerReady,
  } = options;
  const logs: string[] = [];
  const startTime = Date.now();

  const lib = libOverride;
  if (!lib) {
    return {
      ok: false,
      resultText: '未提供有效 lib 实例',
      logs: ['直接执行模式必须注入 libOverride'],
      durationMs: 0,
    };
  }

  info?.(`MaaCore 启动集成战略托管（直接模式）：主题【${params.theme}】`);
  logs.push(`【集成战略引擎：MaaCore 原生 (直接模式)】主题: ${params.theme}`);

  let taskSuccess = false;
  let taskFailed = false;

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

  const handle = lib.create((msg: number, details: string) => {
    logs.push(`[MaaCore Msg ${msg}] ${details}`);
    if (msg === ASST_MSG.TaskChainError) taskFailed = true;
    if (msg === ASST_MSG.TaskChainCompleted || msg === ASST_MSG.AsyncCallInfo) taskSuccess = true;

    if (params.interactive_squad !== false && isSubTaskEvent(msg)) {
      if (typeof details === 'string' && (details.includes('Squad') || details.includes('ChooseSquad'))) {
        onSquadPending?.(details);
      }
    }

    if (params.interactive_ticket !== false && isSubTaskEvent(msg)) {
      if (
        typeof details === 'string' &&
        (details.includes('GetDropRecruit') ||
          details.includes('GetDropSelect') ||
          details.includes('RecruitTicket') ||
          details.includes('InitialDrop'))
      ) {
        onTicketPending?.(details);
      }
    }

    if (params.interactive_recruit !== false && isSubTaskEvent(msg)) {
      if (
        typeof details === 'string' &&
        (details.includes('Recruit') || details.includes('ChooseOper') || details.includes('RoguelikeRecruitTaskPlugin'))
      ) {
        onRecruitPending?.(details);
      }
    }

    if (params.interactive_formation !== false && isSubTaskEvent(msg)) {
      if (
        typeof details === 'string' &&
        (details.includes('Page-Combat') ||
          details.includes('QuickFormation') ||
          details.includes('RoguelikeFormationTaskPlugin') ||
          details.includes('StageEnterBattle'))
      ) {
        onFormationPending?.(details);
      }
    }

    if (params.interactive_route !== false && isSubTaskEvent(msg)) {
      if (typeof details === 'string' && (details.includes('Stages') || details.includes('StageSelect'))) {
        onNodePending?.(details);
      }
    }
  });

  if (hwnd) {
    const hwndVal = typeof hwnd === 'bigint' ? hwnd : BigInt(hwnd);
    lib.attachWindow(
      handle,
      hwndVal,
      MAA_WIN32_SCREENCAP.DXGI_OR_GDI,
      MAA_WIN32_INPUT.SendMessageWithCursorPos,
      MAA_WIN32_INPUT.SendMessage,
    );
  }

  if (maaResourceDir) {
    lib.loadResource(maaResourceDir);
  }

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
  if (normalizedSquad) taskPayload.squad = normalizedSquad;
  if (normalizedRoles) taskPayload.roles = normalizedRoles;
  if (params.core_char) taskPayload.core_char = params.core_char;

  lib.appendTask(handle, 'Roguelike', taskPayload);
  lib.start(handle);

  onWorkerReady?.({
    resume: () => {
      lib.appendTask(handle, 'Roguelike', taskPayload);
      lib.start(handle);
    },
    kill: () => {
      lib.stop(handle);
    },
  });

  const pollInterval = 100;
  const maxMs = maxMinutes * 60 * 1000;
  while (Date.now() - startTime < maxMs) {
    if (!lib.running(handle)) break;
    if (taskSuccess || taskFailed) break;
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  lib.stop(handle);

  const isOk = taskSuccess || (!taskFailed && logs.length > 0);
  return {
    ok: isOk,
    resultText: isOk ? `集成战略【${params.theme}】执行完成` : `集成战略【${params.theme}】中途失败`,
    logs,
    durationMs: Date.now() - startTime,
  };
}

/** 生产环境：独立子进程安全隔离执行 */
export async function runRoguelikeSubprocess(options: RoguelikeExecutionOptions): Promise<RoguelikeExecutionOutcome> {
  const {
    params,
    hwnd,
    maaResourceDir,
    maxMinutes = 45,
    info,
    onRecruitPending,
    onSquadPending,
    onTicketPending,
    onNodePending,
    onFormationPending,
    onWorkerReady,
  } = options;
  const logs: string[] = [];
  const startTime = Date.now();

  const workerPath = fileURLToPath(new URL('./roguelike-worker.ts', import.meta.url));

  return new Promise((resolve) => {
    let settled = false;
    let finalOutcome: RoguelikeExecutionOutcome | null = null;

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    };

    let child: ReturnType<typeof fork>;
    try {
      child = fork(workerPath, [], {
        env,
        execArgv: ['--experimental-strip-types'],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
    } catch (e) {
      resolve({
        ok: false,
        resultText: `无法启动 Roguelike 子进程: ${String(e)}`,
        logs: [`启动子进程异常: ${String(e)}`],
        durationMs: Date.now() - startTime,
      });
      return;
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch {}
        logs.push(`Roguelike 子进程超过最大时限（${maxMinutes}分钟），已强制终止。`);
        resolve({
          ok: false,
          resultText: '探索超时已强制终止',
          logs,
          durationMs: Date.now() - startTime,
        });
      }
    }, maxMinutes * 60 * 1000);

    onWorkerReady?.({
      resume: () => {
        try {
          child.send({ type: 'resume' });
        } catch {}
      },
      kill: () => {
        try {
          child.send({ type: 'kill' });
        } catch {}
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, 300);
      },
    });

    child.on('message', (msg: RoguelikeWorkerMessage) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'log') {
        logs.push(msg.message);
      } else if (msg.type === 'info') {
        info?.(msg.message);
      } else if (msg.type === 'recruit_pending') {
        onRecruitPending?.(msg.details);
      } else if (msg.type === 'ticket_pending') {
        onTicketPending?.(msg.details);
      } else if (msg.type === 'squad_pending') {
        onSquadPending?.(msg.details);
      } else if (msg.type === 'formation_pending') {
        onFormationPending?.(msg.details);
      } else if (msg.type === 'node_pending') {
        onNodePending?.(msg.details);
      } else if (msg.type === 'done') {
        finalOutcome = {
          ok: msg.ok,
          resultText: msg.resultText,
          logs: msg.logs.length > 0 ? msg.logs : logs,
          durationMs: msg.durationMs,
        };
        // 若子进程已汇报 done，启动安全保底，避免子进程退出死锁挂起
        setTimeout(() => {
          if (!settled) {
            try { child.kill('SIGTERM'); } catch {}
            setTimeout(() => {
              if (!settled) {
                try { child.kill('SIGKILL'); } catch {}
              }
            }, 500);
          }
        }, 1500);
      }
    });

    child.on('error', (err) => {
      logs.push(`Roguelike 子进程错误: ${String(err)}`);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (finalOutcome) {
        resolve(finalOutcome);
        return;
      }

      const isOk = code === 0;
      resolve({
        ok: isOk,
        resultText: isOk ? 'Roguelike 任务完成' : `Roguelike 子进程异常退出 (code: ${code}, signal: ${signal})`,
        logs,
        durationMs: Date.now() - startTime,
      });
    });

    // 触发子进程启动
    child.send({
      type: 'start',
      payload: {
        params,
        hwnd: typeof hwnd === 'bigint' ? hwnd.toString() : hwnd,
        maaResourceDir,
        maxMinutes,
      },
    });
  });
}

/** 统一集成战略执行入口 */
export async function executeRoguelike(options: RoguelikeExecutionOptions): Promise<RoguelikeExecutionOutcome> {
  if (options.libOverride) {
    return runRoguelikeDirect(options);
  }
  return runRoguelikeSubprocess(options);
}
