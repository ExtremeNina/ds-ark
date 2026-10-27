/**
 * World 实现：九个工具（连接、截图、暂停/恢复、读战场、点选部署、等待、通用点击/拖拽/读屏）、
 * 一条挂载事件与环境提示词。
 * 工具只描述自己能确认的事实：没有识别能力时不说「已暂停」，拖拽发出后也不说「已部署」。
 */
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, ToolOutcome, ToolSpec, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { planClick, planSwipe } from './battle/actions.ts';
import { DEPLOY_DIRECTIONS, planDeploy } from './battle/deploy.ts';
import { describeBattleState, parseBattleState } from './battle/state.ts';
import { ARKNIGHTS_CONFIG_GROUP, type ArknightsConfigSection } from './config.ts';
import { pausePoint } from './mfw/geometry.ts';
import { SCREENSHOT_MIME, screenshotName } from './mfw/screen.ts';
import { ArknightsSession } from './mfw/session.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export interface ArknightsWorldOptions {
  /** `worlds.arknights` 的活引用：用到时现读，热改立即生效。 */
  cfg: ArknightsConfigSection;
  timezone: string;
  /** 测试可注入假会话，避免在单测里碰原生模块。 */
  session?: ArknightsSession;
}

/** 全部工具的声明；`describe` 与 `tools()` 共用同一份，避免两处漂移。 */
export const ARKNIGHTS_TOOL_DECLS: ReadonlyArray<ToolSpec> = [
  {
    name: 'ark_connect',
    description:
      'Find the Arknights PC client window on this machine and connect to it. '
      + 'Returns the window title, class name and capture resolution, or the reason it failed. '
      + 'Call this before any other ark_ tool; calling it again re-uses a live connection.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: 'ark_screencap',
    description:
      'Capture the current frame of the connected Arknights window and attach it as a PNG image. '
      + 'Returns the frame size and byte count; the image is only attached when the endpoint accepts image/png.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: 'ark_set_paused',
    description:
      'Click the configured pause button position once to pause (true) or resume (false) the battle. '
      + 'When verifyAfterClick is on, the receipt also carries a frame captured right after the click, '
      + 'so you can judge the result yourself; the World still does not confirm the game state.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paused: {
          type: 'boolean',
          description: 'true sends a pause click, false sends a resume click.',
        },
      },
      required: ['paused'],
    },
  },
  {
    name: 'ark_battle_state',
    description:
      'Capture the current battle frame, read cost, life points, enemies left, the pause banner and the hand '
      + 'operator costs from it locally, and attach that same frame. Read-only: it never clicks. '
      + 'Anything the local OCR could not read is listed as missing instead of being reported as zero. '
      + 'OCR models ship with the extension, so no configuration is needed; worlds.arknights.resourceDir '
      + 'only overrides them. When OCR is unavailable the frame is still returned for you to look at.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: 'ark_deploy',
    description:
      'Drag one hand card onto a battlefield tile, then drag from that tile towards a direction to deploy an '
      + 'operator. card and tile are normalised 0-1 points taken from an attached frame; direction is '
      + 'up/down/left/right. The receipt only states that the drags were sent, and (when verifyAfterClick is on) '
      + 'attaches the frame captured right after them.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        card: {
          type: 'object',
          additionalProperties: false,
          description: 'Normalised point on the hand card you want to deploy: x/y are 0-1 of the frame size.',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
        tile: {
          type: 'object',
          additionalProperties: false,
          description: 'Normalised point on the battlefield tile to deploy onto.',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
        direction: {
          type: 'string',
          enum: [...DEPLOY_DIRECTIONS],
          description: 'Facing to set after the operator is dropped: up, down, left or right.',
        },
      },
      required: ['card', 'tile', 'direction'],
    },
  },
  {
    name: 'ark_wait',
    description:
      'Wait a number of milliseconds before doing anything else, e.g. to let deployment points regenerate. '
      + 'It neither captures nor clicks; prefer it over burning several screenshot calls just to pass time. '
      + 'The value is clamped to 0-10000 ms.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ms: { type: 'number', description: 'How long to wait, 0-10000 milliseconds.' },
      },
      required: ['ms'],
    },
  },
  {
    name: 'ark_click',
    description:
      'Click one point on the game window. x and y are normalised 0-1 coordinates of the frame, the same convention '
      + 'as ark_deploy. The receipt only states that the click was sent; whether the screen changed is for you to '
      + 'verify with ark_ocr or ark_screencap, or pass expect to have the World poll for a piece of text.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'number', description: 'Normalised horizontal position, 0 (left) to 1 (right).' },
        y: { type: 'number', description: 'Normalised vertical position, 0 (top) to 1 (bottom).' },
        expect: {
          type: 'string',
          description: 'Optional: text that should appear after the click (e.g. a stage name). The World polls the '
            + 'frame and reports whether it showed up; it does not infer what the screen means.',
        },
        timeoutMs: { type: 'number', description: 'How long to poll for expect, 500-10000 ms (default 3000).' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'ark_swipe',
    description:
      'Drag from one point to another, e.g. to scroll a stage list. Both points are normalised 0-1 coordinates. '
      + 'durationMs is clamped to 80-2000 (default 300); repeats sends the same drag several times for long lists. '
      + 'The receipt only states that the drag was sent.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: {
          type: 'object',
          additionalProperties: false,
          description: 'Normalised start point of the drag.',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
        to: {
          type: 'object',
          additionalProperties: false,
          description: 'Normalised end point of the drag.',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
        durationMs: { type: 'number', description: 'How long the drag takes, 80-2000 ms (default 300).' },
        repeats: { type: 'number', description: 'How many times to repeat the drag, 1-5 (default 1).' },
        intervalMs: { type: 'number', description: 'Pause between repeated drags, 0-1000 ms (default 120).' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'ark_ocr',
    description:
      'Capture the frame and list every recognised text line with normalised boxes (x,y,w,h), sorted top-to-bottom '
      + 'then left-to-right. Unlike ark_battle_state it does not filter by battle regions, so it also covers menus '
      + 'such as the terminal and stage list. Read-only: it never clicks.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxLines: { type: 'number', description: 'How many lines to print, 1-200 (default 40).' },
      },
      required: [],
    },
  },
];

