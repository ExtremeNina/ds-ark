/**
 * World 实现：三个工具（连接、截图、暂停/恢复）、一条挂载事件与环境提示词。
 * 工具只描述自己能确认的事实；没有识别能力时不说「已暂停」。
 */
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, ToolOutcome, ToolSpec, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { ARKNIGHTS_CONFIG_GROUP, type ArknightsConfigSection } from './config.ts';
import { toPoint } from './mfw/geometry.ts';
import { SCREENSHOT_MIME, screenshotName } from './mfw/screen.ts';
import { ArknightsSession, connectionLine } from './mfw/session.ts';

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
      + 'The receipt only states that a click was sent; it cannot confirm the game state.',
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
];

const fail = (text: string): ToolOutcome => ({ text, failed: true });

export class ArknightsWorld implements World {
  readonly id = 'arknights';

  private readonly session: ArknightsSession;
  private host: WorldHost | null = null;

  constructor(private readonly opts: ArknightsWorldOptions) {
    this.session = opts.session ?? new ArknightsSession();
  }

  /** 只报值；前缀文本一律来自 ENV_PROMPT.md。 */
  envPromptVars(): Record<string, string> {
    return { 'arknights.windowMatch': this.opts.cfg.windowMatch || '（未配置）' };
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
          description: '本 World 进 system 前缀的那一段：何时连接、何时截图、何时暂停。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'arknights.windowMatch', description: '配置里当前的窗口名关键字。' }],
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
      text: '明日方舟 World 已挂载。ark_connect / ark_screencap / ark_set_paused 可用；尚未连接游戏窗口，也还没有任何识别能力。',
    });
  }

  async stop(): Promise<void> {
    this.host = null;
    await this.session.stop();
  }

  private async connect(): Promise<ToolOutcome | string> {
    const result = await this.session.connect(this.opts.cfg);
    if (!result.ok) return fail(`连接失败：${result.error}`);
    this.host?.log.info('connected to arknights window');
    const [width, height] = result.resolution;
    return `已连接「${result.window.windowName}」（窗口类名 ${result.window.className}），截图分辨率 ${width}×${height}。`
      + '现在可以调用 ark_screencap 取画面，或 ark_set_paused 暂停/继续。';
  }

  private async screencap(): Promise<ToolOutcome> {
    const result = await this.session.screencap();
    if (!result.ok) return fail(`截图失败：${result.error}`);
    const at = new Date();
    const size = `${result.width}×${result.height}`;
    return {
      text: `已抓取一帧，${size}，PNG ${result.png.byteLength} 字节。这是本次调用时刻的画面，不保证与之后的状态一致。`,
      blobs: [
        {
          bytes: result.png,
          mime: SCREENSHOT_MIME,
          name: screenshotName(at),
          fallbackText: `明日方舟当前帧，${size}，PNG ${result.png.byteLength} 字节（端点不接受图片时只发送这句）。`,
        },
      ],
    };
  }

  private async setPaused(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    const paused = args.paused;
    if (typeof paused !== 'boolean') {
      return fail('参数 paused 必须是布尔值：true 表示暂停，false 表示继续。');
    }
    if (!this.session.connected) {
      return fail(`还没连接游戏窗口（${connectionLine(this.session)}），先调用 ark_connect。`);
    }
    const cfg = this.opts.cfg;
    const [width, height] = this.session.resolution;
    const { x, y } = toPoint(cfg.pauseButton, [width, height]);
    const clicked = await this.session.click(x, y);
    if (!clicked.ok) return fail(`点击失败：${clicked.error}`);
    const action = paused ? '暂停' : '继续';
    return `已向 (${x}, ${y}) 发送一次点击（按 ${width}×${height} 的 ${(cfg.pauseButton.x * 100).toFixed(1)}% / `
      + `${(cfg.pauseButton.y * 100).toFixed(1)}% 换算），意图是${action}。`
      + `这是点击回执，无法确认游戏是否真的${action}；需要确认请再调用 ark_screencap 自己看。`;
  }
}
