/**
 * 基于经典 MaaCore.dll (Asst.h) 的原生战斗全权托管驱动：
 * 负责将 CopilotPlan 交付给 MAA 官方原版 C-API 执行。
 *
 * 现已支持【子进程安全隔离模式】：
 * 将外部动态库加载与原生调用移入独立 Node 子进程中执行，彻底杜绝主进程环境变量污染与
 * 0xC0000374 / 0xC0000005 堆损坏/访问违规对桌宠宿主进程的崩溃影响。
 */
import { fork } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMaaCoreDir, loadMaaCoreLib, type MaaCoreLib, MAA_WIN32_INPUT, MAA_WIN32_SCREENCAP } from '../mfw/asst-ffi.ts';
import type { CopilotPlan } from './copilot.ts';

export function isMaaCoreBattleSupported(
  configuredMaaResourceDir?: string,
  libOverride?: MaaCoreLib | null,
): boolean {
  if (libOverride) return true;
  return findMaaCoreDir(configuredMaaResourceDir) !== null;
}

export interface MaaCoreCopilotOptions {
  readonly plan: CopilotPlan;
  readonly hwnd?: string | number | bigint | null;
  readonly maaResourceDir?: string;
  readonly maxSeconds?: number;
  readonly info?: (line: string) => void;
  readonly lib?: MaaCoreLib | null;
}

export interface MaaCoreCopilotOutcome {
  readonly ok: boolean;
  readonly resultText: string;
  readonly logs: string[];
  readonly durationMs: number;
}

/**
 * 统一执行入口：
 * - 当测试注入 mock lib 时，走进程内直接执行（保持测试高效且无需子进程）；
 * - 生产环境中无 injectedLib 时，一律走独立的子进程 Worker 隔离运行。
 */
export async function runMaaCoreCopilot(options: MaaCoreCopilotOptions): Promise<MaaCoreCopilotOutcome> {
  if (options.lib !== undefined && options.lib !== null) {
    return runMaaCoreCopilotDirect(options);
  }
  return runMaaCoreCopilotSubprocess(options);
}

/**
 * 子进程安全隔离执行器：
 * 调起 copilot-worker.ts，主进程通过 IPC 收集日志与战果，实现崩溃免疫。
 */
export async function runMaaCoreCopilotSubprocess(options: MaaCoreCopilotOptions): Promise<MaaCoreCopilotOutcome> {
  const { plan, hwnd, maaResourceDir, maxSeconds = 180, info } = options;
  const logs: string[] = [];
  const startTime = Date.now();

  const workerPath = fileURLToPath(new URL('./copilot-worker.ts', import.meta.url));

  return new Promise((resolve) => {
    let settled = false;
    let finalOutcome: MaaCoreCopilotOutcome | null = null;

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
        resultText: `无法启动 MaaCore 子进程: ${String(e)}`,
        logs: [`启动子进程异常: ${String(e)}`],
        durationMs: Date.now() - startTime,
      });
      return;
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch {}
        logs.push(`MaaCore 子进程超过最大时限（${maxSeconds}秒），已强制终止。`);
        resolve({
          ok: false,
          resultText: '战斗超时已强制终止',
          logs,
          durationMs: Date.now() - startTime,
        });
      }
    }, (maxSeconds + 5) * 1000);

    child.on('message', (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'log') {
        logs.push(msg.message);
      } else if (msg.type === 'info') {
        if (info) info(msg.message);
      } else if (msg.type === 'done') {
        finalOutcome = {
          ok: msg.ok,
          resultText: msg.resultText,
          logs: msg.logs || logs,
          durationMs: msg.durationMs || (Date.now() - startTime),
        };
      }
    });

    child.on('error', (err: any) => {
      logs.push(`MaaCore 子进程通信错误: ${String(err)}`);
    });

    child.on('exit', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      const durationMs = Date.now() - startTime;
      if (finalOutcome) {
        resolve(finalOutcome);
        return;
      }

      const unsignedCode = code !== null ? (code >>> 0) : null;
      const hexCode = unsignedCode !== null ? '0x' + unsignedCode.toString(16).toUpperCase() : 'null';
      const isCrash = unsignedCode === 0xC0000374 || unsignedCode === 0xC0000005;

      let crashDetail = `子进程退出 (代码: ${code} / ${hexCode}, 信号: ${signal || 'none'})`;
      if (isCrash) {
        crashDetail = `【安全保护】MaaCore 原生底层发生致命异常 [${hexCode}]（已由子进程安全隔离拦截，桌宠未受任何波及）。`;
      }
      logs.push(crashDetail);

      resolve({
        ok: false,
        resultText: isCrash ? 'MaaCore 底层异常（已安全隔离拦截）' : 'MaaCore 子进程异常结束',
        logs,
        durationMs,
      });
    });

    // 序列化传递参数
    const hwndStr = hwnd !== undefined && hwnd !== null ? String(hwnd) : null;
    child.send({
      plan,
      hwnd: hwndStr,
      maaResourceDir,
      maxSeconds,
    });
  });
}

/**
 * 进程内直接执行（单测 Mock 注入场景）
 */
