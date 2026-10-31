/**
 * MaaCore 独立子进程工作器 (Worker):
 * 运行在独立的 Node 进程中，负责加载外部 MaaCore.dll、挂载窗口并执行 Copilot 任务。
 *
 * 核心设计优势：
 * 1. 进程级隔离：所有的动态库加载与 PATH 环境变量修改都在子进程内完成，主进程零污染；
 * 2. 内存安全：即使 MaaCore.dll 内部发生 0xC0000374 (堆损坏) 或 0xC0000005 (访问违规)，
 *    也仅终止当前子进程，绝不波及 Coopanion 桌宠主进程；
 * 3. 干净回收：任务结束子进程退出，操作系统自动回收所有句柄和 DLL 映射。
 */
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMaaCoreLib, MAA_WIN32_INPUT, MAA_WIN32_SCREENCAP } from '../mfw/asst-ffi.ts';
import type { CopilotPlan } from './copilot.ts';

export interface WorkerPayload {
  readonly plan: CopilotPlan;
  readonly hwnd?: string | number | bigint | null;
  readonly maaResourceDir?: string;
  readonly maxSeconds?: number;
}

export type WorkerMessage =
  | { readonly type: 'log'; readonly message: string }
  | { readonly type: 'info'; readonly message: string }
  | {
      readonly type: 'done';
      readonly ok: boolean;
      readonly resultText: string;
      readonly logs: string[];
      readonly durationMs: number;
    }
  | { readonly type: 'error'; readonly error: string };

function sendMsg(msg: WorkerMessage): void {
  if (typeof process.send === 'function') {
    process.send(msg);
  }
}

async function runWorker(payload: WorkerPayload): Promise<void> {
  const { plan, hwnd, maaResourceDir, maxSeconds = 180 } = payload;
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

  const startMsg = `【执行引擎：MaaCore 原生全权托管 (v${lib.version})】已直连官方原生引擎 (子进程隔离模式)`;
  logs.push(startMsg);
  sendMsg({ type: 'log', message: startMsg });
  sendMsg({ type: 'info', message: `MaaCore 启动战斗托管：关卡 ${plan.stage_name}，核心版本 ${lib.version}` });

  // 1. 将 plan 写入系统临时 JSON 文件
  const tempFile = join(tmpdir(), `maa_copilot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  try {
    writeFileSync(tempFile, JSON.stringify(plan, null, 2), 'utf8');
  } catch (e) {
    sendMsg({
      type: 'done',
      ok: false,
      resultText: '启动失败：无法生成临时作业文件。',
      logs: [`写入临时作业文件失败：${String(e)}`],
      durationMs: 0,
    });
    return;
  }

  // 2. 创建 Asst 实例与回调
  let taskSuccess = false;
  let taskFailed = false;
  let resolutionError = false;
  let handle: unknown = null;

  try {
    handle = lib.create((msg: number, details: string) => {
      try {
        const parsed = details ? JSON.parse(details) : {};
        const detailStr = typeof parsed === 'object' ? JSON.stringify(parsed) : String(details);
        const logLine = `[MaaCore Msg ${msg}] ${detailStr.slice(0, 100)}`;
        logs.push(logLine);
        sendMsg({ type: 'log', message: logLine });

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
        const logLine = `[MaaCore Msg ${msg}] ${details.slice(0, 80)}`;
        logs.push(logLine);
        sendMsg({ type: 'log', message: logLine });
      }
    });
  } catch (e) {
    try { if (existsSync(tempFile)) unlinkSync(tempFile); } catch {}
    sendMsg({
      type: 'done',
      ok: false,
      resultText: '启动失败：AsstCreateEx 创建实例异常。',
      logs: [`创建 MaaCore 实例抛错：${String(e)}`],
      durationMs: 0,
    });
    return;
  }

  if (!handle) {
    try { if (existsSync(tempFile)) unlinkSync(tempFile); } catch {}
    sendMsg({
      type: 'done',
      ok: false,
      resultText: '启动失败：AsstCreate 创建实例返回 null。',
      logs: ['MaaCore 实例句柄创建返回 null。'],
      durationMs: 0,
    });
    return;
  }

  try {
    // 3. 挂载窗口句柄
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
        const attachMsg = `挂载明日方舟窗口句柄 (${String(hwnd)})：${attached ? '成功' : '失败'}（模式：DXGI+GDI / SendMessageWithCursorPos）`;
        logs.push(attachMsg);
        sendMsg({ type: 'log', message: attachMsg });
        if (!attached) {
          throw new Error(`AsstAttachWindow 挂载窗口失败（句柄: ${String(hwnd)}）${resolutionError ? '：窗口分辨率不是 16:9' : ''}`);
        }
      } catch (e) {
        logs.push(`挂载窗口句柄异常：${String(e)}`);
        throw e;
      }
    }

    // 4. 追加 Copilot 任务并启动
    const taskId = lib.appendTask(handle, 'Copilot', {
      filename: tempFile,
      formation: false,
    });
    const taskMsg = `已将【${plan.stage_name}】作业注入原生队列（Task ID: ${taskId}），动作总数 ${plan.actions.length} 步。`;
    logs.push(taskMsg);
    sendMsg({ type: 'log', message: taskMsg });

    const started = lib.start(handle);
    if (!started) {
      throw new Error('AsstStart 返回失败');
    }

    logs.push('MaaCore 战斗任务已开始运行，等待战场结算...');

    // 5. 轮询运行状态
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
  let resultText = ok ? '战斗流程已结束，等待结算画面裁决' : '作战失败或已中断';
  if (!ok && resolutionError) {
    resultText = '窗口分辨率非 16:9，MaaCore 拒绝挂载';
  }

  logs.push(`MaaCore 战斗执行完毕，耗时 ${(durationMs / 1000).toFixed(1)} 秒，最终结果：${resultText}。`);

  sendMsg({
    type: 'done',
    ok,
    resultText,
    logs,
    durationMs,
  });
}

// 监听主进程发来的执行参数
if (process.send) {
  process.on('message', async (payload: WorkerPayload) => {
    try {
      await runWorker(payload);
      process.exit(0);
    } catch (err) {
      sendMsg({ type: 'error', error: String(err) });
      process.exit(1);
    }
  });
} else {
  // 如果直接执行且带命令行参数（支持调试）
  const payloadStr = process.argv[2];
  if (payloadStr) {
    try {
      const payload = JSON.parse(payloadStr) as WorkerPayload;
      await runWorker(payload);
      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  }
}