const fail = (text: string): ToolOutcome => ({ text, failed: true });

/** 一帧的附件形状只在这里拼一次：mime、带时间戳的文件名、端点不收图时的降级文案。 */
function frameBlob(png: Uint8Array, fallbackText: string): NonNullable<ToolOutcome['blobs']>[number] {
  return { bytes: png, mime: SCREENSHOT_MIME, name: screenshotName(new Date()), fallbackText };
}

export class ArknightsWorld implements World {
  readonly id = 'arknights';

  private readonly session: ArknightsSession;
  private host: WorldHost | null = null;

  constructor(private readonly opts: ArknightsWorldOptions) {
    // 尺寸与比例的自检只进日志，不进模型上下文：它们不是模型需要处理的决策点。
    this.session = opts.session ?? new ArknightsSession(
      undefined,
      (line) => this.host?.log.warn(line),
      (line) => this.host?.log.info(line),
    );
  }

  /** 只报值；前缀文本一律来自 ENV_PROMPT.md。 */
  envPromptVars(): Record<string, string> {
    return {
      'arknights.windowMatch': this.opts.cfg.windowMatch || '（未配置）',
      'arknights.easyStages': this.opts.cfg.easyStages.trim() || '（未配置）',
    };
  }

  tools(): ToolDef[] {
    return ARKNIGHTS_TOOL_DECLS.map((decl) => {
      switch (decl.name) {
        case 'ark_connect':
          return { ...decl, handler: () => this.connect() };
        case 'ark_screencap':
          return { ...decl, handler: () => this.screencap() };
        case 'ark_set_paused':
          return { ...decl, handler: (args) => this.setPaused(args) };
        case 'ark_battle_state':
          return { ...decl, handler: () => this.battleState() };
        case 'ark_deploy':
          return { ...decl, handler: (args) => this.deploy(args) };
        case 'ark_wait':
          return { ...decl, handler: (args) => this.wait(args) };
        case 'ark_click':
          return { ...decl, handler: (args) => this.clickAt(args) };
        case 'ark_swipe':
          return { ...decl, handler: (args) => this.swipeTo(args) };
        case 'ark_ocr':
          return { ...decl, handler: (args) => this.readAll(args) };
        default:
          return { ...decl, handler: async () => fail(`未实现的工具：${decl.name}`) };
      }
    });
  }

