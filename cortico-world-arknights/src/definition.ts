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
        zh: '把手牌拖到战场地块并拖出朝向；回执只说明拖拽已发出，落位与否由画面判断。',
        en: 'Drags one hand card onto a battlefield tile and sets the facing; the receipt only states that the drags were sent.',
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
    }),
    events: [
      {
        type: 'arknights.ready',
        description: {
          zh: 'World 挂载完成，九个工具可用；此时尚未连接游戏窗口。',
          en: 'The World was mounted and its nine tools are available; the game window is not connected yet.',
        },
      },
    ],
  },
};
