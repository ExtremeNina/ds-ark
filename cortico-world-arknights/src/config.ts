import type { ConfigGroup } from 'cortico/core/types.ts';

/**
 * 截图方式：取值就是绑定里 `Win32ScreencapMethod` 的键名，`Default` 表示用本扩展选定的兜底组合。
 * 详见 @maaxyz/maa-node 的 constant.d.ts；不同游戏进程对不同方式的反应差别很大。
 */
export const SCREENCAP_METHODS = [
  'Default',
  'Background',
  'Foreground',
  'FramePool',
  'PrintWindow',
  'GDI',
  'DXGI_DesktopDup',
  'DXGI_DesktopDup_Window',
  'ScreenDC',
] as const;

/**
 * 输入方式：取值就是绑定里 `Win32InputMethod` 的键名。
 * 后台静默点击用 SendMessage / PostMessage 系；它们不移动真实光标，但可能被游戏忽略。
 */
export const INPUT_METHODS = [
  'SendMessage',
  'PostMessage',
  'SendMessageWithCursorPos',
  'PostMessageWithCursorPos',
  'SendMessageWithWindowPos',
  'PostMessageWithWindowPos',
  'LegacyEvent',
  'Seize',
  'PostThreadMessage',
  'Interception',
  'AnchoredTouch',
] as const;

/** `config.json` 的 `worlds.arknights` 段。 */
export interface ArknightsConfigSection {
  enabled: boolean;
  /** 窗口名关键字，逗号分隔；默认覆盖国服与国际服两种标题。 */
  windowMatch: string;
  screencapMethod: (typeof SCREENCAP_METHODS)[number];
  inputMethod: (typeof INPUT_METHODS)[number];
  /** 暂停按钮位置，按 0~1 相对坐标存，换分辨率不用重新校准。 */
  pauseButton: { x: number; y: number };
  /** 预留给后续 OCR 的 MaaFramework 资源目录；本版不加载 Resource/Tasker。 */
  resourceDir: string;
}

export const ARKNIGHTS_DEFAULTS: ArknightsConfigSection = {
  enabled: false,
  windowMatch: '明日方舟,Arknights',
  screencapMethod: 'Default',
  inputMethod: 'SendMessage',
  pauseButton: { x: 0.97, y: 0.06 },
  resourceDir: '',
};

/** 配置组的路径必须全部落在 `worlds.arknights.` 段内，且在 `defaults()` 里有对应项。 */
export const ARKNIGHTS_CONFIG_GROUP: ConfigGroup = {
  id: 'world:arknights',
  owner: 'world:arknights',
  schema: {
    type: 'object',
    title: '明日方舟',
    description: '窗口匹配、截图与输入方式、暂停按钮位置。改动即时生效，下一次工具调用即按新值执行。',
    properties: {
      'worlds.arknights.windowMatch': {
        type: 'string',
        title: '窗口名关键字',
        description: '窗口标题包含其中之一即命中，逗号分隔。默认「明日方舟,Arknights」。',
        'x-hot': true,
      },
      'worlds.arknights.screencapMethod': {
        type: 'string',
        title: '截图方式',
        description: 'Default 用后台可采的兜底组合。画面全黑或报错时改这一项。',
        enum: [...SCREENCAP_METHODS],
        'x-hot': true,
      },
      'worlds.arknights.inputMethod': {
        type: 'string',
        title: '输入方式',
        description: 'SendMessage / PostMessage 系不移动真实光标；若游戏对点击无反应，改这一项。',
        enum: [...INPUT_METHODS],
        'x-hot': true,
      },
      'worlds.arknights.pauseButton.x': {
        type: 'number',
        title: '暂停按钮 · 横向位置',
        description: '按画面宽度的比例填 0~1，0 是最左、1 是最右。',
        minimum: 0,
        maximum: 1,
        'x-hot': true,
      },
      'worlds.arknights.pauseButton.y': {
        type: 'number',
        title: '暂停按钮 · 纵向位置',
        description: '按画面高度的比例填 0~1，0 是最上、1 是最下。',
        minimum: 0,
        maximum: 1,
        'x-hot': true,
      },
      'worlds.arknights.resourceDir': {
        type: 'string',
        title: 'MaaFramework 资源目录',
        description: '预留给后续 OCR 截图识别用。本版不加载，留空即可。',
        'x-hot': false,
        'x-path': { kind: 'directory' },
      },
    },
  },
};