export async function runMaaCoreCopilotDirect(options: MaaCoreCopilotOptions): Promise<MaaCoreCopilotOutcome> {
  const { plan, hwnd, maaResourceDir, maxSeconds = 180, info, lib: injectedLib } = options;
  const logs: string[] = [];
  const startTime = Date.now();

  const lib = injectedLib !== undefined ? injectedLib : loadMaaCoreLib(maaResourceDir);
  if (!lib) {
    return {
      ok: false,
      resultText: '启动失败：未找到或无法加载 MaaCore.dll。',
      logs: ['未能加载 MaaCore.dll 原生动态库，请检查 MAA 安装目录。'],
      durationMs: 0,
    };
  }

  logs.push(`【执行引擎：MaaCore 原生全权托管 (v${lib.version})】已直连官方原生引擎`);
  if (info) info(`MaaCore 启动战斗托管：关卡 ${plan.stage_name}，核心版本 ${lib.version}`);

  const tempFile = join(tmpdir(), `maa_copilot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  try {
    writeFileSync(tempFile, JSON.stringify(plan, null, 2), 'utf8');
  } catch (e) {
    return {
      ok: false,
      resultText: '启动失败：无法生成临时作业文件。',
      logs: [`写入临时作业文件失败：${String(e)}`],
      durationMs: 0,
    };
  }

  let taskSuccess = false;
  let taskFailed = false;
  let resolutionError = false;
  let handle: unknown = null;

  try {
    handle = lib.create((msg: number, details: string) => {
      try {
        const parsed = details ? JSON.parse(details) : {};
        const detailStr = typeof parsed === 'object' ? JSON.stringify(parsed) : String(details);
        logs.push(`[MaaCore Msg ${msg}] ${detailStr.slice(0, 100)}`);
        if (details.includes('UnsupportedResolution') || details.includes('Not 16:9')) {
          resolutionError = true;
          taskFailed = true;
        } else if (msg === 10000) {
          // 根任务链错误 (TaskChainError=10000)
          taskFailed = true;
        } else if (msg === 10002 || msg === 3) {
          // 任务链正常完成 (TaskChainCompleted=10002) 或全部任务完成 (AllTasksCompleted=3)
          taskSuccess = true;
        } else if (details.includes('Accomplished') || details.includes('Completed') || details.includes('success')) {
          taskSuccess = true;
        } else if (details.includes('Failed') || details.includes('failed')) {
          if (!details.includes('BattleStartPre')) {
            taskFailed = true;
          }
        }
      } catch {
        logs.push(`[MaaCore Msg ${msg}] ${details.slice(0, 80)}`);
      }
    });
  } catch (e) {
    try { if (existsSync(tempFile)) unlinkSync(tempFile); } catch {}
    return {
      ok: false,
      resultText: '启动失败：AsstCreateEx 创建实例异常。',
      logs: [`创建 MaaCore 实例抛错：${String(e)}`],
      durationMs: 0,
    };
  }

  if (!handle) {
    try { if (existsSync(tempFile)) unlinkSync(tempFile); } catch {}
    return {
      ok: false,
      resultText: '启动失败：AsstCreate 创建实例返回 null。',
      logs: ['MaaCore 实例句柄创建返回 null。'],
      durationMs: 0,
    };
  }

  try {
    if (hwnd) {
      try {
        const hwndVal = typeof hwnd === 'bigint' ? hwnd : BigInt(hwnd);
        const attached = lib.attachWindow(
          handle,
          hwndVal,
          MAA_WIN32_SCREENCAP.DXGI_OR_GDI,
          MAA_WIN32_INPUT.SendMessageWithCursorPos,
          MAA_WIN32_INPUT.SendMessage,
        );
        logs.push(`挂载明日方舟窗口句柄 (${String(hwnd)})：${attached ? '成功' : '失败'}（模式：DXGI+GDI / SendMessageWithCursorPos）`);
        if (!attached) {
          throw new Error(`AsstAttachWindow 挂载窗口失败（句柄: ${String(hwnd)}）${resolutionError ? '：窗口分辨率不是 16:9' : ''}`);
        }
      } catch (e) {
        logs.push(`挂载窗口句柄异常：${String(e)}`);
        throw e;
      }
    }

    const taskId = lib.appendTask(handle, 'Copilot', {
      filename: tempFile,
      formation: false,
    });
    logs.push(`已将【${plan.stage_name}】作业注入原生队列（Task ID: ${taskId}），动作总数 ${plan.actions.length} 步。`);

    const started = lib.start(handle);
    if (!started) {
      throw new Error('AsstStart 返回失败');
    }

    logs.push('MaaCore 战斗任务已开始运行，等待战场结算...');

    const pollStart = Date.now();
    while (Date.now() - pollStart < maxSeconds * 1000) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!lib.running(handle)) {
        logs.push('MaaCore 引擎汇报任务已结束。');
        break;
      }
    }

    if (lib.running(handle)) {
      logs.push(`达到最大限制时长（${maxSeconds}秒），停止战斗任务。`);
      lib.stop(handle);
    }
  } catch (error) {
    logs.push(`MaaCore 运行发生异常：${String(error)}`);
    try { lib.stop(handle); } catch {}
  } finally {
    try { await lib.destroy(handle); } catch {}
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    } catch {}
  }

  const durationMs = Date.now() - startTime;
  const ok = taskSuccess && !taskFailed;
  let resultText = ok ? '作战胜利（行动结束）' : '作战失败或已中断';
  if (!ok && resolutionError) {
    resultText = '窗口分辨率非 16:9，MaaCore 拒绝挂载';
  }

  logs.push(`MaaCore 战斗执行完毕，耗时 ${(durationMs / 1000).toFixed(1)} 秒，最终结果：${resultText}。`);

  return {
    ok,
    resultText,
    logs,
    durationMs,
  };
}
