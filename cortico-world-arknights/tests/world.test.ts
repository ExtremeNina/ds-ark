import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCallContext, ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { ARKNIGHTS } from '../src/definition.ts';
import { ARKNIGHTS_CONFIG_GROUP, ARKNIGHTS_DEFAULTS } from '../src/config.ts';
import { ArknightsWorld } from '../src/world.ts';
import { ArknightsSession, resolveMethod } from '../src/mfw/session.ts';
import type { MaaControllerLike, MaaDesktopDevice, MaaImageJobLike, MaaJobLike, MaaModule } from '../src/mfw/native.ts';
import { FakeHost } from './helpers/fake-host.ts';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function jobOf(succeeded: boolean, status = succeeded ? 1 : 0): MaaJobLike {
  const job: MaaJobLike = { succeeded, status, wait: async () => job };
  return job;
}

/** 记录点击的假控制器；截图固定返回一段 PNG 头字节。 */
class FakeController implements MaaControllerLike {
  static devices: readonly MaaDesktopDevice[] = [];
  static clicks: Array<[number, number]> = [];
  static created: FakeController[] = [];

  connected = false;
  readonly resolution: [number, number] | null = [1000, 400];
  readonly uuid = 'fake-uuid';

  constructor(
    readonly handle: string,
    readonly screencapMethod: string,
    readonly mouseMethod: string,
    readonly keyboardMethod: string,
  ) {
    FakeController.created.push(this);
  }

  static async find(): Promise<readonly MaaDesktopDevice[] | null> {
    return FakeController.devices;
  }

  post_connection(): MaaJobLike {
    this.connected = true;
    return jobOf(true);
  }

  post_click(x: number, y: number): MaaJobLike {
    FakeController.clicks.push([x, y]);
    return jobOf(true);
  }

  post_screencap(): MaaImageJobLike {
    let self: MaaImageJobLike;
    self = { wait: async () => self, get: () => PNG_BYTES };
    return self;
  }

  destroy(): void {
    this.connected = false;
  }
}

const fakeMaa: MaaModule = {
  Win32Controller: FakeController as unknown as MaaModule['Win32Controller'],
  Win32ScreencapMethod: { Background: '18', FramePool: '2', PrintWindow: '8' },
  Win32InputMethod: { SendMessage: '1', PostMessage: '2' },
};

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'arknights-world-'));
  FakeController.devices = [
    ['0x1', 'UnityWndClass', '明日方舟'],
    ['0x2', 'Notepad', '无标题 - 记事本'],
  ];
  FakeController.clicks = [];
  FakeController.created = [];
});

afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

function newWorld(maa: MaaModule = fakeMaa) {
  const ctx = fakeWorldContext(ARKNIGHTS, { scratchDir });
  const session = new ArknightsSession(async () => ({ ok: true, maa }));
  const world = new ArknightsWorld({ cfg: ctx.cfg, timezone: ctx.timezone, session });
  return { ctx, world, session };
}

function toolOf(world: ArknightsWorld, name: string) {
  const tool = world.tools().find((t) => t.name === name);
  if (!tool) throw new Error(`工具缺失：${name}`);
  return tool;
}

const call = {} as ToolCallContext;

function receipt(outcome: string | ToolOutcome): ToolOutcome {
  return typeof outcome === 'string' ? { text: outcome } : outcome;
}