  webUi(_language?: Language): WorldWebUiDecl {
    return {
      config: [ARKNIGHTS_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.arknights.envPrompt',
          title: '明日方舟 · 环境提示词',
          description: '本 World 进 system 前缀的那一段：何时连接、何时截图、何时读战场、何时暂停与部署。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'arknights.windowMatch', description: '配置里当前的窗口名关键字。' },
            { name: 'arknights.easyStages', description: '配置里推荐的关卡清单，未配置时渲染为「（未配置）」。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    await host.pushEvent({
      type: 'arknights.ready',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: '明日方舟 World 已挂载。ark_connect / ark_screencap / ark_set_paused / ark_battle_state / ark_deploy / '
        + 'ark_wait / ark_click / ark_swipe / ark_ocr 可用；'
        + '尚未连接游戏窗口。OCR 模型随包提供（resourceDir 仅用于覆盖），点击与拖拽都只保证「手势已发出」。',
    });
  }

  async stop(): Promise<void> {
    this.host = null;
    await this.session.stop();
  }

  private async connect(): Promise<ToolOutcome | string> {
    const result = await this.session.connect(this.opts.cfg);
    if (!result.ok) return fail(result.error);
    this.host?.log.info('connected to arknights window');
    const [width, height] = result.resolution;
    return `已连接「${result.window.windowName}」（窗口类名 ${result.window.className}），截图分辨率 ${width}×${height}。`
      + '现在可以调用 ark_screencap 取画面，或 ark_set_paused 暂停/继续。';
  }

  private async screencap(): Promise<ToolOutcome> {
    const result = await this.session.screencap();
    if (!result.ok) return fail(result.error);
    const size = this.session.resolution;
    const label = size ? `${size[0]}×${size[1]}` : '尺寸未知';
    const fallbackText = `明日方舟当前帧，${label}，PNG ${result.png.byteLength} 字节（端点不接受图片时只发送这句）。`;
    return {
      text: `已抓取一帧，${label}，PNG ${result.png.byteLength} 字节。这是本次调用时刻的画面，不保证与之后的状态一致。`,
      blobs: [frameBlob(result.png, fallbackText)],
    };
  }

  private async setPaused(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    const paused = args.paused;
    if (typeof paused !== 'boolean') {
      return fail('参数 paused 必须是布尔值：true 表示暂停，false 表示继续。');
    }
    if (!this.session.connected) {
      return fail('暂停失败：还没连接游戏窗口，先调用 ark_connect。');
    }
    const size = this.session.resolution;
    if (!size) {
      // 没有画面尺寸就无法把比例换成像素；拿 1280×720 之类的猜测值去点会点偏。
      return fail('暂停失败：还没拿到画面尺寸，先调用 ark_screencap 取一帧再试。');
    }
    const cfg = this.opts.cfg;
    const [width, height] = size;
    const { x, y } = pausePoint(cfg.pauseButton, [width, height]);
    const clicked = await this.session.click(x, y);
    if (!clicked.ok) return fail(clicked.error);
    const action = paused ? '暂停' : '继续';
    const receipt = `已向 (${x}, ${y}) 发送一次点击（按 ${width}×${height} 换算：x 取距右边缘的余量，`
      + `y 取 ${(cfg.pauseButton.y * 100).toFixed(1)}% 高度），意图是${action}。`;

    if (!cfg.verifyAfterClick) {
      return `${receipt}这是点击回执，无法确认游戏是否真的${action}；需要确认请再调用 ark_screencap 自己看。`;
    }

    // 补拍一帧：让模型直接用眼睛判断，而不是相信坐标或回执文字。
    const after = await this.session.screencap();
    if (!after.ok) {
      return `${receipt}补拍失败（${after.error}），无法提供点击后的画面，请自行确认游戏状态。`;
    }
    // 补拍会把帧尺寸刷新到最新值；附件说明用刷新后的尺寸，避免和画面本身对不上。
    const afterSize = this.session.resolution ?? [width, height];
    const fallbackText = `${action}点击后的一帧，${afterSize[0]}×${afterSize[1]}，PNG ${after.png.byteLength} 字节`
      + '（端点不接受图片时只发送这句，请再调用 ark_screencap 确认）。';
    return {
      text: `${receipt}附件是点击之后抓的一帧，请据此判断是否真的${action}；World 自己不做识别，也不会替你下结论。`,
      blobs: [frameBlob(after.png, fallbackText)],
    };
  }

  /** 只读：抓一帧，能识别就报数，识别不了就退回「你自己看图」。全程不发点击。 */
  private async battleState(): Promise<ToolOutcome> {
    if (!this.session.connected) return fail('读取战场失败：还没连接游戏窗口，先调用 ark_connect。');
    const shot = await this.session.screencap();
    if (!shot.ok) return fail(shot.error);

    const size = this.session.resolution;
    const label = size ? `${size[0]}×${size[1]}` : '尺寸未知';
    const fallbackText = `明日方舟战场帧，${label}，PNG ${shot.png.byteLength} 字节（端点不接受图片时只发送这句）。`;
    const ocr = await this.session.recognizeFrame(shot.png, this.opts.cfg.resourceDir);
    if (!ocr.ok) {
      return {
        text: `已抓取一帧，${label}。这次读不出战场数字（${ocr.error}）。附件就是这一帧，请自己看图判断；`
          + '这是只读取帧，没有向游戏发任何点击。',
        blobs: [frameBlob(shot.png, fallbackText)],
      };
    }

    const state = parseBattleState(ocr.lines);
    return {
      text: `已抓取一帧，${label}。${describeBattleState(state)}`
        + '这是只读取帧，没有向游戏发任何点击；暂停/继续请用 ark_set_paused。',
      blobs: [frameBlob(shot.png, fallbackText)],
    };
  }

  /** 点选式部署：模型给归一化坐标与朝向，这里只负责把两次拖拽发出去。 */
  private async deploy(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('部署失败：还没连接游戏窗口，先调用 ark_connect。');
    const size = this.session.resolution;
    if (!size) return fail('部署失败：还没拿到画面尺寸，先调用 ark_screencap 取一帧。');

    const cfg = this.opts.cfg;
    const planned = planDeploy(args.card, args.tile, args.direction, size, {
      holdMs: cfg.deployHoldMs,
      gapMs: cfg.deployGapMs,
      directionMs: cfg.deployDirectionMs,
    });
    if (!planned.ok) return fail(planned.error);
    const { plan } = planned;

    const picked = await this.session.swipe(plan.card.x, plan.card.y, plan.tile.x, plan.tile.y, plan.holdMs);
    if (!picked.ok) return fail(`${picked.error}（手牌 → 地块这一步没发出去，因此没有发定向拖拽）`);
    if (plan.gapMs > 0) await new Promise((resolve) => setTimeout(resolve, plan.gapMs));
    const aimed = await this.session.swipe(plan.tile.x, plan.tile.y, plan.release.x, plan.release.y, plan.directionMs);
    if (!aimed.ok) return fail(`${aimed.error}（已经拖到 (${plan.tile.x}, ${plan.tile.y})，但定向拖拽没发出去）`);

    const receipt = `已从 (${plan.card.x}, ${plan.card.y}) 拖到 (${plan.tile.x}, ${plan.tile.y})，`
      + `再拖到 (${plan.release.x}, ${plan.release.y}) 定朝向`
      + `（按 ${size[0]}×${size[1]} 换算；按住 ${plan.holdMs}ms，间隔 ${plan.gapMs}ms，定向 ${plan.directionMs}ms）。`;
    if (!this.opts.cfg.verifyAfterClick) {
      return `${receipt}这是拖拽回执，无法确认干员是否落位；需要确认请再调用 ark_screencap 自己看。`;
    }

    const after = await this.session.screencap();
    if (!after.ok) return `${receipt}补拍失败（${after.error}），无法提供拖拽后的画面，请自行确认游戏状态。`;
    const afterSize = this.session.resolution ?? size;
    const fallbackText = `部署拖拽后的一帧，${afterSize[0]}×${afterSize[1]}，PNG ${after.png.byteLength} 字节`
      + '（端点不接受图片时只发送这句，请再调用 ark_screencap 确认）。';
    return {
      text: `${receipt}附件是拖拽之后的一帧，请据此判断是否落位成功、朝向是否正确；`
        + 'World 自己不做识别，也不会替你下结论。',
      blobs: [frameBlob(after.png, fallbackText)],
    };
  }

  /** 只睡不动作：给模型一个「等回费」的廉价手段，比反复截图省 token。 */
  private async wait(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    const raw = args.ms;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return fail('参数 ms 必须是数字（毫秒）。');
    const ms = Math.max(0, Math.min(10_000, Math.round(raw)));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return `已等待 ${ms} 毫秒。现在可以再调用 ark_battle_state 看状态，或继续 ark_deploy。`;
  }

  /** 动作类工具的收尾：按配置决定要不要补拍一帧，三处共用一套措辞。 */
  private async withAfterFrame(receipt: string, action: string): Promise<ToolOutcome | string> {
    if (!this.opts.cfg.verifyAfterClick) {
      return `${receipt}这是${action}回执，无法确认界面有没有变化；需要确认请再调用 ark_ocr 或 ark_screencap。`;
    }
    const after = await this.session.screencap();
    if (!after.ok) return `${receipt}补拍失败（${after.error}），请自行确认画面。`;
    const size = this.session.resolution;
    const label = size ? `${size[0]}×${size[1]}` : '尺寸未知';
    const fallbackText = `${action}之后的一帧，${label}，PNG ${after.png.byteLength} 字节`;
    return {
      text: `${receipt}附件是${action}之后的一帧，请据此判断界面有没有变化；`
        + 'World 自己不做识别，也不替你下结论。',
      blobs: [frameBlob(after.png, fallbackText)],
    };
  }

  /** 通用点击：只发一次 post_click，界面有没有变化由模型再读屏确认。 */
  private async clickAt(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('点击失败：还没连接游戏窗口，先调用 ark_connect。');
    const size = this.session.resolution;
    if (!size) return fail('点击失败：还没拿到画面尺寸，先调用 ark_screencap 取一帧。');

    const planned = planClick({ x: args.x, y: args.y }, size);
    if (!planned.ok) return fail(planned.error);
    const { at } = planned.plan;

    const clicked = await this.session.click(at.x, at.y);
    if (!clicked.ok) return fail(clicked.error);

    const receipt = `已向 (${at.x}, ${at.y}) 发送一次点击（按 ${size[0]}×${size[1]} 换算）。`;
    const expect = typeof args.expect === 'string' ? args.expect.trim() : '';
    if (!expect) return this.withAfterFrame(receipt, '点击');
    return this.confirmText(receipt, expect, args.timeoutMs);
  }

  /**
   * 点完之后按「画面里有没有某段文字」复核。
   *
   * 只报「出现 / 没出现」，不推断这是哪一步、也不说「已经进入某界面」——文字可能没被识别，
   * 或者界面还在加载，判断留给模型。
   */
  private async confirmText(receipt: string, expect: string, timeoutMs: unknown): Promise<string> {
    const budget = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? Math.min(10_000, Math.max(500, Math.round(timeoutMs)))
      : 3000;
    const started = Date.now();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const shot = await this.session.screencap();
      if (!shot.ok) return `${receipt}复核失败（${shot.error}），无法确认「${expect}」是否出现。`;
      const ocr = await this.session.recognizeFrame(shot.png, this.opts.cfg.resourceDir);
      if (!ocr.ok) return `${receipt}复核失败（${ocr.error}），无法确认「${expect}」是否出现。`;
      if (ocr.lines.some((line) => line.text.includes(expect))) {
        return `${receipt}约 ${Date.now() - started}ms 后画面里出现了「${expect}」。`;
      }
      if (Date.now() - started >= budget) {
        return `${receipt}在 ${budget}ms 内没在画面里读到「${expect}」；这不代表点击一定没生效，`
          + '可能只是文字没被识别、或界面还在加载。';
      }
    }
  }

