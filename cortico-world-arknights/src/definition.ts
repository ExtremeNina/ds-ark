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
        zh: '识别编队界面或干员名册中的干员卡片（严禁在战斗中调用）；战斗中由 ark_run_copilot 自动识别人脸下干员。',
        en: 'Recognises operator cards on screen (formation or roster only; do not call during battle).',
      },
      ark_run_copilot: {
        zh: '将 Copilot 战斗计划 JSON（支持作业站作业或根据当前编队自创的战术 plan）交给 MaaCore 原生全权托管执行，自动识别人脸、监控费用下干员、开技能与结算。',
        en: 'Executes an MAA Copilot battle plan JSON via MaaCore native engine (supports preset plans or LLM custom plans for current team), monitoring DP and auto deploying.',
      },
      ark_fetch_copilot: {
        zh: '检索指定关卡的内置或本地 Copilot 战斗作业；若提供当前编队干员，会自动比对缺漏并给出建议。',
        en: 'Fetches built-in or local Copilot battle plans for a stage, optionally comparing against current team operators.',
      },
      ark_get_stage_map: {
        zh: '获取指定关卡的静态地图网格情报（来自 MAA 官方地块数据），标明地面（先锋/近卫/重装）、高台（狙击/术师/医疗/辅助）与红蓝门坐标。',
        en: 'Queries static stage tile layout from MAA data, indicating melee tiles, ranged tiles and spawns.',
      },
      ark_run_roguelike: {
        zh: '启动集成战略（肉鸽）全权托管任务（支持黑流树海 BlackFlow、萨卡兹 Sarkaz、萨米 Sami、水月 Mizuki、傀影 Phantom 全主题），由底层 MaaCore 自动寻路大地图、选节点、招募干员、买藏品并自动打局内战斗。',
        en: 'Executes Integrated Strategies (Roguelike) full exploration via MaaCore native engine, supporting BlackFlow, Sarkaz, Sami, Mizuki, Phantom themes.',
      },
      ark_roguelike_strategy: {
        zh: '查询指定肉鸽主题的官方战略秘籍（来自 MAA 官方 recruitment.json 与 shopping.json），包括核心首发干员、职业进阶优先级与商店高价值藏品。对局前向博士提出战前流派与阵容建议时必查！',
        en: 'Queries recommended operator recruitment priorities and key relic ratings for a Roguelike theme from MAA official data.',
      },
      ark_roguelike_select_recruit: {
        zh: '在集成战略（肉鸽）遇到干员招募界面时（收到 arknights.roguelike_recruit_prompt 通知），大模型自主指定职业券、目标干员、卡片序号(slot)或坐标完成招募决策，底层执行点击并恢复全权探索。',
        en: 'Selects a recruitment ticket or operator during Roguelike recruitment prompt and resumes exploration.',
      },
      ark_roguelike_select_squad: {
        zh: '在集成战略（肉鸽）开局分队或职业组合选择界面（收到 arknights.roguelike_squad_prompt 通知），大模型自主选定分队或招募组合（按名称 roles/squad、槽位或坐标）并恢复全权探索。',
        en: 'Selects an initial squad or recruit roles composition during Roguelike start and resumes exploration.',
      },
      ark_roguelike_select_node: {
        zh: '在集成战略（肉鸽）大地图路线规划时（收到 arknights.roguelike_node_prompt 通知），大模型自主选择前进节点（按节点类型文字、分支序号或坐标）并恢复全权探索。',
        en: 'Selects a route node on the Roguelike map and resumes exploration.',
      },
      ark_roguelike_confirm_formation: {
        zh: '在集成战略（肉鸽）战前编队界面（收到 arknights.roguelike_formation_prompt 通知），大模型完成出战阵容调整后调用此工具，点击“开始行动”进入战场，由 MAA 原生引擎接管局内战斗自适应部署与技能释放。',
        en: 'Confirms squad formation in Roguelike pre-battle and enters battle, resuming MAA AutoBattle.',
      },
      ark_stop_roguelike: {
        zh: '紧急终止正在后台运行的集成战略（肉鸽）探索，杀死底层后台子进程，释放所有互斥锁并立即将鼠标与操作控制权归还博士。',
        en: 'Emergency stop for running Roguelike exploration, killing subprocess and releasing all locks.',
      },
    }),
    events: [
      {
        type: 'arknights.ready',
        description: {
          zh: 'World 挂载完成，二十二个工具可用；此时尚未连接游戏窗口。',
          en: 'The World was mounted and its twenty-two tools are available; the game window is not connected yet.',
        },
      },
      {
        type: 'arknights.battle_settled',
        description: {
          zh: 'Copilot 后台战斗托管执行完毕并结算，向大模型推送最终战报并唤醒进行终局总结。',
          en: 'Copilot background battle execution finished and settled; pushes outcome report to LLM.',
        },
      },
      {
        type: 'arknights.battle_error',
        description: {
          zh: 'Copilot 后台战斗托管发生异常，通知大模型进行异常处理。',
          en: 'Copilot background battle execution encountered an error; notifies LLM.',
        },
      },
      {
        type: 'arknights.roguelike_settled',
        description: {
          zh: '集成战略（肉鸽）探索结束或通关结算，向大模型推送最终收益战报并唤醒进行终局总结。',
          en: 'Integrated Strategies exploration settled; pushes results to LLM.',
        },
      },
      {
        type: 'arknights.roguelike_ticket_prompt',
        description: {
          zh: '集成战略掉落或出现职业招募券，底层已暂停自动点击，唤醒大模型根据战术思考并自主挑选职业券。',
          en: 'Recruitment ticket prompt triggered in Roguelike; pauses automated clicks to let LLM decide ticket.',
        },
      },
      {
        type: 'arknights.roguelike_recruit_prompt',
        description: {
          zh: '集成战略探索中遇到干员招募界面，底层已暂停自动点击，唤醒大模型看屏思考并自主做出招募决策。',
          en: 'Operator recruitment prompt triggered in Roguelike; pauses automated clicks to let LLM decide.',
        },
      },
      {
        type: 'arknights.roguelike_squad_prompt',
        description: {
          zh: '集成战略开局遇到分队选择界面，底层已暂停自动点击，唤醒大模型看屏思考并自主挑选初始分队。',
          en: 'Initial squad selection prompt triggered in Roguelike; pauses automated clicks to let LLM decide.',
        },
      },
      {
        type: 'arknights.roguelike_formation_prompt',
        description: {
          zh: '集成战略作战节点前进入战前编队界面，底层已拦截 MAA 快速编队，唤醒大模型精简阵容并调整出战干员。',
          en: 'Pre-battle formation prompt triggered in Roguelike; pauses automated clicks to let LLM refine team.',
        },
      },
      {
        type: 'arknights.roguelike_node_prompt',
        description: {
          zh: '集成战略大地图就绪进入路线规划阶段，底层已暂停自动点击，唤醒大模型看屏分析分支并自主决策前进节点。',
          en: 'Map route node selection prompt triggered in Roguelike; pauses automated clicks to let LLM decide.',
        },
      },
    ],
  },
};
