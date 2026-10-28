import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { ARKNIGHTS_DEFAULTS, type ArknightsConfigSection } from './config.ts';
import { ARKNIGHTS_TOOL_DECLS, ArknightsWorld } from './world.ts';

export const ARKNIGHTS: WorldDefinition<ArknightsConfigSection> = {
  id: 'arknights',
  label: '明日方舟',

  // 每次返回新对象：pauseButton 是嵌套对象，浅拷贝会与常量共享引用。
  defaults: () => ({ ...ARKNIGHTS_DEFAULTS, pauseButton: { ...ARKNIGHTS_DEFAULTS.pauseButton } }),

  // `ctx.cfg` 是 `worlds.arknights` 的活引用：构造时保存引用，调用时现读，热改即生效。
  create: (ctx) => new ArknightsWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),

  // 自描述：可能出现的全部工具与会推出的全部事件，不进提示词。
  describe: {
    tools: describeTools(ARKNIGHTS_TOOL_DECLS, {
      ark_connect: {
        zh: '枚举本机窗口，按窗口名关键字找到明日方舟 PC 客户端并建立连接。',
        en: 'Enumerates local windows and connects to the Arknights PC client matched by window title.',
      },
      ark_screencap: {
        zh: '抓取当前一帧游戏画面，作为 PNG 附件随回执交给模型。',
        en: 'Captures the current frame of the game and attaches it as a PNG image.',
      },
      ark_set_paused: {
        zh: '向配置的暂停按钮位置发一次点击，暂停或继续战斗。',
        en: 'Sends one click to the configured pause button to pause or resume the battle.',
      },
      ark_battle_state: {
        zh: '抓取当前帧并读取费用、生命值、剩余敌人、暂停横幅与手牌费用；识别不到的项如实列为缺失。',
        en: 'Captures the frame and reads cost, life points, enemies left, the pause banner and hand costs; unreadable fields are reported as missing.',
      },
      ark_deploy: {
        zh: '【调试工具，实战严禁调用】把手牌拖到战场地块并拖出朝向；战斗请一律组装 Copilot plan 交由 ark_run_copilot (MaaCore) 全权托管。',
        en: 'Debug tool: drags one hand card onto a battlefield tile. In actual battle, always format into a plan and use ark_run_copilot.',
      },
      ark_enter_stage: {
        zh: '用内置 pipeline 导航到关卡编队页（资源本 / 芯片本 / 主线 / 已收录活动）；默认不点「开始行动」。',
        en: 'Navigates to a stage formation screen via the built-in pipeline; never starts the battle by default.',
      },
      ark_open_roguelike: {
        zh: '导航到指定集成战略的主题页；只到页面，不点「开始探索」。',
        en: 'Navigates to the home page of one Integrated Strategies theme without starting a run.',
      },
      ark_wait: {
        zh: '等待若干毫秒（最多 10 秒），用于等费用回复；不截图、不点击。',
        en: 'Waits up to 10 seconds for DP to regenerate; captures and clicks nothing.',
      },
      ark_click: {
        zh: '向指定的归一化坐标发一次点击；只说明已发送，界面有没有变化由模型再读屏确认。',
        en: 'Clicks one normalised point; the receipt states only that it was sent.',
      },
      ark_swipe: {
        zh: '从一点拖到另一点（归一化坐标），用于滚动列表或拖动；不确认结果。',
        en: 'Drags between two normalised points, e.g. to scroll a list; the receipt states only that it was sent.',
      },
      ark_ocr: {
        zh: '抓帧并列出画面里所有识别到的文字与归一化坐标，用来定位按钮；只读，不点击。',
        en: 'Captures the frame and lists every recognised text line with normalised boxes; read-only.',
      },
      ark_find_operators: {
        zh: '识别当前画面（编队界面或干员选择名册）中的干员卡片，返回干员名与坐标；支持按名字检索。',
        en: 'Recognises operator cards on screen (formation or roster) and returns names with coordinates; supports searching by name.',
      },
      ark_run_copilot: {
        zh: '将 Copilot 战斗计划 JSON（支持作业站作业或根据当前编队自创的战术 plan）交给 MaaCore 原生全权托管执行，自动识别人脸、监控费用下干员、开技能与结算。',
        en: 'Executes an MAA Copilot battle plan JSON via MaaCore native engine (supports preset plans or LLM custom plans for current team), monitoring DP and auto deploying.',
      },
      ark_fetch_copilot: {
        zh: '检索指定关卡的内置或本地 Copilot 战斗作业；若提供当前编队干员，会自动比对缺漏并给出建议。',
        en: 'Fetches built-in or local Copilot battle plans for a stage, optionally comparing against current team operators.',
      },
    }),
    events: [
      {
        type: 'arknights.ready',
        description: {
          zh: 'World 挂载完成，十四个工具可用；此时尚未连接游戏窗口。',
          en: 'The World was mounted and its fourteen tools are available; the game window is not connected yet.',
        },
      },
    ],
  },
};
