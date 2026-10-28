/**
 * Pipeline 执行：只负责把一个入口节点跑完，并把执行轨迹折成可读的节点名。
 *
 * 超时必须 `post_stop`：引擎在 `wait()` 之外还会继续点，回执返回失败后不能让它在后台动游戏。
 */
import type { MaaTaskJobLike, MaaTaskerLike } from './native.ts';
import type { ArknightsRuntime } from './runtime.ts';
import { errorText, withTimeout } from './timeout.ts';

const RUN_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;
const MAX_TRACE = 24;

export interface PipelineResult {
  readonly ok: boolean;
  readonly status: number | null;
  /** 已执行节点的原始名字，按发生顺序；空数组表示绑定没给出节点明细。 */
  readonly trace: string[];
  readonly error?: string;
}

export class ArknightsPipeline {
  private running = false;

  constructor(private readonly runtime: ArknightsRuntime) {}

  get busy(): boolean {
    return this.running;
  }

  async run(
    entry: string,
    overrides: Record<string, unknown>,
    timeoutMs: number = RUN_TIMEOUT_MS,
  ): Promise<PipelineResult> {
    if (this.running) {
      return { ok: false, status: null, trace: [], error: '已有一个 pipeline 任务在执行，稍后再试。' };
    }

    const tasker = this.runtime.taskerInstance;
    if (!tasker) {
      return { ok: false, status: null, trace: [], error: 'pipeline 不可用：原生模块或 Tasker 还没初始化。' };
    }
    if (typeof tasker.post_task !== 'function') {
      return {
        ok: false,
        status: null,
        trace: [],
        error: 'pipeline 不可用：当前 @maaxyz/maa-node 的 Tasker 没有提供 post_task。',
      };
    }

    this.running = true;
    try {
      let job: MaaTaskJobLike;
      try {
        job = tasker.post_task(entry, overrides);
      } catch (error) {
        return { ok: false, status: null, trace: [], error: `启动 pipeline 失败：${errorText(error)}` };
      }

      let done: MaaTaskJobLike;
      try {
        // 绑定的 `wait()` 声明返回 `MaaJobLike`，实际返回的就是同一个任务对象；
        // 断言回 `MaaTaskJobLike` 才能取节点明细。
        done = (await withTimeout(Promise.resolve(job.wait()), timeoutMs, '执行 pipeline')) as MaaTaskJobLike;
      } catch (error) {
        // 超时或绑定抛错：先停掉引擎，避免它在回执之后继续点击。
        await this.stop();
        return { ok: false, status: null, trace: [], error: `pipeline 没有正常结束：${errorText(error)}` };
      }

      const trace = this.traceOf(tasker, done);
      return {
        ok: done.succeeded,
        status: typeof done.status === 'number' ? done.status : null,
        trace,
        ...(done.succeeded ? {} : { error: `pipeline 返回失败（状态码 ${String(done.status)}）。` }),
      };
    } finally {
      this.running = false;
    }
  }

  /** 超时兜底；没有 `post_stop` 时无从下手，交给上层如实回报。 */
  async stop(): Promise<void> {
    const tasker = this.runtime.taskerInstance;
    if (!tasker || typeof tasker.post_stop !== 'function') return;
    try {
      await withTimeout(Promise.resolve(tasker.post_stop().wait()), STOP_TIMEOUT_MS, '停止 pipeline');
    } catch {
      // 停止本身失败没有后续可做，保留原始失败原因更有意义。
    }
  }

  /**
   * 从任务明细里拿节点名。形状随绑定版本变动，取不到就返回空数组——
   * 轨迹是加分项，不该让一次成功的导航变成失败。
   */
  private traceOf(tasker: MaaTaskerLike, job: MaaTaskJobLike): string[] {
    try {
      const task = job.get();
      const nodes = (task as { nodes?: unknown } | null)?.nodes;
      if (!Array.isArray(nodes)) return [];
      const names: string[] = [];
      for (const id of nodes.slice(0, MAX_TRACE)) {
        if (typeof id !== 'number') continue;
        try {
          const detail = tasker.node_detail(id) as { name?: unknown } | null;
          if (detail && typeof detail.name === 'string' && detail.name.trim() !== '') {
            names.push(detail.name.trim());
          }
        } catch {
          // 单个节点取不到名字不影响其它节点。
        }
      }
      return names;
    } catch {
      return [];
    }
  }
}
