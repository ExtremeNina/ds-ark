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
    }),
    events: [
      {
        type: 'arknights.ready',
        description: {
          zh: 'World 挂载完成，三个工具可用；此时尚未连接游戏窗口。',
          en: 'The World was mounted and its three tools are available; the game window is not connected yet.',
        },
      },
    ],
  },
};
