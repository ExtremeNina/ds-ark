import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCallContext, ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { ARKNIGHTS } from '../src/definition.ts';
import { ARKNIGHTS_CONFIG_GROUP, ARKNIGHTS_DEFAULTS } from '../src/config.ts';
import { ArknightsWorld } from '../src/world.ts';
import { ArknightsSession, resolveMethod } from '../src/mfw/session.ts';
import type {
  MaaControllerLike,
  MaaDesktopDevice,
  MaaImageJobLike,
  MaaJobLike,
  MaaModule,
  MaaResourceLike,
  MaaTaskerLike,
  MaaTaskJobLike,
} from '../src/mfw/native.ts';
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
  static swipes: Array<{ from: [number, number]; to: [number, number]; duration: number }> = [];
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

  post_swipe(x1: number, y1: number, x2: number, y2: number, duration: number): MaaJobLike {
    FakeController.swipes.push({ from: [x1, y1], to: [x2, y2], duration });
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

/** 假资源：记录试过的路径，可整体失败，用来覆盖「没模型」「加载失败」两条降级路径。 */
class FakeResource implements MaaResourceLike {
  static paths: string[] = [];
  static failAll = false;
  /** 模拟「路径存在但模型文件坏了」：post_ocr_model 直接抛错。 */
  static throwOnLoad = false;
  static instances: FakeResource[] = [];
  loaded = false;

  constructor() {
    FakeResource.instances.push(this);
  }

  post_ocr_model(path: string): MaaJobLike {
    FakeResource.paths.push(path);
    if (FakeResource.throwOnLoad) throw new Error('模型文件损坏');
    this.loaded = !FakeResource.failAll;
    const job: MaaJobLike = { succeeded: this.loaded, status: this.loaded ? 1 : 0, wait: async () => job };
    return job;
  }

  destroy(): void {
    this.loaded = false;
  }
}

/** 假任务器：`post_recognition` 回一段写死的明细，形状与 maa-node 的 RecoDetail 一致。 */
class FakeTasker implements MaaTaskerLike {
  /** 识别结果，坐标是帧内像素，由用例按 1280×720 布置。 */
  static entries: Array<{ text: string; box: [number, number, number, number] }> = [];
  static created: FakeTasker[] = [];
  resource: MaaResourceLike | null = null;
  controller: MaaControllerLike | null = null;

  constructor() {
    FakeTasker.created.push(this);
  }

  post_recognition(_type: string, _param: Record<string, unknown>, _image: ArrayBuffer): MaaTaskJobLike {
    const job: MaaTaskJobLike = {
      id: 1,
      succeeded: true,
      status: 1,
      wait: async () => job,
      get: () => ({ entry: 'demo', nodes: [7], status: 1 }),
    };
    return job;
  }

  node_detail(_id: number): unknown {
    return {
      name: 'demo',
      reco: {
        name: 'OCR',
        algorithm: 'OCR',
        hit: true,
        box: [0, 0, 0, 0],
        detail: { all: FakeTasker.entries, filtered: FakeTasker.entries, best: null },
      },
      action: null,
      completed: true,
    };
  }

  recognition_detail(_id: number): unknown {
    return null;
  }

  destroy(): void {}
}

const fakeMaa: MaaModule = {
  Win32Controller: FakeController as unknown as MaaModule['Win32Controller'],
  Win32ScreencapMethod: { Background: '18', FramePool: '2', PrintWindow: '8' },
  Win32InputMethod: { SendMessage: '1', PostMessage: '2', AnchoredTouch: '32' },
  Resource: FakeResource,
  Tasker: FakeTasker,
};

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'arknights-world-'));
  FakeController.devices = [
    ['0x1', 'UnityWndClass', '明日方舟'],
    ['0x2', 'Notepad', '无标题 - 记事本'],
  ];
  FakeController.clicks = [];
  FakeController.swipes = [];
  FakeController.created = [];
  FakeController.noResolution = false;
  FakeController.emptyImage = false;
  FakeResource.paths = [];
  FakeResource.failAll = false;
  FakeResource.throwOnLoad = false;
  FakeResource.instances = [];
  FakeTasker.entries = [];
  FakeTasker.created = [];
  imageBytes = pngHeader(1280, 720);
});

afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

/** 造一套「三件套」：校验只看文件是否存在且非空，内容无所谓。 */
function writeFakeModel(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ['det.onnx', 'rec.onnx', 'keys.txt']) {
    writeFileSync(join(dir, name), 'fake');
  }
}

