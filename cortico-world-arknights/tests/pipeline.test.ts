import { describe, expect, it } from 'vitest';
import type {
  MaaControllerLike,
  MaaImageJobLike,
  MaaJobLike,
  MaaModule,
  MaaResourceLike,
  MaaTaskerLike,
  MaaTaskJobLike,
} from '../src/mfw/native.ts';
import { ArknightsPipeline } from '../src/mfw/pipeline.ts';
import { ArknightsRuntime } from '../src/mfw/runtime.ts';

function jobOk(): MaaJobLike {
  const job: MaaJobLike = { succeeded: true, status: 1, wait: async () => job };
  return job;
}

function taskJob(ok: boolean, status: number, nodes: number[]): MaaTaskJobLike {
  const job: MaaTaskJobLike = {
    id: 1,
    succeeded: ok,
    status,
    wait: async () => job,
    get: () => ({ nodes }),
  };
  return job;
}

class FakeController implements MaaControllerLike {
  connected = true;
  resolution: [number, number] = [1280, 720];
  post_connection(): MaaJobLike { return jobOk(); }
  post_click(): MaaJobLike { return jobOk(); }
  post_screencap(): MaaImageJobLike {
    const job: MaaImageJobLike = { wait: async () => job, get: () => null };
    return job;
  }
  destroy(): void {}
}

class FakeResource implements MaaResourceLike {
  loaded = true;
  bundles: string[] = [];
  post_ocr_model(): MaaJobLike { return jobOk(); }
  post_bundle(path: string): MaaJobLike {
    this.bundles.push(path);
    return jobOk();
  }
  destroy(): void {}
}

class FakeTasker implements MaaTaskerLike {
  resource: MaaResourceLike | null = null;
  controller: MaaControllerLike | null = null;
  mode: 'ok' | 'fail' | 'hang' = 'ok';
  calls: Array<{ entry: string; override: unknown }> = [];
  stops = 0;

  post_task(entry: string, override?: Record<string, unknown> | string): MaaTaskJobLike {
    this.calls.push({ entry, override });
    if (this.mode === 'hang') {
      const hanging: MaaTaskJobLike = {
        id: 9,
        succeeded: false,
        status: 0,
        wait: () => new Promise<MaaJobLike>(() => {}),
        get: () => ({ nodes: [] }),
      };
      return hanging;
    }
    return taskJob(this.mode === 'ok', this.mode === 'ok' ? 1 : 4000, [1, 2]);
  }

  post_stop(): MaaJobLike {
    this.stops += 1;
    return jobOk();
  }

  post_recognition(): MaaTaskJobLike {
    return taskJob(true, 1, [1]);
  }

  node_detail(id: number): unknown {
    return { name: `node-${id}` };
  }

  recognition_detail(): unknown {
    return null;
  }

  destroy(): void {}
}

function newRuntime(): { runtime: ArknightsRuntime; resource: FakeResource; tasker: FakeTasker } {
  const resource = new FakeResource();
  const tasker = new FakeTasker();
  // 用普通函数当构造器：`new` 调用时返回对象，正好喂给 runtime。
  const maa = {
    Win32Controller: function Win32Controller() {},
    Resource: function Resource() { return resource; },
    Tasker: function Tasker() { return tasker; },
  } as unknown as MaaModule;
  const runtime = new ArknightsRuntime(maa, new FakeController(), () => {}, 'C:/models', 'C:/pkg/assets/resource');
  return { runtime, resource, tasker };
}

describe('pipeline 运行时', () => {
  it('ensureBundle 只加载一次，并指向包内资源根', async () => {
    const { runtime, resource } = newRuntime();
    const first = await runtime.ensureBundle();
    const second = await runtime.ensureBundle();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(resource.bundles).toEqual(['C:/pkg/assets/resource']);
    expect(runtime.pipelineReady).toBe(true);
  });

  it('run 透传入口与 override，并把节点名折成轨迹', async () => {
    const { runtime, tasker } = newRuntime();
    await runtime.ensureBundle();
    const pipeline = new ArknightsPipeline(runtime);

    const override = { 'NavResource@FindStage': { expected: '^CE-5$' } };
    const result = await pipeline.run('NavResource@Begin', override);
    expect(result.ok).toBe(true);
    expect(tasker.calls[0]).toEqual({ entry: 'NavResource@Begin', override });
    expect(result.trace).toEqual(['node-1', 'node-2']);
  });

  it('失败任务返回状态码与轨迹，不抛错', async () => {
    const { runtime, tasker } = newRuntime();
    await runtime.ensureBundle();
    tasker.mode = 'fail';
    const result = await new ArknightsPipeline(runtime).run('X', {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(4000);
    expect(result.error).toContain('4000');
    expect(result.trace).toHaveLength(2);
  });

  it('超时后调用 post_stop，避免引擎继续点击', async () => {
    const { runtime, tasker } = newRuntime();
    await runtime.ensureBundle();
    tasker.mode = 'hang';
    const result = await new ArknightsPipeline(runtime).run('X', {}, 30);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有正常结束');
    expect(tasker.stops).toBe(1);
  });

  it('同一时间只允许一个任务', async () => {
    const { runtime, tasker } = newRuntime();
    await runtime.ensureBundle();
    tasker.mode = 'hang';
    const pipeline = new ArknightsPipeline(runtime);
    const first = pipeline.run('X', {}, 40);
    const second = await pipeline.run('Y', {});
    expect(second.error).toContain('已有一个 pipeline 任务');
    await first;
  });
});