describe('明日方舟 World', () => {
  it('干装载不报失败：默认配置即可构造', async () => {
    const report = await dryMountWorld(ARKNIGHTS, { scratchDir });
    expect(report.failures).toEqual([]);
    expect(ARKNIGHTS.defaults()).toMatchObject({ enabled: false, windowMatch: ARKNIGHTS_DEFAULTS.windowMatch });
  });

  it('默认配置里的嵌套对象不会被调用方改坏', () => {
    const first = ARKNIGHTS.defaults();
    first.pauseButton.x = 0.1;
    expect(ARKNIGHTS.defaults().pauseButton.x).toBe(ARKNIGHTS_DEFAULTS.pauseButton.x);
  });

  it('挂载时投一条 arknights.ready 事件，origin 是 internal', async () => {
    const { world } = newWorld();
    const host = new FakeHost();
    await world.start(host);
    expect(host.events.map((e) => e.type)).toEqual(['arknights.ready']);
    expect(host.events[0]?.origin).toBe('internal');
    expect(host.events[0]?.source).toBe('arknights');
    await world.stop();
  });

  it('tools() 与 describe.json 的工具、事件、环境提示词保持一致', () => {
    const described = JSON.parse(readFileSync(join(PACKAGE_DIR, 'describe.json'), 'utf8')) as {
      tools: Array<{ name: string }>;
      events: Array<{ type: string }>;
      prompts: Array<{ key: string; content: string }>;
    };
    const { world } = newWorld();
    expect(world.tools().map((t) => t.name).sort()).toEqual(described.tools.map((t) => t.name).sort());
    expect(ARKNIGHTS.describe?.events.map((e) => e.type)).toEqual(described.events.map((e) => e.type));

    const docs = world.webUi('zh').promptDocs ?? [];
    expect(docs.map((d) => d.key)).toEqual(described.prompts.map((p) => p.key));
    expect(readFileSync(docs[0]!.path, 'utf8')).toBe(described.prompts[0]!.content);
  });

  it('配置组声明的每个路径都能在 defaults() 里取到值', () => {
    const defaults = ARKNIGHTS.defaults() as unknown as Record<string, unknown>;
    const paths = Object.keys(ARKNIGHTS_CONFIG_GROUP.schema.properties);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const relative = path.replace('worlds.arknights.', '');
      const value = relative
        .split('.')
        .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], defaults);
      expect(value, `缺少默认值：${path}`).not.toBeUndefined();
    }
  });

  it('没有匹配窗口时 ark_connect 返回可读的失败回执', async () => {
    FakeController.devices = [['0x2', 'Notepad', '无标题 - 记事本']];
    const { world } = newWorld();
    const outcome = receipt(await toolOf(world, 'ark_connect').handler({}, call));
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toContain('明日方舟');
    expect(outcome.text).toContain('无标题 - 记事本');
  });

  it('未连接时截图与暂停都返回失败回执，而不是抛错', async () => {
    const { world } = newWorld();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['ark_screencap', {}],
      ['ark_set_paused', { paused: true }],
    ];
    for (const [name, args] of cases) {
      const outcome = receipt(await toolOf(world, name).handler(args, call));
      expect(outcome.failed, name).toBe(true);
      expect(outcome.text).toContain('ark_connect');
    }
  });

  it('连接成功后回执带窗口名与分辨率', async () => {
    const { world } = newWorld();
    const outcome = receipt(await toolOf(world, 'ark_connect').handler({}, call));
    expect(outcome.failed).toBeUndefined();
    expect(outcome.text).toContain('明日方舟');
    expect(outcome.text).toContain('1000×400');
    expect(FakeController.created[0]?.screencapMethod).toBe('18');
    expect(FakeController.created[0]?.mouseMethod).toBe('1');
  });

  it('截图回执带 PNG 附件与必填的 fallbackText', async () => {
    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);
    const outcome = receipt(await toolOf(world, 'ark_screencap').handler({}, call));
    expect(outcome.failed).toBeUndefined();
    expect(outcome.blobs).toHaveLength(1);
    const blob = outcome.blobs![0]!;
    if (!('bytes' in blob)) throw new Error('应当是新字节形式的附件');
    expect(blob.mime).toBe('image/png');
    expect(blob.bytes.byteLength).toBe(PNG_BYTES.byteLength);
    expect(blob.fallbackText).toContain('1000×400');
    expect(blob.name).toMatch(/^arknights-\d{8}-\d{6}\.png$/);
  });

  it('暂停按归一化坐标换算成像素后点击，并如实说明无法确认状态', async () => {
    const { ctx, world } = newWorld();
    Object.assign(ctx.cfg, { pauseButton: { x: 0.5, y: 0.25 } });
    await toolOf(world, 'ark_connect').handler({}, call);
    const outcome = receipt(await toolOf(world, 'ark_set_paused').handler({ paused: true }, call));
    expect(outcome.failed).toBeUndefined();
    expect(FakeController.clicks).toEqual([[500, 100]]);
    expect(outcome.text).toContain('已向 (500, 100) 发送一次点击');
    expect(outcome.text).toContain('无法确认');
  });

  it('坐标热改后下一次点击立即按新值换算', async () => {
    const { ctx, world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);
    ctx.persist({ pauseButton: { x: 0, y: 1 } });
    await toolOf(world, 'ark_set_paused').handler({ paused: false }, call);
    expect(FakeController.clicks).toEqual([[0, 399]]);
  });

  it('参数不是布尔值时拒绝执行，也不发点击', async () => {
    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);
    const outcome = receipt(await toolOf(world, 'ark_set_paused').handler({ paused: 'yes' }, call));
    expect(outcome.failed).toBe(true);
    expect(FakeController.clicks).toEqual([]);
  });

  it('原生加载失败时工具报原因，而不是让 World 构造失败', async () => {
    const ctx = fakeWorldContext(ARKNIGHTS, { scratchDir });
    const session = new ArknightsSession(async () => ({ ok: false, error: '缺少 @maaxyz/maa-node：测试用错因' }));
    const world = new ArknightsWorld({ cfg: ctx.cfg, timezone: ctx.timezone, session });
    const outcome = receipt(await toolOf(world, 'ark_connect').handler({}, call));
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toContain('缺少 @maaxyz/maa-node');
  });

  it('截图方式名按绑定表换算，Default 与未知值退到兜底项', () => {
    const table = { Background: '18', PrintWindow: '8' };
    expect(resolveMethod(table, 'PrintWindow', 'Background')).toBe('8');
    expect(resolveMethod(table, 'Default', 'Background')).toBe('18');
    expect(resolveMethod(table, '不存在的名字', 'Background')).toBe('18');
    expect(resolveMethod(undefined, 'PrintWindow', 'Background')).toBe('0');
  });
});
