# “大肥鱼开荒助手”最小可行性产品（MVP）需求与技术设计文档

## 一、 产品定位与背景

### 1.1 项目概述

“大肥鱼开荒助手”是基于桌面伴侣框架 **Coopanion** 开发的游戏自动化与战术拓展插件。项目面向《明日方舟》官方 PC 端，借助 **MaaFramework (MaaFW) Node.js 官方绑定** 与大语言模型的策略推演能力，打造一个能“自主开荒、战术思考、遇挫抄作业、日常托底”的二次元桌宠智能体。

### 1.2 MVP 核心目标

- **验证工程链路可行性**：打通 `大模型 (Coopanion) -> Agent Tools -> MaaFramework (Node.js) -> 明日方舟官方 PC 端` 的单进程直连链路。

  ​

- **解决大模型时延硬伤**：引入“战术暂停机制”，消除 LLM 多模态/推理延迟导致的战场漏怪。

  ​

- **低成本开荒托底**：实现自主推演与成熟作业库（MaaCopilot）的无缝切换，保证开荒不陷入死循环。

  ​

- **极简系统架构**：全栈统一采用 TypeScript / Node.js，无需启动 Python 微服务，减少部署与维护成本。

  ​

## 二、 MVP 功能边界 (Scope)

| **模块分类** | **In Scope (本次 MVP 必须交付)**                             | **Out of Scope (后续迭代优化)**                              |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **底层环境** | 1. 自动挂载明日方舟官方 PC 客户端句柄2. DXGI 桌面复制高速截屏3. SendMessage 后台静默点击与手势注入 | 1. 针对模拟器 ADB 的跨平台适配2. 极端多开窗口的自动负载均衡  |
| **宏观调度** | 1. 账号宏观体检（理智、主线进度感知）2. 通用主线关卡 OCR 动态滑动导航3. 基础资源本（LS-5 经验本）代理刷取 | 1. 复杂肉鸽（集成战略）全自动攻坚2. 全干员基建极值产出智能排班3. 公开招募自动计算器联动 |
| **微观战斗** | 1. 0 费与关键事件触发战术暂停2. 费用与手牌可用状态结构化提取3. 基础 2D 等轴测网格转换与部署拖拽 | 1. 战场复杂 3D 高低差地块透视动态补正2. 毫秒级极限撤退与再部署微操 |
| **容错保底** | 1. 战斗失败计数机制2. 连续战败 2 次自动拉取本地 Copilot 作业通关 | 1. 云端实时自适应爬取 B 站最新攻略视频2. 动态修改 Copilot 轴以适应残缺练度 |

## 三、 业务流程与状态机

### 3.1 核心开荒闭环

Plaintext`       【玩家在 Coopanion 唤醒大肥鱼】                     │                     ▼        [阶段 1: 账号状态扫描 (Macro)]        - 读取当前理智、龙门币、主线进度        - 判定决策: (A) 理智溢出 -> 刷 LS-5                    (B) 理智正常 -> 推进主线未通关关卡                     │                     ▼        [阶段 2: 关卡导航与切入]        - MaaFW 执行通用导航，OCR 寻关        - 点击开始行动，进入战场加载                     │                     ▼ ┌───>  [阶段 3: 战场推演循环 (Battle Loop)] │      - 触发【战术暂停】(Freeze Game) │      - MaaFW 提取费用、手牌、生命值并结构化打包 │      - 大模型推演战术，调用 deploy_operator 工具 │      - MaaFW 发送物理手势部署干员并验证血条 │      - 解除暂停恢复运行 (Resume) │                   │ └── 未通关且继续战斗 ┘                     │                     ▼ 战斗结算              [阶段 4: 结果判定]             /                \      (三星通关)             (战斗失败)          │                      │    桌宠播报喜讯          失败计数器 fail_count + 1                                 │                     ┌───────────┴───────────┐              fail_count < 2          fail_count >= 2                     │                       │               调整思路重新推演         桌宠触发台词求助                                     加载对应关卡 Copilot 作业                                     MaaFW 自动打通并重置计数`

## 四、 详细模块与项目结构

### 4.1 项目目录结构