function newWorld(maa: MaaModule = fakeMaa, warns: string[] = []) {
  const ctx = fakeWorldContext(ARKNIGHTS, { scratchDir });
  const session = new ArknightsSession(
    async () => ({ ok: true, maa }),
    (line) => warns.push(line),
    () => {},
    // 每个用例的内置模型目录都是自己的临时目录：想要「有模型」就自己写三件套。
    scratchDir,
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
      ['ark_battle_state', {}],
      ['ark_deploy', { card: { x: 0.5, y: 0.5 }, tile: { x: 0.5, y: 0.5 }, direction: 'up' }],
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
    expect(outcome.text).toContain('补拍失败');
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

  it('读战场：识别到数字就逐项报出，并附上同一帧，全程不点击', async () => {
    FakeTasker.entries = [
      { text: '0/11', box: [480, 10, 60, 24] },
      { text: '20', box: [660, 8, 30, 26] },
      { text: '28', box: [1190, 560, 40, 30] },
      { text: '12', box: [40, 668, 24, 20] },
      { text: '16', box: [300, 668, 24, 20] },
    ];
    // 不配 resourceDir：内置模型就是默认来源。
    writeFakeModel(scratchDir);
    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);

    const outcome = receipt(await toolOf(world, 'ark_battle_state').handler({}, call));
    expect(outcome.failed).toBeUndefined();
    expect(outcome.text).toContain('费用 28');
    expect(outcome.text).toContain('生命 20');
    expect(outcome.text).toContain('剩余敌人 0/11');
    expect(outcome.text).toContain('手牌费用从左到右 12 / 16');
    expect(outcome.text).toContain('没有向游戏发任何点击');
    expect(outcome.text).not.toContain('已暂停');
    expect(outcome.blobs).toHaveLength(1);
    const blob = outcome.blobs![0]!;
    if (!('bytes' in blob)) throw new Error('应当是字节附件');
    expect(blob.mime).toBe('image/png');
    expect(FakeController.clicks).toEqual([]);
    // 只加载一次模型，后续调用复用
    expect(FakeResource.instances).toHaveLength(1);
  });

  it('读战场：认到暂停横幅只描述画面，并声明数字可能不准', async () => {
    FakeTasker.entries = [
      { text: 'PAUSE', box: [560, 300, 160, 50] },
      { text: '28', box: [1190, 560, 40, 30] },
    ];
    writeFakeModel(scratchDir);
    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);

    const outcome = receipt(await toolOf(world, 'ark_battle_state').handler({}, call));
    expect(outcome.text).toContain('暂停横幅');
    expect(outcome.text).toContain('请以附件画面为准');
    expect(outcome.text).toContain('没读到：生命值、剩余敌人、手牌费用');
    expect(outcome.text).not.toContain('已暂停');
  });

  it('读战场：不配 resourceDir 也能用包内模型识别', async () => {
    writeFakeModel(scratchDir);
    FakeTasker.entries = [{ text: '28', box: [1190, 560, 40, 30] }];

    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);

    const outcome = receipt(await toolOf(world, 'ark_battle_state').handler({}, call));
    expect(outcome.failed).toBeUndefined();
    expect(outcome.text).toContain('费用 28');
    expect(FakeResource.paths).toEqual([scratchDir]);
  });

  it('读战场：包内模型缺失时降级为只看图，且不会把空目录当模型', async () => {
    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);

    const outcome = receipt(await toolOf(world, 'ark_battle_state').handler({}, call));
    expect(outcome.failed).toBeUndefined();
    expect(outcome.text).toContain('没找到可用的 OCR 模型');
    expect(outcome.text).toContain('det.onnx');
    expect(outcome.blobs).toHaveLength(1);
    // 缺件时一次 post_ocr_model 都不该发：MaaFramework 会把它当成功。
    expect(FakeResource.paths).toEqual([]);
  });

  it('读战场：0 字节的模型文件不算可用模型', async () => {
    writeFakeModel(scratchDir);
    writeFileSync(join(scratchDir, 'det.onnx'), '');

    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);

    const outcome = receipt(await toolOf(world, 'ark_battle_state').handler({}, call));
    expect(outcome.text).toContain('det.onnx');
    expect(FakeResource.paths).toEqual([]);
  });

  it('读战场：模型加载失败时把试过的路径写进回执，仍然给图', async () => {
    writeFakeModel(scratchDir);
    FakeResource.failAll = true;

    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);

    const outcome = receipt(await toolOf(world, 'ark_battle_state').handler({}, call));
    expect(outcome.failed).toBeUndefined();
    expect(outcome.text).toContain('识别不可用');
    expect(outcome.text).toContain('试过');
    expect(outcome.blobs).toHaveLength(1);
    expect(FakeResource.paths).toEqual([scratchDir]);
  });

  it('读战场：自定义模型目录优先于包内模型', async () => {
    writeFakeModel(scratchDir);
    const custom = join(scratchDir, 'custom-model');
    writeFakeModel(custom);
    FakeTasker.entries = [{ text: '28', box: [1190, 560, 40, 30] }];

    const { ctx, world } = newWorld();
    Object.assign(ctx.cfg, { resourceDir: custom });
    await toolOf(world, 'ark_connect').handler({}, call);

    const outcome = receipt(await toolOf(world, 'ark_battle_state').handler({}, call));
    expect(outcome.text).toContain('费用 28');
    expect(FakeResource.paths).toEqual([custom]);
  });

  it('读战场：resourceDir 填资源包根时命中其中的 model/ocr', async () => {
    const bundle = join(scratchDir, 'bundle');
    writeFakeModel(join(bundle, 'model', 'ocr'));

    const { ctx, world } = newWorld();
    Object.assign(ctx.cfg, { resourceDir: bundle });
    await toolOf(world, 'ark_connect').handler({}, call);

    receipt(await toolOf(world, 'ark_battle_state').handler({}, call));
    expect(FakeResource.paths).toEqual([join(bundle, 'model', 'ocr')]);
  });

  it('读战场：自定义目录缺件时跳过，回落到包内模型', async () => {
    writeFakeModel(scratchDir);
    const partial = join(scratchDir, 'partial');
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, 'det.onnx'), 'x');

    const { ctx, world } = newWorld();
    Object.assign(ctx.cfg, { resourceDir: partial });
    await toolOf(world, 'ark_connect').handler({}, call);

    const outcome = receipt(await toolOf(world, 'ark_battle_state').handler({}, call));
    expect(outcome.failed).toBeUndefined();
    expect(FakeResource.paths).toEqual([scratchDir]);
  });

  it('读战场：模型加载直接抛错时，回执里既有试过的路径也有最后的原因', async () => {
    writeFakeModel(scratchDir);
    FakeResource.throwOnLoad = true;

    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);

    const outcome = receipt(await toolOf(world, 'ark_battle_state').handler({}, call));
    expect(outcome.text).toContain('试过');
    expect(outcome.text).toContain('模型文件损坏');
    expect(outcome.blobs).toHaveLength(1);
  });

  it('部署：两次拖拽的端点与时长都对，并补拍一帧', async () => {
    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);

    const outcome = receipt(await toolOf(world, 'ark_deploy').handler(
      { card: { x: 0.1, y: 0.9 }, tile: { x: 0.5, y: 0.5 }, direction: 'up' },
      call,
    ));
    expect(outcome.failed).toBeUndefined();
    expect(FakeController.swipes).toEqual([
      { from: [128, 647], to: [640, 360], duration: 260 },
      { from: [640, 360], to: [640, 281], duration: 160 },
    ]);
    expect(outcome.text).toContain('拖拽之后的一帧');
    expect(outcome.text).not.toContain('已部署');
    expect(outcome.blobs).toHaveLength(1);
  });

  it('部署：关掉 verifyAfterClick 时退回纯文字回执', async () => {
    const { ctx, world } = newWorld();
    Object.assign(ctx.cfg, { verifyAfterClick: false });
    await toolOf(world, 'ark_connect').handler({}, call);

    const outcome = receipt(await toolOf(world, 'ark_deploy').handler(
      { card: { x: 0.1, y: 0.9 }, tile: { x: 0.5, y: 0.5 }, direction: 'left' },
      call,
    ));
    expect(outcome.blobs).toBeUndefined();
    expect(outcome.text).toContain('ark_screencap');
  });

  it('部署：参数不合法时拒绝，一次手势都不发', async () => {
    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);

    const cases: Array<Record<string, unknown>> = [
      { card: { x: 1.4, y: 0.5 }, tile: { x: 0.5, y: 0.5 }, direction: 'up' },
      { card: { x: 0.5, y: 0.5 }, tile: { x: 0.5, y: 0.5 }, direction: 'north' },
      {},
    ];
    for (const args of cases) {
      const outcome = receipt(await toolOf(world, 'ark_deploy').handler(args, call));
      expect(outcome.failed, JSON.stringify(args)).toBe(true);
    }
    expect(FakeController.swipes).toEqual([]);
  });

  it('部署：绑定没有 post_swipe 时给可读原因，而不是崩在 TypeError 上', async () => {
    const { world } = newWorld();
    await toolOf(world, 'ark_connect').handler({}, call);

    const proto = FakeController.prototype as unknown as Record<string, unknown>;
    const original = proto.post_swipe;
    delete proto.post_swipe;
    try {
      const outcome = receipt(await toolOf(world, 'ark_deploy').handler(
        { card: { x: 0.1, y: 0.9 }, tile: { x: 0.5, y: 0.5 }, direction: 'up' },
        call,
      ));
      expect(outcome.failed).toBe(true);
      expect(outcome.text).toContain('post_swipe');
    } finally {
      proto.post_swipe = original;
    }
  });
});
