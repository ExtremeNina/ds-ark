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

/** 造一个只有 IHDR 头的 PNG：尺寸能被 pngSize 读出来，够用且不必塞真实图像。 */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

let imageBytes = pngHeader(1280, 720);

function jobOf(succeeded: boolean, status = succeeded ? 1 : 0): MaaJobLike {
  const job: MaaJobLike = { succeeded, status, wait: async () => job };
  return job;
}

/** 记录点击的假控制器；截图固定返回一段 PNG 头字节。 */
class FakeController implements MaaControllerLike {
  static devices: readonly MaaDesktopDevice[] = [];
  static clicks: Array<[number, number]> = [];
  static created: FakeController[] = [];
  /** 模拟「连上了但读不到尺寸」与「抓到的画面是空的」两种坏情况。 */
  static noResolution = false;
  static emptyImage = false;

  connected = false;

  get resolution(): [number, number] | null {
    return FakeController.noResolution ? null : [1280, 720];
  }

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
    self = { wait: async () => self, get: () => (FakeController.emptyImage ? null : imageBytes) };
    return self;
  }

  destroy(): void {
    this.connected = false;
  }
}

const fakeMaa: MaaModule = {
  Win32Controller: FakeController as unknown as MaaModule['Win32Controller'],
  Win32ScreencapMethod: { Background: '18', FramePool: '2', PrintWindow: '8' },
  Win32InputMethod: { SendMessage: '1', PostMessage: '2', AnchoredTouch: '32' },
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
  FakeController.noResolution = false;
  FakeController.emptyImage = false;
  imageBytes = pngHeader(1280, 720);
});

afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