Plaintext`arknights-coopanion-world/├── package.json├── tsconfig.json│├── resource/                                 # MaaFramework 识别与 Pipeline 资源│   ├── model/                                # PaddleOCR ONNX 推理模型│   ├── image/                                # 关键 UI 特征切片 (暂停键/费用标志/职业图标)│   └── pipeline/│       ├── navigation.json                   # 通用 OCR 滑动寻关任务流│       ├── infrastructure.json               # 基建日常收菜换班任务流 (复用社区配置)│       └── battle_inspect.json               # 战况感知专用 Pipeline│└── src/    ├── index.ts                              # World 插件入口，注册大肥鱼能力与生命周期    │    ├── mfw/                                  # 【底层驱动层】MaaFramework 原生封装    │   ├── client.ts                         # Win32Controller / Resource / Tasker 单例管理    │   ├── grid_mapper.ts                    # 地图网格 (Row, Col) 到 PC 视口像素 (X, Y) 映射    │   └── gesture.ts                        # 键鼠手势驱动 (长按拖拽、方向滑动、技能释放)    │    ├── agent/                                # 【战术策略层】    │   ├── battle_loop.ts                    # 战术暂停与战况监控状态机    │   ├── context_builder.ts                # 战况数据清洗，压缩组装为标准 LLM 上下文    │   └── fallback_tracker.ts               # 开荒失败计数器与 Copilot 作业调度    │    └── tools/                                # 【函数调用层】暴露给大模型的 Function Call        ├── account_tools.ts                  # get_account_overview        ├── navigation_tools.ts               # navigate_and_enter_stage        └── battle_tools.ts                   # get_battle_state, deploy_operator, trigger_pause`

## 五、 核心接口设计 (Agent Tools)

插件层需向大模型注册以下 4 个关键工具，统一遵循 OpenAI 标准 Function Calling 格式。

### 5.1 `get_account_overview`

- **功能**：读取当前主界面宏观资源，用于决定推图还是刷经验。

  ​

- **参数**：无

  ​

- **返回格式**：

  ​

  JSON`{  "sanity": 118,  "max_sanity": 125,  "current_stage": "2-3",  "gold": 45020}`

### 5.2 `navigate_and_enter_stage`

- **功能**：通过 OCR 搜索目标关卡，完成翻页并进入战斗准备阶段。

  ​

- **参数声明**：

  ​

  JSON`{  "type": "object",  "properties": {    "stage_code": {      "type": "string",      "description": "关卡代号，例如 '2-3', 'LS-5', '1-7'"    }  },  "required": ["stage_code"]}`

### 5.3 `get_battle_state`

- **功能**：截取战斗当前帧并触发战术暂停，提取微观战场核心参数。

  ​

- **参数**：无

  ​

- **返回格式**：

  ​

  JSON`{  "cost": 14,  "life_points": 3,  "is_paused": true,  "hand_operators": [    { "name": "芬", "cost": 9, "ready": true },    { "name": "克洛丝", "cost": 12, "ready": true },    { "name": "蛇屠箱", "cost": 18, "ready": false }  ],  "deployed_operators": [    { "name": "翎羽", "grid": [2, 3], "hp_percent": 85 }  ]}`

### 5.4 `deploy_operator`

- **功能**：将指定干员拖拽部署至目标网格并确定朝向。

  ​

- **参数声明**：

  ​

  JSON`{  "type": "object",  "properties": {    "operator_name": {      "type": "string",      "description": "干员名称，例如 '芬'"    },    "grid_row": {      "type": "integer",      "description": "战场地块行坐标 (0-based)"    },    "grid_col": {      "type": "integer",      "description": "战场地块列坐标 (0-based)"    },    "direction": {      "type": "string",      "enum": ["up", "down", "left", "right"],      "description": "攻击/防守朝向"    }  },  "required": ["operator_name", "grid_row", "grid_col", "direction"]}`

## 六、 关键技术实现范例 (Node.js)

### 6.1 MaaClient 单例驱动 (`src/mfw/client.ts`)