  /** 通用拖拽：滚动列表、切章节、拖动滑块都走这里。 */
  private async swipeTo(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('拖拽失败：还没连接游戏窗口，先调用 ark_connect。');
    const size = this.session.resolution;
    if (!size) return fail('拖拽失败：还没拿到画面尺寸，先调用 ark_screencap 取一帧。');

    const planned = planSwipe(args.from, args.to, args.durationMs, size, {
      repeats: args.repeats,
      intervalMs: args.intervalMs,
    });
    if (!planned.ok) return fail(planned.error);
    const { from, to, durationMs, repeats, intervalMs } = planned.plan;

    for (let index = 1; index <= repeats; index += 1) {
      if (index > 1 && intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const dragged = await this.session.swipe(from.x, from.y, to.x, to.y, durationMs);
      if (!dragged.ok) return fail(`${dragged.error}（第 ${index}/${repeats} 次拖拽没发出去）`);
    }

    const times = repeats > 1 ? `，连续 ${repeats} 次（每次间隔 ${intervalMs}ms）` : '';
    return this.withAfterFrame(
      `已从 (${from.x}, ${from.y}) 拖到 (${to.x}, ${to.y})，用时 ${durationMs}ms${times}`
        + `（按 ${size[0]}×${size[1]} 换算）。`,
      '拖拽',
    );
  }

  /**
   * 全屏读字：不按战斗区域过滤，菜单界面（终端、关卡列表、编队）也能用。
   *
   * 默认只回文字与坐标、不附截图——一次导航要读六七次屏，每步一张图的 token 成本不可接受；
   * 需要看画面时模型自己调 ark_screencap。
   */
  private async readAll(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('读屏失败：还没连接游戏窗口，先调用 ark_connect。');
    const shot = await this.session.screencap();
    if (!shot.ok) return fail(shot.error);
    const frame = this.session.resolution;
    if (!frame) return fail('读屏失败：读不出这一帧的像素尺寸。');

    const raw = args.maxLines;
    const maxLines = typeof raw === 'number' && Number.isFinite(raw)
      ? Math.max(1, Math.min(200, Math.round(raw)))
      : 40;

    const ocr = await this.session.recognizeFrame(shot.png, this.opts.cfg.resourceDir);
    if (!ocr.ok) {
      return {
        text: `读屏失败：${ocr.error}附件是这一帧，可以直接用眼睛找按钮。`,
        blobs: [frameBlob(shot.png, `当前一帧，${frame[0]}×${frame[1]}，PNG ${shot.png.byteLength} 字节`)],
      };
    }

    const lines = [...ocr.lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    if (lines.length === 0) {
      return `读屏完成，但画面里没有读到文字（${frame[0]}×${frame[1]}）。`
        + '可以直接看画面，或用 ark_screencap 取一帧自己看。';
    }

    const head = `画面 ${frame[0]}×${frame[1]}，识别到 ${lines.length} 行`
      + '（按从上到下、从左到右排序；坐标是归一化 x,y,w,h）：';
    const body = lines.slice(0, maxLines).map((line) => {
      const { x, y, w, h } = line.box;
      const px = `${Math.round(x * frame[0])},${Math.round(y * frame[1])},`
        + `${Math.round(w * frame[0])},${Math.round(h * frame[1])}`;
      return `「${line.text}」 ${x.toFixed(3)},${y.toFixed(3)} ${w.toFixed(3)},${h.toFixed(3)}　像素 ${px}`;
    }).join('\n');
    const tail = lines.length > maxLines
      ? `\n（只列前 ${maxLines} 行，共 ${lines.length} 行；要全部就把 maxLines 调大，上限 200）`
      : '';
    return `${head}\n${body}${tail}\n找按钮就用上面的归一化 x,y 调 ark_click；这一步只读，没有点击。`;
  }
}
