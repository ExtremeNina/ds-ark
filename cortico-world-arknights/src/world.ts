import { parseCopilotPlan, resolveActionTile } from './battle/copilot.ts';
import { compareFormation, fetchCopilotPlan } from './battle/copilot-fetch.ts';
import { getStageDimension } from './battle/tile-pos.ts';
import { findOperatorByName, parseVisibleOperators } from './battle/operators.ts';
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
import { pausePoint, toPoint } from './mfw/geometry.ts';
import type { OcrLine } from './mfw/ocr.ts';
import { SCREENSHOT_MIME, screenshotName } from './mfw/screen.ts';
import { ArknightsSession } from './mfw/session.ts';
import { roguelikeRoute, routeFor } from './nav/route.ts';
import { describeSanity, parseSanity, sanityEnough } from './nav/sanity.ts';
import { describeTrace } from './nav/trace.ts';

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
    name: 'ark_enter_stage',
    description:
      'Navigate to a stage with the built-in pipeline: ALL main-story stages (0-1, 1-7, 2-10, 3-8, etc.), '
      + 'resource stages (CE-5 / LS-5 / CA-5 / AP-5 / SK-5), chip stages (PR-A-1 and friends), and supported SideStory stages. '
      + 'ALWAYS call this tool whenever the user asks to go to ANY stage (e.g. 2-10 or 1-7); DO NOT manually click menus! '
      + 'It stops at the formation screen and never clicks 开始行动 unless start is true and the sanity check passes. '
      + 'The receipt carries the executed node trace, the frame and the sanity reading; on failure it says where it stopped and clicks nothing.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stage_code: {
          type: 'string',
          description: 'Stage code such as 1-7, 2-10, 3-8, CE-5, LS-5, PR-A-1 or AD-8.',
        },
        start: {
          type: 'boolean',
          description: 'Start the battle after reaching the formation screen. Default false; requires a readable sanity check.',
        },
      },
      required: ['stage_code'],
    },
  },
  {
    name: 'ark_open_roguelike',
    description:
      'Navigate to the home page of one Integrated Strategies theme (傀影 / 水月 / 萨米 / 萨卡兹 / 界园 / 黑流). '
      + 'It stops at the theme page and never clicks 开始探索, so no run is started and no resource is consumed. '
      + 'On failure it reports the executed node trace and the theme names currently visible.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        theme: {
          type: 'string',
          description: 'Theme keyword, e.g. 傀影, 水月, 萨米, 萨卡兹, 界园 or 黑流.',
        },
      },
      required: ['theme'],
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
        double: {
          type: 'boolean',
          description: 'Optional: send two rapid clicks (double click) to activate nodes on 3D maps without panning camera.',
        },
        holdMs: {
          type: 'number',
          description: 'Optional: hold the press down for this duration in milliseconds before releasing (0-3000, default 0).',
        },
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
  {
    name: 'ark_find_operators',
    description:
      'Recognise operator cards on screen (formation screen, operator picker, or roster). '
      + 'Returns detected operator names with normalised center coordinates (x, y). '
      + 'If name is provided, searches for that specific operator and optionally scrolls horizontally if not found.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          description: 'Optional: operator name to search for (e.g. "克洛丝"). If omitted, lists all visible operators.',
        },
        scroll: {
          type: 'boolean',
          description: 'Optional: if name is specified and not visible on screen, scroll the list to find them (default false).',
        },
      },
      required: [],
    },
  },
  {
    name: 'ark_run_copilot',
    description:
      'Execute an MAA Copilot battle plan JSON (or simplified JSON) during battle. '
      + 'Monitors DP (costs), triggers Deploy, SpeedUp, Skill, Retreat in sequence, and checks battle outcome (victory / defeat).',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan: {
          type: 'object',
          description: 'The Copilot plan object containing stage_name and actions array (Deploy, SpeedUp, Skill, Retreat).',
        },
        maxSeconds: {
          type: 'number',
          description: 'Maximum battle timeout in seconds (default 180, clamp 10-600).',
        },
      },
      required: ['plan'],
    },
  },
  {
    name: 'ark_fetch_copilot',
    description:
      'Fetch preset or local Copilot battle plans for a stage code (e.g. "2-10", "1-7"). '
      + 'If currentTeam is provided, checks for missing operators and provides team building recommendations.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stage: {
          type: 'string',
          description: 'Stage code (e.g. "2-10", "1-7", "0-1").',
        },
        currentTeam: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of operator names currently in your team, used to compare against the plan requirements.',
        },
      },
      required: ['stage'],
    },
  },
];