TypeScript`import * as maa from './maa'export class MaaClient {  private static instance: MaaClient  public tskr!: maa.Tasker  public ctrl!: maa.Win32Controller  public res!: maa.Resource  private constructor() {}  public static async getInstance(): Promise<MaaClient> {    if (!MaaClient.instance) {      MaaClient.instance = new MaaClient()      await MaaClient.instance.init()    }    return MaaClient.instance  }  private async init(): Promise<void> {    // 1. 扫描官方 PC 端窗口句柄    const winList = await maa.Win32Controller.find()    const target = winList?.find(w => w.window_name.includes('明日方舟'))    if (!target) {      throw new Error('未检测到明日方舟官方 PC 客户端，请先启动游戏！')    }    // 2. 初始化 Win32 控制器 (DXGI 无黑边高帧率截屏 + SendMessage 后台静默输入)    this.ctrl = new maa.Win32Controller(      target.hwnd,      maa.Win32ScreencapMethod.DXGI_DesktopDup,      maa.Win32InputMethod.SendMessage    )    await this.ctrl.post_connection().wait()    // 3. 加载本地 Pipeline 资产包    this.res = new maa.Resource()    await this.res.post_bundle('./resource').wait()    // 4. 组装并初始化任务执行器    this.tskr = new maa.Tasker()    this.tskr.controller = this.ctrl    this.tskr.resource = this.res    if (!this.tskr.inited) {      throw new Error('MaaFramework Tasker 初始化失败，请检查资源路径！')    }  }  // 通用任务执行与参数覆盖接口  public async run(taskName: string, paramOverride?: Record<string, unknown>): Promise<boolean> {    const job = paramOverride       ? this.tskr.post_task(taskName, paramOverride)       : this.tskr.post_task(taskName)    const result = await job.wait()    return result.success  }}`

### 6.2 部署干员拖拽手势 (`src/mfw/gesture.ts`)

TypeScript`import { MaaClient } from './client'export async function executeDeployGesture(  fromPos: [number, number],  toPos: [number, number],  direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {  const mfw = await MaaClient.getInstance()  const [x0, y0] = fromPos  const [x1, y1] = toPos  // 计算攻击朝向滑动矢量偏移  const dirOffsetMap: Record<string, [number, number]> = {    up: [0, -80],    down: [0, 80],    left: [-80, 0],    right: [80, 0]  }  const [dx, dy] = dirOffsetMap[direction]  // 执行手势：按下手牌 -> 拖至地块 -> 滑动定朝向 -> 松开  await mfw.ctrl.post_swipe(x0, y0, x1, y1, 200).wait()  await mfw.ctrl.post_swipe(x1, y1, x1 + dx, y1 + dy, 150).wait()}`

## 七、 实施里程碑计划

Plaintext`Day 1 - Day 2: 基础连通性与底层验证├── 引入 @maa/framework Node.js 模块├── 实现 Win32Controller 绑定 Arknights.exe 窗口└── 跑通 DXGI 抓帧并验证 SendMessage 点击/拖拽可用性Day 3 - Day 4: Pipeline 资产集成与视觉接口├── 导入 OCR 模型及关卡导航 JSON 配置├── 实现通用 OCR 滑动寻关任务及参数覆盖逻辑└── 调优“战术暂停”与“费用/手牌状态提取”函数Day 5 - Day 6: Coopanion 适配与大模型联调├── 编写 Coopanion World 插件入口，注册 4 个核心 Tools├── 编写开荒失败状态机与 Copilot 作业回退逻辑└── 在关卡 1-7 与 2-1 上完成全流程自主闭环实测`

## 八、 验收指标 (Acceptance Criteria)

1. **后台静默执行**：大肥鱼执行干员部署、选关等动作时，系统真实鼠标光标不发生位移与抢占，不影响宿主日常办公与操作。

   ​

2. **战术暂停生效**：进入战斗后 0 费阶段，脚本能在 1 秒内触发暂停；大模型完成决策前游戏维持暂停状态，决策下发后恢复，无因时延导致的早期漏怪。

   ​

3. **开荒容错闭环**：在自主开荒模式下，如果因策略或练度失误连续失败 2 次，大肥鱼能主动触发台词并切换到内置的 Copilot 作业文件自动通关，不发生流程中断或死锁。