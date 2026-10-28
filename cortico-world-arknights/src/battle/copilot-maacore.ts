/**
 * MaaCore 原生战斗全权托管驱动：
 * 负责将 CopilotPlan 交付给 MaaFramework 原生 Tasker / Resource 引擎执行。
 */
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MaaResourceLike, MaaTaskerLike } from '../mfw/native.ts';
import { withTimeout } from '../mfw/timeout.ts';
import type { CopilotPlan } from './copilot.ts';

const COMMON_MAA_RESOURCE_PATHS = [
  'C:/Program Files/MAA/resource',
  'D:/Program Files/MAA/resource',
  'C:/MAA/resource',
  'D:/MAA/resource',
  'E:/MAA/resource',
  'C:/Program Files (x86)/MAA/resource',
];

/**
 * 探测可用的 MAA 完整官方资源目录。
 * 1. 优先使用配置项传入的路径；
 * 2. 依次探测常见盘符安装路径。
 */
export function findMaaResourceDir(configuredDir?: string): string | null {
  if (configuredDir && configuredDir.trim()) {
    const candidate = configuredDir.trim();
    if (isValidMaaResource(candidate)) return candidate;
  }

  for (const candidate of COMMON_MAA_RESOURCE_PATHS) {
    if (isValidMaaResource(candidate)) return candidate;
  }

  return null;
}

function isValidMaaResource(dir: string): boolean {
  if (!existsSync(dir)) return false;
  // 必须具备 pipeline 或 image 目录
  const hasPipeline = existsSync(join(dir, 'pipeline'));
  const hasImage = existsSync(join(dir, 'image'));
  return hasPipeline || hasImage;
}

/** 检查当前环境是否具备 MaaCore 原生战斗托管能力 */
export function isMaaCoreBattleSupported(
  tasker: MaaTaskerLike | null,
  resource: MaaResourceLike | null,
  configuredMaaResourceDir?: string,
): boolean {
  if (!tasker || !resource) return false;
  if (typeof tasker.post_task !== 'function') return false;
  const resDir = findMaaResourceDir(configuredMaaResourceDir);
  return resDir !== null;
}

export interface MaaCoreCopilotOptions {
  readonly plan: CopilotPlan;
  readonly tasker: MaaTaskerLike;
  readonly resource: MaaResourceLike;
  readonly maaResourceDir?: string;
  readonly maxSeconds?: number;
  readonly info?: (line: string) => void;
}

export interface MaaCoreCopilotOutcome {
  readonly ok: boolean;
  readonly resultText: string;
  readonly logs: string[];
  readonly durationMs: number;
}

/**
 * 将 CopilotPlan 转交给 MaaCore 全权托管执行
 */
export async function runMaaCoreCopilot(options: MaaCoreCopilotOptions): Promise<MaaCoreCopilotOutcome> {
  const { plan, tasker, resource, maaResourceDir, maxSeconds = 180, info } = options;
  const logs: string[] = [];
  const startTime = Date.now();

  const resDir = findMaaResourceDir(maaResourceDir);
  if (!resDir) {
    return {
      ok: false,
      resultText: '启动失败：未找到 MAA 完整官方资源包。',
      logs: ['未检测到可用的 MAA 资源目录，请在配置项 worlds.arknights.maaResourceDir 中指定。'],
      durationMs: 0,
    };
  }

  logs.push(`【执行引擎：MaaCore 原生全权托管】已载入 MAA 资源：${resDir}`);
  if (info) info(`MaaCore 启动战斗托管：关卡 ${plan.stage_name}，资源自 ${resDir}`);

  // 1. 若外部资源尚未加载，则通过 post_bundle 加载
  if (typeof resource.post_bundle === 'function') {
    try {
      const loadJob = await withTimeout(
        Promise.resolve(resource.post_bundle(resDir).wait()),
        15_000,
        '加载 MAA 战斗资源',
      );
      if (!loadJob.succeeded) {
        logs.push(`警告：加载 MAA 资源包状态码非零（${loadJob.status}），尝试继续派发任务。`);
      }
    } catch (e) {
      logs.push(`警告：加载外部 MAA 资源包超时或异常（${String(e)}）。`);
    }
  }

  // 2. 将 plan 写入系统临时 JSON 文件供 MaaCore 读取
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

  // 3. 注册 Tasker Sink 监听实时战斗事件
  let sinkId: number | null = null;
  if (typeof tasker.add_sink === 'function') {
    try {
      sinkId = tasker.add_sink((msg, detail) => {
        const detailStr = detail ? JSON.stringify(detail) : '';
        if (msg.includes('Task') || msg.includes('Node') || msg.includes('Action') || msg.includes('Copilot')) {
          logs.push(`[MaaCore] ${msg}${detailStr ? `: ${detailStr.slice(0, 120)}` : ''}`);
        }
      });
    } catch {
      // 容错：sink 注册失败不影响主任务派发
    }
  }

  // 4. 派发 Copilot 任务并等待
  let taskSuccess = false;
  let taskStatus: number | null = null;
  logs.push(`已将【${plan.stage_name}】作业派发至 MaaCore，动作总数 ${plan.actions.length} 步，最大限制 ${maxSeconds} 秒。`);

  try {
    if (typeof tasker.post_task !== 'function') {
      throw new Error('当前 Tasker 不支持 post_task。');
    }

    const job = tasker.post_task('Copilot', {
      filename: tempFile,
      formation: false,
    });

    const done = await withTimeout(
      Promise.resolve(job.wait()),
      maxSeconds * 1000,
      'MaaCore 战斗托管执行',
    );

    taskSuccess = done.succeeded;
    taskStatus = done.status;
  } catch (error) {
    logs.push(`MaaCore 任务中断或超时：${String(error)}`);
    if (typeof tasker.post_stop === 'function') {
      try {
        await withTimeout(Promise.resolve(tasker.post_stop().wait()), 5000, '停止战斗托管');
      } catch {
        // ignore stop error
      }
    }
  } finally {
    // 清理 sink
    if (sinkId !== null && typeof tasker.remove_sink === 'function') {
      try {
        tasker.remove_sink(sinkId);
      } catch {
        // ignore
      }
    }
    // 清理临时文件
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    } catch {
      // ignore
    }
  }

  const durationMs = Date.now() - startTime;
  const resultText = taskSuccess
    ? '作战胜利（行动结束）'
    : `作战失败或已中断（状态码 ${String(taskStatus)}）`;

  logs.push(`MaaCore 战斗执行完毕，耗时 ${(durationMs / 1000).toFixed(1)} 秒，最终结果：${resultText}。`);

  return {
    ok: taskSuccess,
    resultText,
    logs,
    durationMs,
  };
}