const fail = (text: string): ToolOutcome => ({ text, failed: true });

/** 失败回执里列当前画面文字，最多 12 行，避免把整屏倒进上下文。 */
function summarizeLines(lines: readonly OcrLine[], max = 12): string {
  const sorted = [...lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x).slice(0, max);
  return sorted.map((line) => `「${line.text}」`).join('、');
}

/** 配置里可能是旧值/脏值；导航的滑动上限必须是一个可用的正整数。 */
function scrollLimit(cfg: ArknightsConfigSection): number {
  const raw = cfg.navMaxScrolls;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(1, Math.min(20, Math.round(raw))) : 6;
}

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
        case 'ark_enter_stage':
          return { ...decl, handler: (args) => this.enterStage(args) };
        case 'ark_open_roguelike':
          return { ...decl, handler: (args) => this.openRoguelike(args) };
        case 'ark_wait':
          return { ...decl, handler: (args) => this.wait(args) };
        case 'ark_click':
          return { ...decl, handler: (args) => this.clickAt(args) };
        case 'ark_swipe':
          return { ...decl, handler: (args) => this.swipeTo(args) };
        case 'ark_find_operators':
          return { ...decl, handler: (args) => this.findOperators(args) };
        case 'ark_run_copilot':
          return { ...decl, handler: (args) => this.runCopilot(args) };
        case 'ark_fetch_copilot':
          return { ...decl, handler: (args) => this.fetchCopilotTool(args) };
        case 'ark_ocr':
          return { ...decl, handler: (args) => this.readAll(args) };
        default:
          return { ...decl, handler: async () => fail(`未实现的工具：${decl.name}`) };
      }
    });
  }

  /** 识别当前画面（编队页/干员选择页）中的干员 */
  private async findOperators(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('识别干员失败：还没连接游戏窗口，先调用 ark_connect。');
    const targetName = typeof args.name === 'string' ? args.name.trim() : '';
    const shouldScroll = args.scroll === true;

    let shot = await this.session.screencap();
    if (!shot.ok) return fail(`识别干员失败（抓帧失败）：${shot.error}`);
    let currentPng = shot.png;
    let ocr = await this.session.recognizeFrame(currentPng, this.opts.cfg.resourceDir);
    if (!ocr.ok) return fail(`识别干员失败（OCR失败）：${ocr.error}`);

    if (targetName) {
      let found = findOperatorByName(ocr.lines, targetName);
      let scrolled = 0;
      while (!found && shouldScroll && scrolled < 4) {
        await this.session.swipe(0.8, 0.5, 0.25, 0.5, 400);
        await new Promise((r) => setTimeout(r, 600));
        scrolled++;
        shot = await this.session.screencap();
        if (!shot.ok) break;
        currentPng = shot.png;
        ocr = await this.session.recognizeFrame(currentPng, this.opts.cfg.resourceDir);
        if (!ocr.ok) break;
        found = findOperatorByName(ocr.lines, targetName);
      }

      if (found) {
        return {
          text: `已找到干员【${found.name}】，中心归一化坐标 (${found.center.x}, ${found.center.y})。${scrolled > 0 ? `（翻页 ${scrolled} 次）` : ''}可以直接调用 ark_click 进行点选。`,
          blobs: [frameBlob(currentPng, found.name)],
        };
      }
      return {
        text: `在当前画面${scrolled > 0 ? `及翻页 ${scrolled} 次后` : ''}未找到干员【${targetName}】。`,
        blobs: [frameBlob(currentPng, '未找到干员')],
      };
    }

    const list = parseVisibleOperators(ocr.lines);
    if (list.length === 0) {
      return {
        text: '当前画面未检测到任何已知干员，请确认是否处于编队界面或干员选择名册。',
        blobs: [frameBlob(currentPng, '干员识别结果')],
      };
    }

    const details = list.map((o) => `- ${o.name}：坐标 (${o.center.x}, ${o.center.y})`).join('\n');
    return {
      text: `当前画面检测到 ${list.length} 位干员：\n${details}`,
      blobs: [frameBlob(currentPng, '干员识别结果')],
    };
  }

  /** 检索关卡 Copilot 作业并对比当前队伍 */
  private async fetchCopilotTool(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    const stage = typeof args.stage === 'string' ? args.stage.trim() : '';
    if (!stage) return fail('检索作业失败：缺少 stage 参数（如 "2-10"）。');

    const plan = fetchCopilotPlan(stage, this.opts.cfg.resourceDir);
    if (!plan) {
      return `未找到关卡【${stage}】的预置或本地作业。你可以让大模型根据战场自主编排 Copilot JSON 计划执行。`;
    }

    const currentTeam = Array.isArray(args.currentTeam)
      ? (args.currentTeam.filter((s) => typeof s === 'string') as string[])
      : [];

    let teamAnalysis = '';
    if (currentTeam.length > 0) {
      const cmp = compareFormation(plan, currentTeam);
      teamAnalysis = `\n\n【编队匹配分析】\n- 匹配干员：${cmp.matched.length > 0 ? cmp.matched.join('、') : '无'}\n- 缺少干员：${cmp.missing.length > 0 ? cmp.missing.join('、') : '无'}\n- 建议：${cmp.notes}`;
    }

    return `已成功获取关卡【${stage}】的 Copilot 作业：\n标题：${plan.doc?.title || stage}\n详情：${plan.doc?.details || '标准作业'}\n包含动作数：${plan.actions.length} 步${teamAnalysis}\n\n作业 JSON 内容：\n`
      + '```json\n' + JSON.stringify(plan, null, 2) + '\n```\n可直接将此 JSON 传给 ark_run_copilot 执行。';
  }

  /** 执行 Copilot 作业 */
  private async runCopilot(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('执行作业失败：还没连接游戏窗口，先调用 ark_connect。');
    const size = this.session.resolution;
    if (!size) return fail('执行作业失败：还没拿到画面尺寸，先调用 ark_screencap 取一帧。');

    const parsed = parseCopilotPlan(args.plan);
    if (!parsed.ok) return fail(parsed.error);
    const plan = parsed.plan;

    const maxSeconds = typeof args.maxSeconds === 'number' && Number.isFinite(args.maxSeconds)
      ? Math.max(10, Math.min(600, Math.round(args.maxSeconds)))
      : 180;

    const dimension = getStageDimension(plan.stage_name, this.opts.cfg.resourceDir);
    const logs: string[] = [];
    const startTime = Date.now();

    logs.push(`开始执行关卡【${plan.stage_name}】Copilot 作业，共 ${plan.actions.length} 步动作。`);

    let finalShot: Uint8Array | null = null;
    let battleFinished = false;
    let battleResultText = '战斗仍在进行或已超时';

    for (let i = 0; i < plan.actions.length; i++) {
      if (Date.now() - startTime > maxSeconds * 1000) {
        logs.push(`达到最大超时限制（${maxSeconds}秒），停止后续动作。`);
        break;
      }

      const act = plan.actions[i]!;
      const actType = act.type;

      // 检查战斗是否提前结束
      const shot = await this.session.screencap();
      if (shot.ok) {
        finalShot = shot.png;
        const ocr = await this.session.recognizeFrame(shot.png, this.opts.cfg.resourceDir);
        if (ocr.ok) {
          const state = parseBattleState(ocr.lines);
          if (state.result === 'victory') {
            logs.push('检测到【作战胜利】（行动结束）！');
            battleFinished = true;
            battleResultText = '作战胜利（行动结束）';
            break;
          }
          if (state.result === 'defeat') {
            logs.push('检测到【作战失败】！');
            battleFinished = true;
            battleResultText = '作战失败';
            break;
          }
        }
      }

      // 等待费用满足
      if (typeof act.costs === 'number' && act.costs > 0) {
        let waitCount = 0;
        while (waitCount < 20) {
          const s = await this.session.screencap();
          if (s.ok) {
            finalShot = s.png;
            const ocr = await this.session.recognizeFrame(s.png, this.opts.cfg.resourceDir);
            if (ocr.ok) {
              const state = parseBattleState(ocr.lines);
              if (state.result) {
                battleFinished = true;
                battleResultText = state.result === 'victory' ? '作战胜利（行动结束）' : '作战失败';
                break;
              }
              if (state.cost !== null && state.cost >= act.costs) {
                break;
              }
            }
          }
          await new Promise((r) => setTimeout(r, 1000));
          waitCount++;
        }
        if (battleFinished) break;
      }

      // 执行动作
      if (actType === 'SpeedUp' || actType === '二倍速') {
        // 2倍速按钮位置 (0.938, 0.052)
        const px = Math.round(0.938 * size[0]);
        const py = Math.round(0.052 * size[1]);
        await this.session.click(px, py);
        logs.push(`第 ${i + 1} 步：点击二倍速加速。`);
      } else if (actType === 'Deploy' || actType === '部署') {
        const tile = resolveActionTile(act, dimension);
        if (!tile) {
          logs.push(`第 ${i + 1} 步（部署 ${act.name || ''}）：缺少目标地块位置，已跳过。`);
          continue;
        }

        // 手牌区默认中右部 (x ≈ 0.82, y ≈ 0.88)
        const cardNorm = { x: 0.82, y: 0.88 };
        const dir = (act.direction?.toLowerCase() || 'right') as 'up' | 'down' | 'left' | 'right';
        const planned = planDeploy(cardNorm, tile, dir, size, {
          holdMs: this.opts.cfg.deployHoldMs,
          gapMs: this.opts.cfg.deployGapMs,
          directionMs: this.opts.cfg.deployDirectionMs,
        });

        if (planned.ok) {
          const { plan: dp } = planned;
          await this.session.swipe(dp.card.x, dp.card.y, dp.tile.x, dp.tile.y, dp.holdMs);
          if (dp.gapMs > 0) await new Promise((r) => setTimeout(r, dp.gapMs));
          await this.session.swipe(dp.tile.x, dp.tile.y, dp.release.x, dp.release.y, dp.directionMs);
          logs.push(`第 ${i + 1} 步：部署【${act.name || '干员'}】到地块 (${tile.x}, ${tile.y}) 朝向 ${dir}。`);
        } else {
          logs.push(`第 ${i + 1} 步：部署规划失败（${planned.error}）。`);
        }
      } else if (actType === 'Skill' || actType === '技能') {
        const tile = resolveActionTile(act, dimension);
        if (tile) {
          const px = Math.round(tile.x * size[0]);
          const py = Math.round(tile.y * size[1]);
          await this.session.click(px, py);
          await new Promise((r) => setTimeout(r, 200));
          // 点击技能按钮（干员头顶稍上方）
          await this.session.click(px, Math.max(0, py - 60));
          logs.push(`第 ${i + 1} 步：激活干员【${act.name || ''}】技能。`);
        }
      } else if (actType === 'Retreat' || actType === '撤退') {
        const tile = resolveActionTile(act, dimension);
        if (tile) {
          const px = Math.round(tile.x * size[0]);
          const py = Math.round(tile.y * size[1]);
          await this.session.click(px, py);
          await new Promise((r) => setTimeout(r, 200));
          // 点击撤退图标（左上方）
          await this.session.click(Math.max(0, px - 60), Math.max(0, py - 60));
          logs.push(`第 ${i + 1} 步：撤退干员【${act.name || ''}】。`);
        }
      }

      if (act.delay && act.delay > 0) {
        await new Promise((r) => setTimeout(r, Math.min(10000, act.delay!)));
      }
    }

    // 后续轮询直到战斗结束或超时
    if (!battleFinished) {
      logs.push('所有预定部署动作已下发，等待战斗自动进行至结算...');
      let pollCount = 0;
      while (pollCount < 30 && Date.now() - startTime < maxSeconds * 1000) {
        await new Promise((r) => setTimeout(r, 3000));
        pollCount++;
        const s = await this.session.screencap();
        if (s.ok) {
          finalShot = s.png;
          const ocr = await this.session.recognizeFrame(s.png, this.opts.cfg.resourceDir);
          if (ocr.ok) {
            const state = parseBattleState(ocr.lines);
            if (state.result === 'victory') {
              battleResultText = '作战胜利（行动结束）';
              battleFinished = true;
              break;
            }
            if (state.result === 'defeat') {
              battleResultText = '作战失败';
              battleFinished = true;
              break;
            }
          }
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const reportText = `Copilot 作业执行汇报：\n- 战果状态：${battleResultText}\n- 执行用时：${elapsed} 秒\n- 执行日志：\n${logs.map((l) => '  * ' + l).join('\n')}`;

    if (finalShot) {
      return {
        text: reportText,
        blobs: [frameBlob(finalShot, '战斗最终画面')],
      };
    }
    return reportText;
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
        + 'ark_enter_stage / ark_open_roguelike / ark_wait / ark_click / ark_swipe / ark_ocr 可用；'
        + '尚未连接游戏窗口。OCR 模型随包提供（resourceDir 仅用于覆盖），点击与拖拽都只保证「手势已发出」；'
        + '选关与集成战略入口用内置 pipeline，默认只到编队页/主题页，不替你开打。',
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

  /**
   * 跑一条导航 pipeline，并统一做「抓帧 + 识别 + 失败文案」。
   *
   * pipeline 只保证「点到了」，到这里还不算成功：终点画面要由这一帧的 OCR 复核。
   */
  private async runNavPipeline(
    entry: string,
    overrides: Record<string, unknown>,
    label: string,
  ): Promise<
    | { ok: true; png: Uint8Array; lines: OcrLine[]; size: readonly [number, number]; trace: string; elapsedMs: number }
    | { ok: false; text: string; png?: Uint8Array }
  > {
    const started = Date.now();
    const result = await this.session.runPipeline(entry, overrides, this.opts.cfg.resourceDir);
    const elapsedMs = Date.now() - started;
    const trace = describeTrace(result.trace);

    const shot = await this.session.screencap();
    if (!shot.ok) {
      return {
        ok: false,
        text: `${label}：pipeline ${result.ok ? '成功' : '失败'}，但补拍失败（${shot.error}）。轨迹：${trace}。`,
      };
    }
    const size = this.session.resolution;
    const ocr = await this.session.recognizeFrame(shot.png, this.opts.cfg.resourceDir);
    const lines = ocr.ok ? [...ocr.lines] : [];

    if (!result.ok) {
      const visible = lines.length > 0 ? `当前可见文字：${summarizeLines(lines)}。` : '这一帧没有读到文字。';
      return {
        ok: false,
        png: shot.png,
        text: `${label}失败：${result.error ?? 'pipeline 没有成功结束'}。轨迹：${trace}。${visible}`
          + '没有点击任何关卡/主题；需要时先用 ark_ocr 看画面，或让用户确认章节/活动是否已解锁。',
      };
    }
    if (!size) {
      return {
        ok: false,
        png: shot.png,
        text: `${label}：pipeline 报告成功，但读不出这一帧的尺寸，无法确认画面。轨迹：${trace}。`,
      };
    }
    return { ok: true, png: shot.png, lines, size: [size[0], size[1]], trace, elapsedMs };
  }

  /** 选关：资源本 / 芯片本 / 主线 / 已收录的 SideStory；默认停在编队页。 */
  private async enterStage(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('选关失败：还没连接游戏窗口，先调用 ark_connect。');
    const raw = typeof args.stage_code === 'string' ? args.stage_code : '';
    const planned = routeFor(raw, { maxScrolls: scrollLimit(this.opts.cfg) });
    if (!planned.ok) return fail(planned.error);
    const route = planned.route;
    const fallback = `${route.label}导航后的画面`;

    const run = await this.runNavPipeline(route.entry, route.overrides, route.label);
    if (!run.ok) {
      return {
        text: run.text,
        failed: true,
        ...(run.png ? { blobs: [frameBlob(run.png, fallback)] } : {}),
      };
    }

    // pipeline 只负责点到；终点是不是编队页，以这一帧的 OCR 为准。
    const formation = run.lines.some((line) => /开始行动|代理指挥/.test(line.text));
    if (!formation) {
      return {
        text: `pipeline 报告成功，但当前画面里没读到「开始行动」，不能确认已到编队页（${route.label}）。`
          + `轨迹：${run.trace}。附件是当前帧。`,
        failed: true,
        blobs: [frameBlob(run.png, fallback)],
      };
    }

    const sanity = parseSanity(run.lines);
    const sanityText = describeSanity(sanity);
    const head = `已到编队界面（${route.label}）。轨迹：${run.trace}。用时 ${run.elapsedMs}ms。${sanityText}。`;

    if (args.start !== true) {
      return {
        text: `${head}没有点击「开始行动」——确认要消耗理智后，再调用 ark_click 点它，或传 start: true。`,
        blobs: [frameBlob(run.png, fallback)],
      };
    }

    const enough = sanityEnough(sanity);
    if (enough !== true) {
      return {
        text: `${head}${enough === false ? '理智不够' : '读不出这次消耗或当前理智'}，因此没有点击「开始行动」。`,
        blobs: [frameBlob(run.png, fallback)],
      };
    }

    const startLine = run.lines.find((line) => line.text.includes('开始行动'));
    if (!startLine) {
      return {
        text: `${head}没有找到「开始行动」的文字框，因此没有点击。`,
        failed: true,
        blobs: [frameBlob(run.png, fallback)],
      };
    }
    const at = toPoint(
      { x: startLine.box.x + startLine.box.w / 2, y: startLine.box.y + startLine.box.h / 2 },
      run.size,
    );
    const clicked = await this.session.click(at.x, at.y);
    if (!clicked.ok) return fail(`已到编队界面（${route.label}），但点击「开始行动」失败：${clicked.error}`);
    return this.withAfterFrame(`${head}已点击「开始行动」（${at.x}, ${at.y}）。`, '开始行动');
  }

  /** 集成战略：只到指定主题主页，不点「开始探索」。 */
  private async openRoguelike(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('打开集成战略失败：还没连接游戏窗口，先调用 ark_connect。');
    const theme = typeof args.theme === 'string' ? args.theme.trim() : '';
    const planned = roguelikeRoute(theme, { maxScrolls: scrollLimit(this.opts.cfg) });
    if (!planned.ok) return fail(planned.error);
    const route = planned.route;
    const fallback = `${route.label}主题页`;

    const run = await this.runNavPipeline(route.entry, route.overrides, route.label);
    if (!run.ok) {
      return {
        text: run.text.replace('没有点击任何关卡/主题', '没有点击任何主题，也没有点「开始探索」'),
        failed: true,
        ...(run.png ? { blobs: [frameBlob(run.png, fallback)] } : {}),
      };
    }

    const home = run.lines.some((line) => /开始探索|深入调查/.test(line.text));
    if (!home) {
      return {
        text: `pipeline 报告成功，但当前画面里没读到「开始探索」，不能确认已到「${theme}」主题页。`
          + `轨迹：${run.trace}。附件是当前帧。`,
        failed: true,
        blobs: [frameBlob(run.png, fallback)],
      };
    }

    return {
      text: `已到「${theme}」主题页面（读到「开始探索」）。轨迹：${run.trace}。用时 ${run.elapsedMs}ms。`
        + '没有点击「开始探索」——确认要开一局再自己点，或让用户决定。',
      blobs: [frameBlob(run.png, fallback)],
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

    const planned = planClick({ x: args.x, y: args.y }, size, { double: args.double, holdMs: args.holdMs });
    if (!planned.ok) return fail(planned.error);
    const { at, double, holdMs } = planned.plan;

    const clicked = await this.session.click(at.x, at.y, { double, holdMs });
    if (!clicked.ok) return fail(clicked.error);

    const actionDesc = double ? '双击' : holdMs ? `长按（${holdMs}ms）` : '点击';
    const receipt = `已向 (${at.x}, ${at.y}) 发送一次${actionDesc}（按 ${size[0]}×${size[1]} 换算）。`;
    const expect = typeof args.expect === 'string' ? args.expect.trim() : '';
    if (!expect) return this.withAfterFrame(receipt, actionDesc);
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
    const target = expect.toLowerCase();
    for (;;) {
      // 预算里也包含抓帧与 OCR 的耗时：否则「最多 10 秒」会变成「最多 10 秒 + 十几次识别」。
      const remaining = budget - (Date.now() - started);
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
      const shot = await this.session.screencap();
      if (!shot.ok) return `${receipt}复核失败（${shot.error}），无法确认「${expect}」是否出现。`;
      const ocr = await this.session.recognizeFrame(shot.png, this.opts.cfg.resourceDir);
      if (!ocr.ok) return `${receipt}复核失败（${ocr.error}），无法确认「${expect}」是否出现。`;
      if (ocr.lines.some((line) => line.text.toLowerCase().includes(target))) {
        return `${receipt}约 ${Date.now() - started}ms 后画面里出现了「${expect}」。`;
      }
    }
    return `${receipt}在 ${budget}ms 内没在画面里读到「${expect}」；这不代表点击一定没生效，`
      + '可能只是文字没被识别、或界面还在加载。';
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
      + '（按从上到下、从左到右排序；中心与框都是归一化坐标，框是 x,y,w,h）：';
    const body = lines.slice(0, maxLines).map((line) => {
      const { x, y, w, h } = line.box;
      const centerX = x + w / 2;
      const centerY = y + h / 2;
      const px = `${Math.round(centerX * frame[0])},${Math.round(centerY * frame[1])}`;
      return `「${line.text}」 中心 ${centerX.toFixed(3)},${centerY.toFixed(3)}（像素 ${px}）`
        + `　框 ${x.toFixed(3)},${y.toFixed(3)} ${w.toFixed(3)},${h.toFixed(3)}`;
    }).join('\n');
    const tail = lines.length > maxLines
      ? `\n（只列前 ${maxLines} 行，共 ${lines.length} 行；要全部就把 maxLines 调大，上限 200）`
      : '';
    return `${head}\n${body}${tail}\n找按钮就用上面的「中心」坐标调 ark_click；这一步只读，没有点击。`;
  }
}
