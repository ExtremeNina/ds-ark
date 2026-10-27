import type { ConfigGroup } from 'cortico/core/types.ts';
import { DEFAULT_WINDOW_KEYWORDS } from './mfw/window.ts';

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
  /** 暂停/恢复点击后是否补拍一帧作为附件，让模型自己看结果。 */
  verifyAfterClick: boolean;
  /** 可选：用别的目录覆盖包内 OCR 模型。留空即用包内模型，不做识别以外的任何加载。 */
  resourceDir: string;
  /** 部署第一步（手牌 → 地块）按住拖拽的时长，毫秒。太短会被游戏当成点击。 */
  deployHoldMs: number;
  /** 两步拖拽之间的停顿，毫秒。给游戏留出进入「选朝向」状态的时间。 */
  deployGapMs: number;
  /** 第二步（地块 → 朝向）拖拽的时长，毫秒。 */
  deployDirectionMs: number;
}

export const ARKNIGHTS_DEFAULTS: ArknightsConfigSection = {
  enabled: false,
  windowMatch: DEFAULT_WINDOW_KEYWORDS.join(','),
  screencapMethod: 'Default',
  // 实测（1280×720 帧，游戏窗口 1920×1080）：SendMessage 能点亮底部干员卡，
  // 却点不中右上角的暂停键与 1X 倍速键；AnchoredTouch 注入 WM_POINTER，两者都能点中且不抢前台。
  inputMethod: 'AnchoredTouch',
  // 实测暂停键中心（帧坐标 1236, 51）按 (size-1) 归一化；16:9 下任意分辨率落点一致。
  pauseButton: { x: 0.966, y: 0.071 },
  verifyAfterClick: true,
  resourceDir: '',
  // 默认值就是此前写死的常量：不配置时行为与 0.2.0 一致，想调慢再改这几项。
  // 真机上拖拽成功率偏低时，先试 600 / 150 / 250。
  deployHoldMs: 260,
  deployGapMs: 0,
  deployDirectionMs: 160,
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
        description:
          '默认 AnchoredTouch：实测能命中右上角的小按钮，且不会把游戏抢到前台。'
          + 'SendMessage / PostMessage 更「静默」，但在本客户端点不中右上角按钮。',
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
        description: '按画面高度的比例填 0~1，0 是最上、1 是最下。默认值按 16:9 标定，换宽高比要重标。',
        minimum: 0,
        maximum: 1,
        'x-hot': true,
      },
      'worlds.arknights.verifyAfterClick': {
        type: 'boolean',
        title: '点击后补拍一帧',
        description:
          '开启后每次暂停/恢复都会多抓一帧作为附件，让模型自己看有没有生效；'
          + '代价是多一次截图和一张图的 token。',
        'x-hot': true,
      },
      'worlds.arknights.deployHoldMs': {
        type: 'number',
        title: '部署 · 按住拖拽时长（ms）',
        description:
          '把手牌拖到地块这一步的时长。太短会被游戏当成点击、干员不落位；'
          + '默认 260，真机成功率低时先试 600。范围 80~5000。',
        minimum: 80,
        maximum: 5000,
        'x-hot': true,
      },
      'worlds.arknights.deployGapMs': {
        type: 'number',
        title: '部署 · 两步之间的停顿（ms）',
        description:
          '拖到地块之后、拖朝向之前的等待。给游戏进入「选朝向」状态的时间，默认 0，'
          + '成功率低时试 150。范围 0~3000。',
        minimum: 0,
        maximum: 3000,
        'x-hot': true,
      },
      'worlds.arknights.deployDirectionMs': {
        type: 'number',
        title: '部署 · 定向拖拽时长（ms）',
        description: '拖出朝向那一步的时长。默认 160，漂移或方向没选中时试 250。范围 80~5000。',
        minimum: 80,
        maximum: 5000,
        'x-hot': true,
      },
      'worlds.arknights.resourceDir': {
        type: 'string',
        title: 'OCR 模型目录（可选覆盖）',
        description:
          '留空即用扩展自带的 PP-OCRv6 small 模型，不需要安装 MAA。想换模型时填一个目录：'
          + '该目录下平铺 det.onnx / rec.onnx / keys.txt，或填带 model/ocr 的资源包根。'
          + '路径不对时 ark_battle_state 仍然给图，只是读不出数字。',
        'x-hot': false,
        'x-path': { kind: 'directory' },
      },
    },
  },
};