function newWorld(maa: MaaModule = fakeMaa, warns: string[] = []) {
  const ctx = fakeWorldContext(ARKNIGHTS, { scratchDir });
  const session = new ArknightsSession(
    async () => ({ ok: true, maa }),
    (line) => warns.push(line),
  );
  const world = new ArknightsWorld({ cfg: ctx.cfg, timezone: ctx.timezone, session });
  return { ctx, world, session, warns };
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

  it('tools() 与 describe.json 的工具、事件、环境提示词逐字段一致', () => {
    const described = JSON.parse(readFileSync(join(PACKAGE_DIR, 'describe.json'), 'utf8')) as {
      tools: unknown;
      events: unknown;
      prompts: Array<{ key: string; content: string }>;
    };
    const { world } = newWorld();
    // describe.json 是 pnpm describe:extension 的产物，这里用同一份声明比到字段级，防止手写漂移。
    expect(JSON.parse(JSON.stringify(ARKNIGHTS.describe?.tools))).toEqual(described.tools);
    expect(world.tools().map((t) => t.name).sort()).toEqual(
      (described.tools as Array<{ name: string }>).map((t) => t.name).sort(),
    );
    expect(JSON.parse(JSON.stringify(ARKNIGHTS.describe?.events))).toEqual(described.events);

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

  it('未连接时连接/截图/暂停都返回失败回执，而不是抛错', async () => {
    FakeController.devices = [];
    const { world } = newWorld();
    const connect = receipt(await toolOf(world, 'ark_connect').handler({}, call));
    expect(connect.failed).toBe(true);
    expect(connect.text).toContain('没有找到窗口');

    const cases: Array<[string, Record<string, unknown>]> = [
      ['ark_screencap', {}],
      ['ark_set_paused', { paused: true }],
    ];
    for (const [name, args] of cases) {
      const outcome = receipt(await toolOf(world, name).handler(args, call));
      expect(outcome.failed, name).toBe(true);
      expect(outcome.text, name).toContain('ark_connect');
    }
  });

  it('连接成功后回执带窗口名与分辨率', async () => {
    const { world } = newWorld();
    const outcome = receipt(await toolOf(world, 'ark_connect').handler({}, call));
    expect(outcome.failed).toBeUndefined();
    expect(outcome.text).toContain('明日方舟');
    expect(outcome.text).toContain('1280×720');
    expect(FakeController.created[0]?.screencapMethod).toBe('18');
    // 默认输入方式是 AnchoredTouch，实测能点中右上角小按钮
    expect(FakeController.created[0]?.mouseMethod).toBe('32');
    expect(FakeController.created[0]?.keyboardMethod).toBe('32');
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
    expect(blob.bytes.byteLength).toBe(imageBytes.byteLength);
    expect(blob.fallbackText).toContain('1280×720');
    expect(blob.name).toMatch(/^arknights-\d{8}-\d{6}\.png$/);
  });

  it('暂停按归一化坐标换算成像素后点击，并如实说明不下结论', async () => {
    const { ctx, world } = newWorld();
    Object.assign(ctx.cfg, { pauseButton: { x: 0.5, y: 0.25 } });
    await toolOf(world, 'ark_connect').handler({}, call);
    const outcome = receipt(await toolOf(world, 'ark_set_paused').handler({ paused: true }, call));
    expect(outcome.failed).toBeUndefined();
    // 还没抓过帧，只能按控制器报的 1280×720 换算：(0.5×1279, 0.25×719)
    expect(FakeController.clicks).toEqual([[640, 180]]);
    expect(outcome.text).toContain('已向 (640, 180) 发送一次点击');
    expect(outcome.text).toContain('不做识别');
    expect(outcome.text).not.toContain('已暂停');
  });

  it('默认开启补拍：点击后回执附带一张点击后的画面', async () => {
    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);
    const outcome = receipt(await toolOf(world, 'ark_set_paused').handler({ paused: true }, call));
    expect(outcome.blobs).toHaveLength(1);
    const blob = outcome.blobs![0]!;
    if (!('bytes' in blob)) throw new Error('应当是新字节形式的附件');
    expect(blob.mime).toBe('image/png');
    expect(blob.bytes.byteLength).toBe(imageBytes.byteLength);
    expect(blob.fallbackText).toContain('点击后');
    expect(outcome.text).toContain('附件是点击之后抓的一帧');
  });

  it('关掉 verifyAfterClick 时退回纯文字回执，不产生附件', async () => {
    const { ctx, world } = newWorld();
    Object.assign(ctx.cfg, { verifyAfterClick: false });
    await toolOf(world, 'ark_connect').handler({}, call);
    const outcome = receipt(await toolOf(world, 'ark_set_paused').handler({ paused: false }, call));
    expect(outcome.blobs).toBeUndefined();
    expect(outcome.text).toContain('ark_screencap');
  });

  it('补拍失败不影响点击结论，只在回执里说明', async () => {
    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);
    FakeController.emptyImage = true;
    const outcome = receipt(await toolOf(world, 'ark_set_paused').handler({ paused: true }, call));
    expect(outcome.failed).toBeUndefined();
    expect(outcome.blobs).toBeUndefined();
    expect(outcome.text).toContain('补拍点击后的画面失败');
    expect(FakeController.clicks).toHaveLength(1);
  });

  it('坐标热改后下一次点击立即按新值换算', async () => {
    const { ctx, world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);
    ctx.persist({ pauseButton: { x: 0, y: 1 } });
    await toolOf(world, 'ark_set_paused').handler({ paused: false }, call);
    expect(FakeController.clicks).toEqual([[0, 719]]);
  });

  it('帧尺寸与控制器尺寸不一致时按帧尺寸换算，且只提醒一次', async () => {
    imageBytes = pngHeader(800, 500);
    const { ctx, world, warns } = newWorld();
    Object.assign(ctx.cfg, { pauseButton: { x: 0.5, y: 0.5 } });
    await toolOf(world, 'ark_connect').handler({}, call);

    // 没有帧时只能信控制器报的 1280×720
    await toolOf(world, 'ark_set_paused').handler({ paused: true }, call);
    expect(FakeController.clicks.at(-1)).toEqual([640, 360]);

    await toolOf(world, 'ark_screencap').handler({}, call);
    const sizeWarns = warns.filter((line) => line.includes('控制器报告的尺寸'));
    expect(sizeWarns).toHaveLength(1);
    expect(sizeWarns[0]).toContain('800×500');

    // 抓过帧以后一律按帧的 800×500 换算
    await toolOf(world, 'ark_set_paused').handler({ paused: false }, call);
    expect(FakeController.clicks.at(-1)).toEqual([400, 250]);

    // 再抓一帧不重复刷日志
    await toolOf(world, 'ark_screencap').handler({}, call);
    expect(warns.filter((line) => line.includes('控制器报告的尺寸'))).toHaveLength(1);
  });

  it('画面不是 16:9 时提示暂停坐标可能失准，只提醒一次', async () => {
    imageBytes = pngHeader(1152, 720);
    const { world, warns } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);
    await toolOf(world, 'ark_screencap').handler({}, call);
    const aspectWarns = warns.filter((line) => line.includes('不是 16:9'));
    expect(aspectWarns).toHaveLength(1);
    expect(aspectWarns[0]).toContain('1152×720');

    await toolOf(world, 'ark_screencap').handler({}, call);
    expect(warns.filter((line) => line.includes('不是 16:9'))).toHaveLength(1);
  });

  it('16:9 画面不产生比例告警', async () => {
    const { world, warns } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);
    await toolOf(world, 'ark_screencap').handler({}, call);
    expect(warns.filter((line) => line.includes('不是 16:9'))).toHaveLength(0);
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
  });

  it('绑定缺方法表时拒绝连接，而不是拿假标志位凑一个「成功」', async () => {
    const bareMaa: MaaModule = { Win32Controller: FakeController as unknown as MaaModule['Win32Controller'] };
    const { world } = newWorld(bareMaa);
    const outcome = receipt(await toolOf(world, 'ark_connect').handler({}, call));
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toContain('截图方式');
    expect(FakeController.created).toEqual([]);
    expect(resolveMethod(undefined, 'PrintWindow', 'Background')).toBeNull();
  });

  it('连上了却拿不到画面尺寸时断开，且不把半连接状态留给下一次调用', async () => {
    FakeController.noResolution = true;
    FakeController.emptyImage = true;
    const { world, session } = newWorld();
    const outcome = receipt(await toolOf(world, 'ark_connect').handler({}, call));
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toContain('拿不到画面尺寸');
    expect(session.connected).toBe(false);
    expect(session.resolution).toBeNull();

    FakeController.noResolution = false;
    FakeController.emptyImage = false;
    const again = receipt(await toolOf(world, 'ark_connect').handler({}, call));
    expect(again.failed).toBeUndefined();
    expect(again.text).toContain('1280×720');
  });
});
