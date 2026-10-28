/**
 * 节点名 → 中文步骤。未知节点原样显示，方便真机上对照 pipeline JSON 排障。
 */
const LABELS: Readonly<Record<string, string>> = {
  'NavCommon@Ping': 'Ping',
  'NavCommon@ConfirmFormation': '确认编队页',

  'NavResource@Begin': '资源本入口',
  'NavResource@Enter': '进入资源收集',
  'NavResource@FindStage': '找关卡',
  'NavResource@Scroll': '滑动资源列表',

  'NavChip@Begin': '芯片本入口',
  'NavChip@Enter': '进入芯片搜索',
  'NavChip@FindStage': '找芯片关卡',
  'NavChip@Scroll': '滑动芯片列表',

  'NavMain@Begin': '主线入口',
  'NavMain@EnterOperation': '进入作战',
  'NavMain@EnterTheme': '进入主题曲',
  'NavMain@Chapter': '选择章节',
  'NavMain@ScrollChapters': '滑动章节列表',
  'NavMain@EnterEpisode': '前往章节',
  'NavMain@FindStage': '找关卡',
  'NavMain@ScrollStage': '滑动关卡地图',

  'NavSide@Begin': '活动入口',
  'NavSide@EnterOperation': '进入作战',
  'NavSide@EnterTab': '切换活动页签',
  'NavSide@FindActivity': '找活动',
  'NavSide@ScrollActivities': '滑动活动列表',
  'NavSide@Start': '进入活动关卡页',
  'NavSide@EnterEpisode': '前往章节',
  'NavSide@FindStage': '找关卡',
  'NavSide@ScrollStage': '滑动关卡地图',

  'NavRoguelike@Begin': '集成战略入口',
  'NavRoguelike@Enter': '进入集成战略',
  'NavRoguelike@EnterByPoint': '按坐标进入集成战略',
  'NavRoguelike@OpenThemeList': '展开主题列表',
  'NavRoguelike@FindTheme': '找主题',
  'NavRoguelike@ScrollTheme': '滑动主题列表',
  'NavRoguelike@ThemeHome': '主题页',
};

export function traceLabel(node: string): string {
  return LABELS[node] ?? node;
}

/** 把执行轨迹折成一行；空轨迹说明绑定没给节点明细。 */
export function describeTrace(trace: readonly string[]): string {
  if (trace.length === 0) return '（绑定没有返回节点轨迹）';
  return trace.map(traceLabel).join(' → ');
}

export function lastNode(trace: readonly string[]): string | null {
  return trace.length > 0 ? trace[trace.length - 1]! : null;
}
