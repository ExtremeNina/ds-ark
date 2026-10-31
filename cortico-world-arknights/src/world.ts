import { parseCopilotPlan, resolveActionTile, resolveHandCardPosition } from './battle/copilot.ts';
import { compareFormation, fetchCopilotPlan } from './battle/copilot-fetch.ts';
import { executeCopilotPlan, validatePlanTiles } from './battle/copilot-executor.ts';
import { getStageDimension, loadStageMapInfo } from './battle/tile-pos.ts';
import { findOperatorByName, parseVisibleOperators } from './battle/operators.ts';
import { OperatorDatabase } from './battle/operator-db.ts';
import {
  formatRoguelikeStrategyText,
  loadRoguelikeStrategyInfo,
  normalizeRoguelikeMode,
  normalizeRoguelikeTheme,
  normalizeRoleName,
  normalizeSquadName,
  type RoguelikeTheme,
} from './battle/roguelike.ts';
import { executeRoguelike } from './battle/roguelike-executor.ts';
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
      '【调试专用 / 实战严禁调用】Drag one hand card onto a battlefield tile. '
      + '注意：实战中严禁单步手动拖拽部署干员（网络与推理延迟会导致漏怪败北）。无论抄作业还是自创编队打关，必须将部署计划组装为 Copilot plan 传入 ark_run_copilot 由 MaaCore 原生引擎全权托管战斗！',
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
      'Recognise operator cards on screen (formation screen, operator picker, or roster ONLY; NOT in battle). '
      + '识别编队界面或干员名册中的干员，获取干员名字与位置。注意：严禁在战斗中调用此工具识别手牌！战斗开始后一律直接调用 ark_run_copilot 由 MaaCore 原生引擎自动识别人脸下人。',
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
      'Execute an MAA Copilot battle plan JSON via native MaaCore engine. '
      + '最佳调用时机为【编队界面】（包含红色开始行动按钮处），由 MaaCore 自主点击开始行动进入战场并全权接管控费、识别人脸卡牌、吸附地块并放技能直至结算；若已处于战场内，系统会自动由内置轻量引擎接管部署。实战中所有战斗一律通过此工具全托管，严禁手动逐个拖拽部署。',
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
        async: {
          type: 'boolean',
          description: 'Optional: execute battle in background asynchronously (default true). When true, returns immediately so you can comment on the screen and inspect frames with ark_screencap while the engine fights. Battle settlement is pushed as an event.',
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
  {
    name: 'ark_get_stage_map',
    description:
      'Query the static grid and tactical terrain layout of a stage (from MAA official Arknights-Tile-Pos). '
      + '获取指定关卡的静态地图网格情报。清晰标明所有地面地块（可部署先锋/近卫/重装）、高台地块（可部署狙击/术师/医疗/辅助）、障碍禁区，以及敌方红门和我方蓝门坐标。在编队界面规划 Copilot 部署 plan 前必须调用，杜绝把狙击放在地面或近卫放在高台的错误。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stage_code: {
          type: 'string',
          description: '关卡编号，如 "1-7", "2-10", "0-1" 等。',
        },
      },
      required: ['stage_code'],
    },
  },
  {
    name: 'ark_run_roguelike',
    description:
      'Execute Integrated Strategies (Roguelike / 肉鸽) full exploration via native MaaCore engine. '
      + '支持黑流树海 (BlackFlow)、萨卡兹 (Sarkaz)、萨米 (Sami)、水月 (Mizuki)、傀影 (Phantom) 全主题！'
      + '由底层 MaaCore 自动寻路大地图、选择节点、招募干员、购买藏品并全自动接管局内战斗部署。'
      + '任务将在后台异步执行，启动后立即返回；探索期间大模型可随时截屏并与博士自由发声互动解说。',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        theme: {
          type: 'string',
          description: '肉鸽主题：BlackFlow (黑流树海), Sarkaz (萨卡兹), Sami (萨米), Mizuki (水月), Phantom (傀影)。默认为 BlackFlow。',
        },
        mode: {
          type: 'number',
          description: '探索模式：0: 常规探索通关(默认), 1: 刷源石锭(存钱模式)。',
        },
        starts_count: {
          type: 'number',
          description: '探索轮数（默认 1）。',
        },
        stop_at_final_stage: {
          type: 'boolean',
          description: '是否在关底 Boss 战前停手并通知博士（便于人机接力打终局），默认 false。',
        },
        investment_withdrawn: {
          type: 'boolean',
          description: '缺钱时是否允许从行商处取款，默认 false。',
        },
        use_assist: {
          type: 'boolean',
          description: '是否借助战干员，默认 false。',
        },
        squad: {
          type: 'string',
          description: '开局分队名称，如「指挥分队」、「突击战术分队」、「蓝图测绘分队」等。',
        },
        roles: {
          type: 'string',
          description: '开局招募职业组合，如「先手必胜」、「攻守兼备」、「取长补短」、「随心所欲」。',
        },
        core_char: {
          type: 'string',
          description: '开局首选核心干员，如「维什戴尔」、「机械师」等。',
        },
        interactive_recruit: {
          type: 'boolean',
          description: '局中遇到招募节点时，是否暂停自动点击交由大模型自主决策（方案A，默认 true）。',
        },
        interactive_squad: {
          type: 'boolean',
          description: '是否在开局分队选择界面暂停，交由大模型自主看屏决策（默认 true）。',
        },
        interactive_route: {
          type: 'boolean',
          description: '是否在大地图路线分支选择时暂停，交由大模型自主规划路线（默认 true）。',
        },
      },
      required: [],
    },
  },
  {
    name: 'ark_roguelike_strategy',
    description:
      'Query recommended operator recruitment priorities and key relic ratings for a Roguelike theme (from MAA official data). '
      + '查询指定肉鸽主题的官方战略秘籍（来自 MAA 官方 recruitment.json 与 shopping.json）。'
      + '包括核心首发干员、职业进阶优先级与商店高价值藏品。对局前向博士提出战前流派与阵容建议时必查！',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        theme: {
          type: 'string',
          description: '肉鸽主题：BlackFlow (黑流树海), Sarkaz (萨卡兹), Sami (萨米), Mizuki (水月), Phantom (傀影)。默认为 BlackFlow。',
        },
      },
      required: [],
    },
  },
  {
    name: 'ark_roguelike_select_recruit',
    description:
      'Selects a recruitment ticket or operator during Roguelike recruitment prompt and resumes exploration. '
      + '在集成战略（肉鸽）遇到干员招募界面时（收到 arknights.roguelike_recruit_prompt 通知），'
      + '大模型自主指定职业券、目标干员、卡片序号(slot)或坐标完成招募决策，底层执行点击并恢复全权探索。',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ticket: {
          type: 'string',
          description: '选中的招募职业券名称（如 先锋 / 近卫 / 狙击 / 重装 / 医疗 / 辅助 / 术师 / 特种）。若已在干员名单界面可不传。',
        },
        operator: {
          type: 'string',
          description: '选中的干员全名（如 锏、维什戴尔、玛恩纳、机械师）。底层会自动 OCR 定位卡片并点击。',
        },
        slot: {
          type: 'number',
          description: '招募干员卡片序号（1~12，从左到右、从上到下按 3列×4行 网格排列）。当 OCR 无法识别艺术字姓名时，强烈建议直接根据画面卡片位置传入 slot 序号！',
        },
        x: {
          type: 'number',
          description: '卡片中心归一化横坐标 x (0.0~1.0)。',
        },
        y: {
          type: 'number',
          description: '卡片中心归一化纵坐标 y (0.0~1.0)。',
        },
        skip: {
          type: 'boolean',
          description: '是否跳过/放弃本次招募。',
        },
      },
      required: [],
    },
  },
  {
    name: 'ark_roguelike_select_squad',
    description:
      'Selects an initial squad or recruit roles composition during Roguelike start and resumes exploration. '
      + '在集成战略（肉鸽）开局分队选择界面或招募组合选择界面（收到 arknights.roguelike_squad_prompt 通知），'
      + '大模型自主选定分队或招募组合（按名称 roles/squad、槽位序号 slot 或归一化坐标 x, y）并恢复全权探索。',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        squad: {
          type: 'string',
          description: '分队名称（如 指挥分队、集群分队、后勤分队、突击战术分队、堡垒战术分队、远程战术分队、破坏战术分队）。底层会自动 OCR 匹配点击。',
        },
        roles: {
          type: 'string',
          description: '开局职业招募组合名称（如 攻守兼备、先手必胜、取长补短、坚不可摧、灵活部署、随心所欲）。底层会自动匹配卡片并点击。',
        },
        slot: {
          type: 'number',
          description: '卡片序号（1~6）。若 OCR 未能识别文字，可直接传序号定位。',
        },
        x: {
          type: 'number',
          description: '目标选项的归一化横坐标 x (0.0~1.0)。',
        },
        y: {
          type: 'number',
          description: '目标选项的归一化纵坐标 y (0.0~1.0)。',
        },
      },
      required: [],
    },
  },
  {
    name: 'ark_roguelike_select_node',
    description:
      'Selects a route node on the Roguelike map and resumes exploration. '
      + '在集成战略（肉鸽）大地图路线规划时（收到 arknights.roguelike_node_prompt 通知），'
      + '大模型自主选择前进节点（按节点类型文字、分支序号或归一化坐标）并恢复全权探索。',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          description: '目标节点类型或名称（如 作战、紧急作战、诡意行商、不期而遇、安全的角落、得失、命运所指）。底层会自动匹配节点。',
        },
        index: {
          type: 'number',
          description: '前方分支序号（从上到下或从左到右 1、2、3）。',
        },
        x: {
          type: 'number',
          description: '目标节点的归一化横坐标 x (0.0~1.0)。',
        },
        y: {
          type: 'number',
          description: '目标节点的归一化纵坐标 y (0.0~1.0)。',
        },
      },
      required: [],
    },
  },
  {
    name: 'ark_roguelike_confirm_formation',
    description:
      'Confirm team formation in Roguelike pre-battle and resume MAA AutoBattle. '
      + '在集成战略（肉鸽）战前编队界面（收到 arknights.roguelike_formation_prompt 通知），'
      + '大模型完成出战阵容调整后调用此工具，点击“开始行动”进入战场，由 MAA 原生引擎接管局内战斗自适应部署与技能释放。',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: 'ark_stop_roguelike',
    description:
      'Emergency stop for running Roguelike exploration. '
      + '紧急终止正在后台运行的集成战略（肉鸽）探索，杀死底层后台子进程，释放所有互斥锁并立即将鼠标与操作控制权归还博士。',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
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
  private isBattleRunning = false;
  private activeBattleStage = '';
  private isRoguelikeRunning = false;
  private isRoguelikeRecruitPending = false;
  private isRoguelikeSquadPending = false;
  private isRoguelikeNodePending = false;
  private isRoguelikeTicketPending = false;
  private isRoguelikeFormationPending = false;
  private activeRoguelikeTheme = '';
  private roguelikeResumeControl: (() => void) | null = null;
  private roguelikeKillControl: (() => void) | null = null;

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
        case 'ark_get_stage_map':
          return { ...decl, handler: (args) => this.getStageMap(args) };
        case 'ark_run_roguelike':
          return { ...decl, handler: (args) => this.runRoguelike(args) };
        case 'ark_roguelike_strategy':
          return { ...decl, handler: (args) => this.roguelikeStrategy(args) };
        case 'ark_roguelike_select_recruit':
          return { ...decl, handler: (args) => this.selectRoguelikeRecruit(args) };
        case 'ark_roguelike_select_squad':
          return { ...decl, handler: (args) => this.selectRoguelikeSquad(args) };
        case 'ark_roguelike_select_node':
          return { ...decl, handler: (args) => this.selectRoguelikeNode(args) };
        case 'ark_roguelike_confirm_formation':
          return { ...decl, handler: () => this.confirmRoguelikeFormation() };
        case 'ark_stop_roguelike':
          return { ...decl, handler: () => this.stopRoguelike() };
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
        const db = OperatorDatabase.getInstance(this.opts.cfg.resourceDir);
        const op = db.getOperator(found.name);
        const attrStr = op
          ? ` 【${op.profession} | 站位:${op.positionZh} | ${op.rarity}星】`
          : '';
        return {
          text: `已找到干员【${found.name}】${attrStr}，中心归一化坐标 (${found.center.x}, ${found.center.y})。${scrolled > 0 ? `（翻页 ${scrolled} 次）` : ''}可以直接调用 ark_click 进行点选。`,
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
        text: '当前画面未检测到任何已知干员，请确认是否处于编队界面或干员选择名册。\n'
          + '【重要提醒】本工具仅在「编队界面」用于获取队伍 12 人并构思 Copilot plan；严禁在「战斗中」调用本工具识别手牌！'
          + '战斗中手牌下人完全由 MaaCore 原生引擎（ark_run_copilot）自动识别人脸和费用并部署，进入战斗后请直接调用 ark_run_copilot { plan }。',
        blobs: [frameBlob(currentPng, '干员识别结果')],
      };
    }

    const db = OperatorDatabase.getInstance(this.opts.cfg.resourceDir);
    const details = list
      .map((o) => {
        const op = db.getOperator(o.name);
        const attrStr = op
          ? ` 【${op.profession} | 站位:${op.positionZh} | ${op.rarity}星】`
          : '';
        return `- ${o.name}：坐标 (${o.center.x}, ${o.center.y})${attrStr}`;
      })
      .join('\n');
    return {
      text: `当前画面检测到 ${list.length} 位干员：\n${details}`,
      blobs: [frameBlob(currentPng, '干员识别结果')],
    };
  }

  /** 获取关卡静态战术地图情报 */
  private async getStageMap(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    const stageCode = typeof args.stage_code === 'string' ? args.stage_code.trim() : '';
    if (!stageCode) return fail('获取地图失败：未指定 stage_code（例如 "1-7", "2-10"）。');

    const mapInfo = loadStageMapInfo(stageCode, this.opts.cfg.resourceDir);
    if (!mapInfo) {
      return fail(`未找到关卡【${stageCode}】的静态地图数据。请确认关卡代码是否正确（如 "1-7"）。`);
    }

    const text = `关卡【${mapInfo.code} ${mapInfo.name}】静态战术地图（尺寸：${mapInfo.width}列 × ${mapInfo.height}行）：\n\n`
      + `${mapInfo.asciiGrid}\n\n`
      + `图例说明：\n`
      + `- S: 敌方红门出生点 (${mapInfo.startTiles.map(([c, r]) => `[${c},${r}]`).join(', ')})\n`
      + `- E: 我方蓝门保护点 (${mapInfo.endTiles.map(([c, r]) => `[${c},${r}]`).join(', ')})\n`
      + `- M: 地面地块 (仅可部署 先锋/近卫/重装 等地面干员，共 ${mapInfo.meleeTiles.length} 格)\n`
      + `  地面候选坐标: ${mapInfo.meleeTiles.map(([c, r]) => `[${c},${r}]`).join(', ')}\n`
      + `- R: 高台地块 (仅可部署 狙击/术师/医疗/辅助 等高台干员，共 ${mapInfo.rangedTiles.length} 格)\n`
      + `  高台候选坐标: ${mapInfo.rangedTiles.map(([c, r]) => `[${c},${r}]`).join(', ')}\n`
      + `- .: 障碍物/禁区 (不可部署)\n\n`
      + `【部署铁律】规划 Copilot plan actions 时，严禁把高台干员（狙击/术师/医疗/辅助）放到 M 格，严禁把地面干员（先锋/近卫/重装）放到 R 格！`;

    return { text };
  }

  /** 检索关卡 Copilot 作业并对比当前队伍 */
  private async fetchCopilotTool(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    const stage = typeof args.stage === 'string' ? args.stage.trim() : '';
    if (!stage) return fail('检索作业失败：缺少 stage 参数（如 "2-10"）。');

    const plan = await fetchCopilotPlan(stage, this.opts.cfg.resourceDir);
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

    if (this.isBattleRunning) {
      return fail(`【操作拦截】关卡「${this.activeBattleStage || '当前战斗'}」正在后台全权托管中，严禁重复提交作战计划！请调用 ark_screencap / ark_battle_state 观察画面并向博士解说战况。`);
    }

    const parsed = parseCopilotPlan(args.plan);
    if (!parsed.ok) return fail(parsed.error);
    const plan = parsed.plan;

    // 前置静态地块合法性校验（防呆：高台狙击下地面等）
    const tileValidation = validatePlanTiles(plan, this.opts.cfg.resourceDir);
    if (!tileValidation.ok) {
      return fail(tileValidation.reason ?? '部署地块校验失败：存在非法地块部署。');
    }

    // 关卡时序防呆与自动补齐（针对 1-7 等定型关卡）
    if (plan.stage_name === '1-7') {
      for (const act of plan.actions) {
        // 银灰开技能若缺少延迟，自动注入 5000ms 初动 CD 保护
        if ((act.type === 'Skill' || act.type === '技能') && (act.name?.includes('银灰') || (!act.name && Array.isArray(act.location) && act.location[0] === 1 && act.location[1] === 3))) {
          if (!act.pre_delay || act.pre_delay < 1000) {
            act.pre_delay = 5000;
          }
        }
      }
      // 娜仁图亚若已部署但遗漏了 Skill 动作，自动补上 3s 技能动作
      const hasNarenDeploy = plan.actions.some((a) => (a.type === 'Deploy' || a.type === '部署') && (a.name?.includes('娜仁图亚') || (Array.isArray(a.location) && a.location[0] === 1 && a.location[1] === 2)));
      const hasNarenSkill = plan.actions.some((a) => (a.type === 'Skill' || a.type === '技能') && (a.name?.includes('娜仁图亚') || (Array.isArray(a.location) && a.location[0] === 1 && a.location[1] === 2)));
      if (hasNarenDeploy && !hasNarenSkill) {
        plan.actions.push({
          type: 'Skill',
          name: '娜仁图亚',
          location: [1, 2],
          pre_delay: 3000,
        });
      }

      // 同步回写入传入的 args.plan（若为对象），方便调用方感知与断言
      if (args.plan && typeof args.plan === 'object') {
        const rawObj = args.plan as Record<string, unknown>;
        rawObj.actions = plan.actions;
      }
    }

    const maxSeconds = typeof args.maxSeconds === 'number' && Number.isFinite(args.maxSeconds)
      ? Math.max(10, Math.min(600, Math.round(args.maxSeconds)))
      : 180;

    const tasker = this.session.runtimeInstance?.taskerInstance ?? null;
    const resource = this.session.runtimeInstance?.resourceInstance ?? null;

    const isAsync = args.async !== false;

    if (isAsync) {
      this.isBattleRunning = true;
      this.activeBattleStage = plan.stage_name;

      // 启动后台异步任务，不阻塞当前工具调用回执
      (async () => {
        try {
          const outcome = await executeCopilotPlan({
            plan,
            cfg: this.opts.cfg,
            session: this.session,
            tasker,
            resource,
            maxSeconds,
          });

          if (this.host) {
            const reportText = `【战斗托管结束通知】关卡「${plan.stage_name}」战斗已结算！\n`
              + `- 最终战果：${outcome.resultText}\n`
              + `- 执行引擎：${outcome.engine === 'maacore' ? 'MaaCore 原生全权托管' : '内置轻量解释器'}\n`
              + `- 战斗耗时：${(outcome.durationMs / 1000).toFixed(1)} 秒\n`
              + `- 日志记录：\n${outcome.logs.map((l) => '  * ' + l).join('\n')}\n`
              + `请向博士进行终局战报总结与汇报！`;

            await this.host.pushEvent({
              type: 'arknights.battle_settled',
              ts: nowIso(this.opts.timezone),
              source: this.id,
              origin: 'internal',
              senderKey: this.id,
              text: reportText,
            });
          }
        } catch (err) {
          if (this.host) {
            await this.host.pushEvent({
              type: 'arknights.battle_error',
              ts: nowIso(this.opts.timezone),
              source: this.id,
              origin: 'internal',
              senderKey: this.id,
              text: `【战斗托管异常通知】关卡「${plan.stage_name}」后台托管发生异常：${String(err)}`,
            });
          }
        } finally {
          this.isBattleRunning = false;
          this.activeBattleStage = '';
        }
      })();

      return `【Copilot 全权托管已在后台启动】关卡「${plan.stage_name}」托管任务已交由底层引擎执行！\n`
        + `底层正在毫秒级自动监控费用、识别人脸、精准落位与适时释放技能。\n\n`
        + `【战中积极互动契约】你拥有自由发言与读屏能力！在战斗托管进行期间（结算前）：\n`
        + `1. 必须每隔 5~10 秒调用一次 ark_screencap 看看屏幕，且每次看屏后必须立即调用 pet_say 和博士说话互动！\n`
        + `2. 发言内容完全自由开放：不限于机械的战况播报，可以是你的心里话、对干员/源石虫的吐槽、自言自语、碎碎念、或者是关心博士的日常闲聊（例如：“银灰挥剑姿势还挺帅的”、“这群虫子排队送走真解压~”、“本鲸盯着呢，博士今天喝水了吗？”、“娜仁图亚这个高台射程真远呀”）；\n`
        + `3. 核心是保持陪伴感与活跃度，严禁只调用 ark_wait 默默等待而不说话！\n`
        + `4. 加载界面的背景小字（如演习提示等）仅为游戏通用贴士，切勿纠结，全心享受和博士的摸鱼互动；\n`
        + `5. 战斗结算后系统将自动推送结算事件（arknights.battle_settled），届时再向博士做终局总结汇报。`;
    }

    // 同步执行模式（兼容测试或显式要求等待回执）
    this.isBattleRunning = true;
    this.activeBattleStage = plan.stage_name;
    try {
      const outcome = await executeCopilotPlan({
        plan,
        cfg: this.opts.cfg,
        session: this.session,
        tasker,
        resource,
        maxSeconds,
      });

      const reportText = `Copilot 作业执行汇报：\n- 执行引擎：${outcome.engine === 'maacore' ? 'MaaCore 原生全权托管' : '内置轻量解释器'}\n- 战果状态：${outcome.resultText}\n- 执行用时：${(outcome.durationMs / 1000).toFixed(1)} 秒\n- 执行日志：\n${outcome.logs.map((l) => '  * ' + l).join('\n')}`;

      if (outcome.finalShot) {
        return {
          text: reportText,
          blobs: [frameBlob(outcome.finalShot, '战斗最终画面')],
        };
      }
      return reportText;
    } finally {
      this.isBattleRunning = false;
      this.activeBattleStage = '';
    }
  }

  /** 查询集成战略官方推荐战略秘籍（干员抓取优先级与核心藏品） */
  private async roguelikeStrategy(args: Record<string, unknown>): Promise<string> {
    const rawTheme = typeof args.theme === 'string' ? args.theme : 'BlackFlow';
    const theme = normalizeRoguelikeTheme(rawTheme);
    const info = loadRoguelikeStrategyInfo(theme, this.opts.cfg.resourceDir);
    if (!info) {
      return `未能读取主题【${theme}】的策略配置，请确认 MAA 资源目录中是否存在 roguelike/${theme} 目录。`;
    }
    return formatRoguelikeStrategyText(info);
  }

  /** 肉鸽局中遇到招募节点时，大模型自主选择职业券与目标干员（方案A） */
  private async selectRoguelikeRecruit(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('招募决策失败：尚未连接游戏窗口。');

    const ticket = typeof args.ticket === 'string' ? args.ticket.trim() : undefined;
    const operator = typeof args.operator === 'string' ? args.operator.trim() : undefined;
    const slot = typeof args.slot === 'number' && Number.isFinite(args.slot) ? Math.round(args.slot) : undefined;
    const x = typeof args.x === 'number' && Number.isFinite(args.x) ? args.x : undefined;
    const y = typeof args.y === 'number' && Number.isFinite(args.y) ? args.y : undefined;
    const skip = args.skip === true;

    const shot1 = await this.session.screencap();
    if (!shot1.ok) return fail(`招募决策失败（抓帧失败）：${shot1.error}`);
    const frame = await this.session.recognizeFrame(shot1.png, this.opts.cfg.resourceDir);
    if (!frame.ok) return fail('招募决策失败：无法识别当前游戏画面文字。');

    const lines = frame.lines;

    if (skip) {
      const skipBtn = lines.find((l) => l.text.includes('放弃') || l.text.includes('跳过') || l.text.includes('离开'));
      if (skipBtn) {
        await this.session.click(skipBtn.box.x + skipBtn.box.w / 2, skipBtn.box.y + skipBtn.box.h / 2);
        await new Promise((r) => setTimeout(r, 600));
      }
      if (this.isRoguelikeRunning) {
        this.isRoguelikeRecruitPending = false;
        this.roguelikeResumeControl?.();
      }
      return '【招募跳过】已点击放弃/跳过本次招募，恢复后台全权托管！';
    }

    if (ticket) {
      const ticketTarget = lines.find((l) => l.text.includes(ticket));
      if (ticketTarget) {
        await this.session.click(ticketTarget.box.x + ticketTarget.box.w / 2, ticketTarget.box.y + ticketTarget.box.h / 2);
        await new Promise((r) => setTimeout(r, 1000));
      }
      this.isRoguelikeTicketPending = false;
      // 若本次只传了 ticket 而没有传具体干员/slot，说明博士是在第一阶段单独选券，选完后继续等待干员候选界面就绪
      if (!operator && slot === undefined && x === undefined) {
        return `【肉鸽选券决策已执行】成功挑选职业券【${ticket}】，正等待进入干员候选列表！`;
      }
    }

    if (slot !== undefined && slot >= 1 && slot <= 12) {
      // 3 列 × 4 行 卡片网格分布
      const col = (slot - 1) % 3;
      const row = Math.floor((slot - 1) / 3);
      const xs = [0.42, 0.66, 0.90];
      const ys = [0.24, 0.42, 0.60, 0.78];
      const targetX = xs[col];
      const targetY = ys[row];
      await this.session.click(targetX, targetY);
      await new Promise((r) => setTimeout(r, 800));

      const shot3 = await this.session.screencap();
      if (shot3.ok) {
        const confirmRecheck = await this.session.recognizeFrame(shot3.png, this.opts.cfg.resourceDir);
        if (confirmRecheck.ok) {
          const confirmBtn = confirmRecheck.lines.find((l) =>
            (l.text.includes('确定') || l.text.includes('确认') || l.text.includes('招募')) &&
            l.box.x > 0.6 && l.box.y > 0.6
          );
          if (confirmBtn) {
            await this.session.click(confirmBtn.box.x + confirmBtn.box.w / 2, confirmBtn.box.y + confirmBtn.box.h / 2);
            await new Promise((r) => setTimeout(r, 800));
          }
        }
      }
    } else if (x !== undefined && y !== undefined) {
      await this.session.click(x, y);
      await new Promise((r) => setTimeout(r, 800));

      const shot3 = await this.session.screencap();
      if (shot3.ok) {
        const confirmRecheck = await this.session.recognizeFrame(shot3.png, this.opts.cfg.resourceDir);
        if (confirmRecheck.ok) {
          const confirmBtn = confirmRecheck.lines.find((l) =>
            (l.text.includes('确定') || l.text.includes('确认') || l.text.includes('招募')) &&
            l.box.x > 0.6 && l.box.y > 0.6
          );
          if (confirmBtn) {
            await this.session.click(confirmBtn.box.x + confirmBtn.box.w / 2, confirmBtn.box.y + confirmBtn.box.h / 2);
            await new Promise((r) => setTimeout(r, 800));
          }
        }
      }
    } else if (operator) {
      const shot2 = await this.session.screencap();
      const recheck = shot2.ok ? await this.session.recognizeFrame(shot2.png, this.opts.cfg.resourceDir) : frame;
      const curLines = recheck.ok ? recheck.lines : lines;
      const operTarget = curLines.find((l) => l.text.includes(operator));
      if (operTarget) {
        await this.session.click(operTarget.box.x + operTarget.box.w / 2, operTarget.box.y + operTarget.box.h / 2);
        await new Promise((r) => setTimeout(r, 800));

        const shot3 = await this.session.screencap();
        const confirmRecheck = shot3.ok ? await this.session.recognizeFrame(shot3.png, this.opts.cfg.resourceDir) : recheck;
        const confLines = confirmRecheck.ok ? confirmRecheck.lines : curLines;
        const confirmBtn = confLines.find((l) =>
          (l.text.includes('确定') || l.text.includes('确认') || l.text.includes('招募')) &&
          l.box.x > 0.6 && l.box.y > 0.6
        );
        if (confirmBtn) {
          await this.session.click(confirmBtn.box.x + confirmBtn.box.w / 2, confirmBtn.box.y + confirmBtn.box.h / 2);
          await new Promise((r) => setTimeout(r, 800));
        }
      } else {
        return fail(`当前画面未找到干员「${operator}」，画面文字有：${summarizeLines(curLines)}。强烈建议结合画面直接传入 slot 序号 (1~12) 或坐标点击！`);
      }
    }

    if (this.isRoguelikeRunning) {
      this.isRoguelikeRecruitPending = false;
      this.isRoguelikeTicketPending = false;
      this.roguelikeResumeControl?.();
    }
    return `【肉鸽招募决策已执行】成功选择【${ticket || ''} ${operator || (slot ? `第${slot}位干员` : (x !== undefined ? `坐标(${x},${y})` : ''))}】！`;
  }

  /** 肉鸽开局分队与职业组合选择界面，大模型自主选择初始分队、招募组合与配置 */
  private async selectRoguelikeSquad(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('分队/组合决策失败：尚未连接游戏窗口。');

    const rawSquad = typeof args.squad === 'string' ? args.squad.trim() : undefined;
    const rawRoles = typeof args.roles === 'string' ? args.roles.trim() : undefined;
    const squad = normalizeSquadName(rawSquad) || rawSquad;
    const roles = normalizeRoleName(rawRoles) || rawRoles;
    const slot = typeof args.slot === 'number' && Number.isFinite(args.slot) ? Math.round(args.slot) : undefined;
    const x = typeof args.x === 'number' && Number.isFinite(args.x) ? args.x : undefined;
    const y = typeof args.y === 'number' && Number.isFinite(args.y) ? args.y : undefined;

    const targetName = roles || squad;

    if (x !== undefined && y !== undefined) {
      await this.session.click(x, y);
      await new Promise((r) => setTimeout(r, 800));
    } else if (slot !== undefined && slot >= 1 && slot <= 8) {
      const squadPositions = [
        { x: 0.25, y: 0.35 },
        { x: 0.50, y: 0.35 },
        { x: 0.75, y: 0.35 },
        { x: 0.25, y: 0.65 },
        { x: 0.50, y: 0.65 },
        { x: 0.75, y: 0.65 },
      ];
      const pos = squadPositions[Math.min(slot - 1, squadPositions.length - 1)];
      await this.session.click(pos.x, pos.y);
      await new Promise((r) => setTimeout(r, 800));
    } else if (targetName) {
      const shot = await this.session.screencap();
      if (!shot.ok) return fail(`决策失败（抓帧失败）：${shot.error}`);
      const frame = await this.session.recognizeFrame(shot.png, this.opts.cfg.resourceDir);
      if (!frame.ok) return fail('决策失败：无法识别当前游戏画面文字。');

      let target = frame.lines.find((l) => l.text.includes(targetName));
      // 如果当前画面没找到，可能卡片在横向轮播区域更右侧，自动向右滑屏寻找一次
      if (!target) {
        await this.session.swipe(0.8, 0.45, 0.2, 0.45, 800);
        await new Promise((r) => setTimeout(r, 1000));
        const retryShot = await this.session.screencap();
        if (retryShot.ok) {
          const retryFrame = await this.session.recognizeFrame(retryShot.png, this.opts.cfg.resourceDir);
          if (retryFrame.ok) {
            target = retryFrame.lines.find((l) => l.text.includes(targetName));
          }
        }
      }

      if (target) {
        await this.session.click(target.box.x + target.box.w / 2, target.box.y + target.box.h / 2);
        await new Promise((r) => setTimeout(r, 800));
      } else {
        return fail(`当前画面未找到「${targetName}」，画面文字有：${summarizeLines(frame.lines)}。若卡片在屏幕边缘，建议调用 ark_swipe 滑出或传 (x, y) 坐标点击。`);
      }
    }

    const shotAfter = await this.session.screencap();
    if (shotAfter.ok) {
      const frameAfter = await this.session.recognizeFrame(shotAfter.png, this.opts.cfg.resourceDir);
      if (frameAfter.ok) {
        const confirmBtn = frameAfter.lines.find((l) =>
          (l.text.includes('确定') || l.text.includes('确认') || l.text.includes('开始') || l.text.includes('下一步')) &&
          l.box.x > 0.6 && l.box.y > 0.6
        );
        if (confirmBtn) {
          await this.session.click(confirmBtn.box.x + confirmBtn.box.w / 2, confirmBtn.box.y + confirmBtn.box.h / 2);
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }

    if (this.isRoguelikeRunning) {
      this.isRoguelikeSquadPending = false;
      this.roguelikeResumeControl?.();
    }
    const typeLabel = roles ? '职业组合' : '分队';
    return `【肉鸽分队决策已执行】成功选择${typeLabel}【${targetName || (slot ? `第${slot}个选项` : `坐标(${x}, ${y})`)}】！`;
  }

  /** 肉鸽大地图节点规划时，大模型自主选择前进节点 */
  private async selectRoguelikeNode(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('路线节点决策失败：尚未连接游戏窗口。');
    if (!this.isRoguelikeRunning) return fail('当前未在进行集成战略探索。');

    const target = typeof args.target === 'string' ? args.target.trim() : undefined;
    const index = typeof args.index === 'number' && Number.isFinite(args.index) ? Math.round(args.index) : undefined;
    const x = typeof args.x === 'number' && Number.isFinite(args.x) ? args.x : undefined;
    const y = typeof args.y === 'number' && Number.isFinite(args.y) ? args.y : undefined;

    if (x !== undefined && y !== undefined) {
      await this.session.click(x, y);
      await new Promise((r) => setTimeout(r, 800));
    } else if (index !== undefined && index >= 1 && index <= 5) {
      const branchPositions = [
        { x: 0.55, y: 0.35 },
        { x: 0.55, y: 0.50 },
        { x: 0.55, y: 0.65 },
        { x: 0.70, y: 0.40 },
        { x: 0.70, y: 0.60 },
      ];
      const pos = branchPositions[Math.min(index - 1, branchPositions.length - 1)];
      await this.session.click(pos.x, pos.y);
      await new Promise((r) => setTimeout(r, 800));
    } else if (target) {
      const shot = await this.session.screencap();
      if (!shot.ok) return fail(`路线决策失败（抓帧失败）：${shot.error}`);
      const frame = await this.session.recognizeFrame(shot.png, this.opts.cfg.resourceDir);
      if (!frame.ok) return fail('路线决策失败：无法识别当前游戏画面文字。');
      const found = frame.lines.find((l) => l.text.includes(target));
      if (found) {
        await this.session.click(found.box.x + found.box.w / 2, found.box.y + found.box.h / 2);
        await new Promise((r) => setTimeout(r, 800));
      } else {
        return fail(`当前画面未找到节点「${target}」，画面文字有：${summarizeLines(frame.lines)}。可直接传 (x, y) 坐标或分支 index 点击。`);
      }
    }

    const shotAfter = await this.session.screencap();
    if (shotAfter.ok) {
      const frameAfter = await this.session.recognizeFrame(shotAfter.png, this.opts.cfg.resourceDir);
      if (frameAfter.ok) {
        const enterBtn = frameAfter.lines.find((l) =>
          (l.text.includes('进入') || l.text.includes('前往') || l.text.includes('探索') || l.text.includes('确定')) &&
          l.box.x > 0.6 && l.box.y > 0.6
        );
        if (enterBtn) {
          await this.session.click(enterBtn.box.x + enterBtn.box.w / 2, enterBtn.box.y + enterBtn.box.h / 2);
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }

    this.isRoguelikeNodePending = false;
    this.roguelikeResumeControl?.();
    return `【肉鸽路线决策已执行】成功选定节点【${target || (index !== undefined ? `分支${index}` : `坐标(${x}, ${y})`)}】，已恢复后台全权托管！`;
  }

  /** 肉鸽战前编队界面：大模型完成出战阵容调整后调用此工具，点击“开始行动”进战并恢复 MAA 托管局内 AutoBattle */
  private async confirmRoguelikeFormation(): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('确认编队失败：尚未连接游戏窗口。');
    if (!this.isRoguelikeRunning) return fail('当前未在进行集成战略探索。');

    const shot = await this.session.screencap();
    if (!shot.ok) return fail(`确认编队失败（抓帧失败）：${shot.error}`);
    const frame = await this.session.recognizeFrame(shot.png, this.opts.cfg.resourceDir);
    if (!frame.ok) return fail('确认编队失败：无法识别当前游戏画面文字。');

    // 查找“开始行动”按钮（通常在右下角）
    const startBtn = frame.lines.find((l) =>
      (l.text.includes('开始行动') || l.text.includes('行动开始') || l.text.includes('开始')) &&
      l.box.x > 0.6 && l.box.y > 0.6
    );

    if (startBtn) {
      await this.session.click(startBtn.box.x + startBtn.box.w / 2, startBtn.box.y + startBtn.box.h / 2);
    } else {
      // 容错兜底：点击右下角经典“开始行动”区域 (0.88, 0.88)
      await this.session.click(0.88, 0.88);
    }
    await new Promise((r) => setTimeout(r, 1000));

    this.isRoguelikeFormationPending = false;
    this.roguelikeResumeControl?.();
    return '【肉鸽编队已确认并进战】已点击「开始行动」进入战场！底层 MAA 原生引擎已接管局内自适应 AutoBattle 部署与技能释放。';
  }

  /** 紧急终止正在后台运行的肉鸽探索并立即交还控制权 */
  private async stopRoguelike(): Promise<ToolOutcome | string> {
    if (!this.isRoguelikeRunning) {
      return '当前没有正在运行的肉鸽探索任务，控制权处于空闲状态。';
    }
    try {
      this.roguelikeKillControl?.();
    } catch {}
    this.isRoguelikeRunning = false;
    this.isRoguelikeRecruitPending = false;
    this.isRoguelikeSquadPending = false;
    this.isRoguelikeNodePending = false;
    this.isRoguelikeTicketPending = false;
    this.isRoguelikeFormationPending = false;
    this.activeRoguelikeTheme = '';
    this.roguelikeResumeControl = null;
    this.roguelikeKillControl = null;
    return '【肉鸽已紧急停止】已杀死后台探索子进程并释放所有互斥锁，游戏窗口与鼠标控制权已归还博士！';
  }

  /** 执行集成战略（肉鸽）全权托管 */
  private async runRoguelike(args: Record<string, unknown>): Promise<ToolOutcome | string> {
    if (!this.session.connected) return fail('启动集成战略失败：还没连接游戏窗口，先调用 ark_connect。');
    const size = this.session.resolution;
    if (!size) return fail('启动集成战略失败：还没拿到画面尺寸，先调用 ark_screencap 取一帧。');

    if (this.isRoguelikeRunning || this.isBattleRunning) {
      const active = this.activeRoguelikeTheme ? `肉鸽主题「${this.activeRoguelikeTheme}」` : `战斗「${this.activeBattleStage}」`;
      return fail(`【操作拦截】当前${active}正在全权托管中，严禁重复启动探索任务！请调用 ark_screencap 观察画面并向博士汇报战况。`);
    }

    const rawTheme = typeof args.theme === 'string' ? args.theme : 'BlackFlow';
    const theme = normalizeRoguelikeTheme(rawTheme);
    const mode = normalizeRoguelikeMode(args.mode);
    const starts_count = typeof args.starts_count === 'number' && Number.isFinite(args.starts_count) ? Math.max(1, Math.min(10, Math.round(args.starts_count))) : 1;
    const stop_at_final_stage = args.stop_at_final_stage === true;
    const investment_withdrawn = args.investment_withdrawn === true;
    const use_assist = args.use_assist === true;

    const rawSquad = typeof args.squad === 'string' && args.squad.trim() ? args.squad.trim() : undefined;
    const rawRoles = typeof args.roles === 'string' && args.roles.trim() ? args.roles.trim() : undefined;
    const squad = normalizeSquadName(rawSquad) || rawSquad;
    const roles = normalizeRoleName(rawRoles) || rawRoles;
    const core_char = typeof args.core_char === 'string' && args.core_char.trim() ? args.core_char.trim() : undefined;
    const interactive_recruit = args.interactive_recruit !== false;
    const interactive_squad = args.interactive_squad !== false;
    const interactive_route = args.interactive_route !== false;
    const interactive_ticket = args.interactive_ticket !== false;
    const interactive_formation = args.interactive_formation !== false;

    this.isRoguelikeRunning = true;
    this.activeRoguelikeTheme = theme;

    // 启动后台异步子进程托管任务
    (async () => {
      try {
        const outcome = await executeRoguelike({
          params: {
            theme,
            mode,
            starts_count,
            stop_at_final_stage,
            investment_withdrawn,
            use_assist,
            squad,
            roles,
            core_char,
            interactive_recruit,
            interactive_squad,
            interactive_route,
            interactive_ticket,
            interactive_formation,
          },
          hwnd: this.session.window?.handle,
          maaResourceDir: this.opts.cfg.resourceDir,
          maxMinutes: 45,
          info: (line) => this.host?.log.info(`[Roguelike] ${line}`),
          onTicketPending: async (details) => {
            this.isRoguelikeTicketPending = true;
            if (this.host) {
              await this.host.pushEvent({
                type: 'arknights.roguelike_ticket_prompt',
                ts: nowIso(this.opts.timezone),
                source: this.id,
                origin: 'internal',
                senderKey: this.id,
                text: `【集成战略招募券请示】当前肉鸽掉落/出现职业招募券！\n`
                  + `请先调用 ark_screencap 查看当前可选职业券（先锋/近卫/狙击/重装/医疗/辅助/术师/特种），\n`
                  + `结合 MAA 协同战术指引（优先配置先锋回费、保障奶坦、主力输出）进行战术选择，\n`
                  + `并通过 pet_say 向博士汇报选券理由，调用 ark_roguelike_select_recruit({ ticket: '近卫' }) 确认！`,
              });
            }
          },
          onRecruitPending: async (details) => {
            this.isRoguelikeRecruitPending = true;
            if (this.host) {
              await this.host.pushEvent({
                type: 'arknights.roguelike_recruit_prompt',
                ts: nowIso(this.opts.timezone),
                source: this.id,
                origin: 'internal',
                senderKey: this.id,
                text: `【集成战略干员招募请示】当前肉鸽探索进入干员候选列表！\n`
                  + `请调用 ark_screencap 查看当前干员卡片，结合 MAA 局内战斗机制（优先抓取维什戴尔、提丰、玛恩纳、煌、棘刺、泥岩等高容错挂机核心，避开复杂召唤/极限快活）自主挑人，\n`
                  + `并通过 pet_say 跟博士说明理由，调用 ark_roguelike_select_recruit({ slot, operator, x, y }) 完成招募！`,
              });
            }
          },
          onFormationPending: async (details) => {
            this.isRoguelikeFormationPending = true;
            if (this.host) {
              await this.host.pushEvent({
                type: 'arknights.roguelike_formation_prompt',
                ts: nowIso(this.opts.timezone),
                source: this.id,
                origin: 'internal',
                senderKey: this.id,
                text: `【集成战略战前编队请示】进入关卡准备界面，MAA 自动编队已被拦截！\n`
                  + `请调用 ark_screencap 与 ark_find_operators 检查当前关卡与候选干员，\n`
                  + `遵循【精简出战阵容（6~10人精锐）、踢除低星卡费干员、确保先锋回费与治疗阻挡链】原则，\n`
                  + `自主调配上阵干员与预选技能，调整完毕后调用 ark_roguelike_confirm_formation() 进战交由 MAA 托管！`,
              });
            }
          },
          onSquadPending: async (details) => {
            this.isRoguelikeSquadPending = true;
            if (this.host) {
              await this.host.pushEvent({
                type: 'arknights.roguelike_squad_prompt',
                ts: nowIso(this.opts.timezone),
                source: this.id,
                origin: 'internal',
                senderKey: this.id,
                text: `【集成战略分队/开局决策请示】当前肉鸽正在开局分队与职业选择界面！\n`
                  + `请先调用 ark_screencap 查看画面分队列表与开局加成，结合你的战术流派自主思考，\n`
                  + `通过 pet_say 跟博士说明理由，并调用 ark_roguelike_select_squad({ squad, slot, x, y }) 完成选择！`,
              });
            }
          },
          onNodePending: async (details) => {
            this.isRoguelikeNodePending = true;
            if (this.host) {
              await this.host.pushEvent({
                type: 'arknights.roguelike_node_prompt',
                ts: nowIso(this.opts.timezone),
                source: this.id,
                origin: 'internal',
                senderKey: this.id,
                text: `【集成战略路线规划请示】当前肉鸽处于节点地图准备状态！\n`
                  + `请先调用 ark_screencap 查看前方分支与可能掉落，通过 pet_say 向博士规划进阶路线，\n`
                  + `并调用 ark_roguelike_select_node({ target, x, y, index }) 自主选择前进节点！`,
              });
            }
          },
          onWorkerReady: (control) => {
            this.roguelikeResumeControl = () => control.resume();
            this.roguelikeKillControl = () => control.kill();
          },
        });

        if (this.host) {
          if (!outcome.ok) {
            await this.host.pushEvent({
              type: 'arknights.battle_error',
              ts: nowIso(this.opts.timezone),
              source: this.id,
              origin: 'internal',
              senderKey: this.id,
              text: `【集成战略探索失败通知】主题「${theme}」探索未能正常运行：${outcome.resultText}\n`
                + `- 执行日志节选：\n${outcome.logs.slice(-5).map((l) => '  * ' + l).join('\n')}\n`
                + `请检查游戏是否处于该肉鸽主题入口，或与博士重新确认开局参数！`,
            });
          }

          const reportText = `【集成战略探索结束通知】主题「${theme}」探索已结束！\n`
            + `- 探索战报：${outcome.resultText}\n`
            + `- 探索耗时：${(outcome.durationMs / 60000).toFixed(1)} 分钟\n`
            + `- 执行日志节选：\n${outcome.logs.slice(-5).map((l) => '  * ' + l).join('\n')}\n`
            + `请向博士进行肉鸽整轮探索总结汇报！`;

          await this.host.pushEvent({
            type: 'arknights.roguelike_settled',
            ts: nowIso(this.opts.timezone),
            source: this.id,
            origin: 'internal',
            senderKey: this.id,
            text: reportText,
          });
        }
      } catch (err) {
        if (this.host) {
          await this.host.pushEvent({
            type: 'arknights.battle_error',
            ts: nowIso(this.opts.timezone),
            source: this.id,
            origin: 'internal',
            senderKey: this.id,
            text: `【集成战略异常通知】主题「${theme}」探索发生异常：${String(err)}`,
          });
        }
      } finally {
        this.isRoguelikeRunning = false;
        this.isRoguelikeRecruitPending = false;
        this.isRoguelikeSquadPending = false;
        this.isRoguelikeNodePending = false;
        this.isRoguelikeTicketPending = false;
        this.isRoguelikeFormationPending = false;
        this.activeRoguelikeTheme = '';
        this.roguelikeResumeControl = null;
        this.roguelikeKillControl = null;
      }
    })();

    const modeDesc = mode === 1 ? '刷源石锭(存钱模式)' : '常规探索通关模式';
    const customDesc = (squad || roles || core_char)
      ? `\n- 开局定制：分队【${squad || '默认'}】，职业组合【${roles || '默认'}】，核心干员【${core_char || '默认'}】`
      : '';
    const recruitDesc = interactive_recruit ? '方案A (大模型自主看屏挑人)' : 'MAA 全自动托管';
    const ticketDesc = interactive_ticket ? '大模型自主选券' : 'MAA 全自动';
    const formationDesc = interactive_formation ? '大模型自主精简编队' : 'MAA 自动快速编队';
    const squadDesc = interactive_squad ? '大模型自主选分队' : 'MAA 全自动';
    const routeDesc = interactive_route ? '大模型自主规划路线' : 'MAA 全自动寻路';

    return `【集成战略全权托管已在后台启动】主题「${theme}」已启动，采用「${modeDesc}」！${customDesc}\n`
      + `- 决策模式：分队[${squadDesc}]，选券[${ticketDesc}]，招募[${recruitDesc}]，编队[${formationDesc}]，路线[${routeDesc}]\n`
      + `底层 MaaCore 原生引擎正在接管大地图寻路、节点选择与局内战斗自适应部署。\n\n`
      + `【战中积极互动契约】肉鸽长效探索期间，你拥有自由发言与读屏能力！\n`
      + `1. 必须每隔 15~30 秒调用一次 ark_screencap 看看屏幕，且每次看屏后必须立即调用 pet_say 和博士说话互动！\n`
      + `2. 发言完全自由开放：分享心里话、吐槽奇奇怪怪的藏品、自言自语碎碎念、或关心博士的日常（例如：“居然刷出了【死仇】，这把我无敌了”、“怪怎么这么多，机械师顶住啊”、“博士累不累，要不要吃点零食？”）；\n`
      + `3. 探索期间普通点击受互斥锁保护，但在收到分队/选券/招募/编队/节点请示时，可直接调用对应自主决策工具或 ark_click 操作；\n`
      + `4. 若发生卡顿或想随时拿回鼠标控制权，直接调用 ark_stop_roguelike 即可立即终止并释放所有控制权；\n`
      + `5. 探索整轮结束或通关时，系统将自动推送结算事件（arknights.roguelike_settled），届时再向博士做终局总结！`;
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
      text: '明日方舟 World 已挂载。22 个工具可用：连接（ark_connect）、截图（ark_screencap）、'
        + '选关导航（ark_enter_stage）、干员识别（ark_find_operators）、地图查询（ark_get_stage_map）、'
        + 'Copilot 战斗执行（ark_run_copilot）、作业检索（ark_fetch_copilot）、'
        + '集成战略全权托管（ark_run_roguelike）、肉鸽战略秘籍（ark_roguelike_strategy）、'
        + '肉鸽招募决策（ark_roguelike_select_recruit）、肉鸽分队决策（ark_roguelike_select_squad）、'
        + '肉鸽路线规划（ark_roguelike_select_node）、肉鸽战前编队确认（ark_roguelike_confirm_formation）、'
        + '肉鸽紧急终止（ark_stop_roguelike）、战场监控（ark_battle_state）等；'
        + '普通战斗交由 ark_run_copilot 托管，肉鸽长效探索交由 ark_run_roguelike 托管！',
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
    if (this.isBattleRunning || this.isRoguelikeRunning) {
      const active = this.isRoguelikeRunning ? `肉鸽主题「${this.activeRoguelikeTheme}」` : `关卡「${this.activeBattleStage || '战斗'}」`;
      return fail(`【操作拦截】当前${active}正在后台全权托管中，严禁手动暂停干预！请调用 ark_screencap / ark_battle_state 观察画面并解说，等待战斗结算。`);
    }
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
    if (this.isBattleRunning || this.isRoguelikeRunning) {
      const active = this.isRoguelikeRunning ? `肉鸽主题「${this.activeRoguelikeTheme}」` : `关卡「${this.activeBattleStage || '战斗'}」`;
      return fail(`【操作拦截】当前${active}正在后台全权托管中，严禁手动部署干涉！请调用 ark_screencap / ark_battle_state 观察画面并解说，等待战斗结算。`);
    }
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
    if (this.isBattleRunning || this.isRoguelikeRunning) {
      const active = this.isRoguelikeRunning ? `肉鸽主题「${this.activeRoguelikeTheme}」` : `关卡「${this.activeBattleStage || '战斗'}」`;
      return fail(`【操作拦截】当前${active}正在后台全权托管中，严禁导航选关！请调用 ark_screencap / ark_battle_state 观察画面并解说，等待战斗结算。`);
    }
    if (!this.session.connected) return fail('选关失败：还没连接游戏窗口，先调用 ark_connect。');
    const raw = typeof args.stage_code === 'string' ? args.stage_code : '';
    const planned = routeFor(raw, { maxScrolls: scrollLimit(this.opts.cfg) });
    if (!planned.ok) return fail(planned.error);
    const route = planned.route;
    const fallback = `${route.label}导航后的画面`;

    // 预检：如果当前画面已经停留在编队界面（可见「快捷编队」标志），无需重复跑终端流水线
    const preShot = await this.session.screencap();
    if (preShot.ok) {
      const preOcr = await this.session.recognizeFrame(preShot.png, this.opts.cfg.resourceDir);
      if (preOcr.ok && preOcr.lines.some((l) => /快捷编队/.test(l.text))) {
        const sanity = parseSanity(preOcr.lines);
        const sanityText = describeSanity(sanity);
        const head = `已到编队界面（当前已就位，无需重复导航）。${sanityText}。`;
        if (args.start !== true) {
          return {
            text: `${head}没有点击「开始行动」——确认要消耗理智后，再调用 ark_click 点它，或传 start: true。`,
            blobs: [frameBlob(preShot.png, fallback)],
          };
        }
      }
    }

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
    return `已等待 ${ms} 毫秒。现在可以再调用 ark_battle_state 或 ark_screencap 查看状态。`;
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
    const isRoguelikePending =
      this.isRoguelikeRecruitPending ||
      this.isRoguelikeSquadPending ||
      this.isRoguelikeNodePending ||
      this.isRoguelikeTicketPending ||
      this.isRoguelikeFormationPending;
    if (this.isBattleRunning || (this.isRoguelikeRunning && !isRoguelikePending)) {
      const active = this.isRoguelikeRunning ? `肉鸽主题「${this.activeRoguelikeTheme}」` : `关卡「${this.activeBattleStage || '战斗'}」`;
      return fail(`【操作拦截】当前${active}正在后台全权托管中，严禁手动点击干涉！请调用 ark_screencap / ark_battle_state 观察画面并解说，等待战斗结算。`);
    }
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
    const isRoguelikePending =
      this.isRoguelikeRecruitPending ||
      this.isRoguelikeSquadPending ||
      this.isRoguelikeNodePending ||
      this.isRoguelikeTicketPending ||
      this.isRoguelikeFormationPending;
    if (this.isBattleRunning || (this.isRoguelikeRunning && !isRoguelikePending)) {
      const active = this.isRoguelikeRunning ? `肉鸽主题「${this.activeRoguelikeTheme}」` : `关卡「${this.activeBattleStage || '战斗'}」`;
      return fail(`【操作拦截】当前${active}正在后台全权托管中，严禁手动拖拽干涉！请调用 ark_screencap / ark_battle_state 观察画面并解说，等待战斗结算。`);
    }
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
