/**
 * 基于经典 MaaCore.dll (Asst.h) 的原生战斗全权托管驱动：
 * 负责将 CopilotPlan 交付给 MAA 官方原版 C-API 执行。
 */
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMaaCoreDir, loadMaaCoreLib, type MaaCoreLib } from '../mfw/asst-ffi.ts';
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
 * 将 CopilotPlan 转交给 MaaCore 原生引擎全权托管执行
 */
export async function runMaaCoreCopilot(options: MaaCoreCopilotOptions): Promise<MaaCoreCopilotOutcome> {
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

  // 1. 将 plan 写入系统临时 JSON 文件供 MaaCore 读取
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

  // 2. 创建 Asst 实例与回调
  let taskSuccess = false;
  let taskFailed = false;
  let handle: unknown = null;

  try {
    handle = lib.create((msg: number, details: string) => {
      try {
        const parsed = details ? JSON.parse(details) : {};
        const detailStr = typeof parsed === 'object' ? JSON.stringify(parsed) : String(details);
        logs.push(`[MaaCore Msg ${msg}] ${detailStr.slice(0, 100)}`);
        if (details.includes('Failed') || details.includes('failed')) {
          taskFailed = true;
        } else if (details.includes('Accomplished') || details.includes('Completed') || details.includes('success')) {
          taskSuccess = true;
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
    // 3. 挂载窗口句柄
    if (hwnd) {
      try {
        const hwndVal = typeof hwnd === 'bigint' ? hwnd : BigInt(hwnd);
        const attached = lib.attachWindow(handle, hwndVal);
        logs.push(`挂载明日方舟窗口句柄 (${String(hwnd)})：${attached ? '成功' : '失败'}`);
        if (!attached) {
          throw new Error(`AsstAttachWindow 挂载窗口失败（句柄: ${String(hwnd)}）`);
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
    logs.push(`已将【${plan.stage_name}】作业注入原生队列（Task ID: ${taskId}），动作总数 ${plan.actions.length} 步。`);

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
    try { lib.destroy(handle); } catch {}
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    } catch {}
  }

  const durationMs = Date.now() - startTime;
  const ok = taskSuccess && !taskFailed;
  const resultText = ok ? '作战胜利（行动结束）' : '作战失败或已中断';

  logs.push(`MaaCore 战斗执行完毕，耗时 ${(durationMs / 1000).toFixed(1)} 秒，最终结果：${resultText}。`);

  return {
    ok,
    resultText,
    logs,
    durationMs,
  };
}
