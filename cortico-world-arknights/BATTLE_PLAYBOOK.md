# 让模型自己打完一局

这份剧本配合 World 的六个工具使用：`ark_connect`、`ark_screencap`、`ark_battle_state`、`ark_deploy`、`ark_set_paused`、`ark_wait`。
模型在 Coopanion 里按它循环，**不需要任何 API key，也不联网**。

> 只想验收整条链路、不想开 Coopanion 时：用本地冒烟脚本 `pnpm smoke --auto`（固定策略、不调模型、认到结算就停）。这份剧本是给 Coopanion 里的模型看的，`--auto` 用的是它下面的简化版策略。

## 前置

1. 游戏窗口已启动，并且是 16:9（16:10 / 21:9 时暂停坐标会偏，日志会提示一次）。
2. 已经进了一场还没结束的战斗（关卡里，敌方在走）。
3. `worlds.arknights.resourceDir` 留空（用包内模型）；需要换模型时再填。

## 主循环

```
ark_connect                     # 一次就够，失败就问用户
  ↓
ark_battle_state                # 帧 + 费用 / 生命 / 敌人 / 手牌费用 / 是否已结算
  ↓
已结算？ ── 是 → 报告结果，结束
  │
  否
  ↓
选一张牌 + 一个地块（从附件里量 0~1 坐标）
  ↓
费用够？ ── 否 → ark_wait 2000~5000ms → 回到 ark_battle_state
  │
  是
  ↓
ark_deploy { card, tile, direction }
  ↓
看附件确认落位与朝向 → 回到 ark_battle_state
```

## 决策规则

- **一次只下一个干员**，下完先看附件，再决定下一步。连续两次没落位就停下问用户，不要叠加拖拽。
- **先下便宜的先锋/近卫挡住第一波**，再攒费下高费输出；费用不够就 `ark_wait`，不要用连续截图硬等（截图不产生费用，只会烧上下文）。
- **朝向**按敌人前进方向选：敌人从左往右走就 `right`，反之 `left`；高台干员朝敌人来的方向能覆盖更多路。
- **漏怪时**先 `ark_set_paused(true)`，看清局面再决策，部署完 `ark_set_paused(false)`。
- **停止条件**：`ark_battle_state` 的回执里出现「本局已结束（行动结束／胜利）」或「本局失败（作战失败）」。此时不要再部署，直接把结果和最后一帧报给用户。
- 认不出的东西（干员名、职业、地块坐标）只能看图判断；**不要凭猜想报数值**，回执说「没读到」就是没读到。

## 坐标怎么量

`ark_deploy` 的 `card` 与 `tile` 都是**整帧的 0~1 归一化坐标**，从附件图里目测：

- 手牌：卡面中心。卡费数字在卡面左上角，所以取「卡费位置再往右下一点」。
- 地块：目标格的中心。高台放狙击/术师，地面放近卫/重装。
- 部署失败最常见的原因是 `card` 没落在卡面上（点到卡之间的缝），把 x 往卡中心挪 0.02~0.03 再试。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `ark_battle_state` 说「没找到可用的 OCR 模型」 | 包内三件套缺失 | 检查 `assets/resource/model/ocr/` 是否平铺三件套 |
| 数字和画面对不上 | OCR 误识 | 以画面为准；必要时 `ark_screencap` 再确认一次 |
| 部署没反应 | 坐标没落在卡面/地块、费用不足、后台输入被忽略 | 重新截帧确认，再调一次；两次失败就停 |
| 部署回执 `状态码 4000`，日志里有 `occluded` / `contact is not down` | 目标点被其他窗口盖住（终端、置顶桌宠、输入法候选框），或拖拽太快 | 让游戏窗口露出来/设为置顶；把 `deployHoldMs` 调到 600、`deployGapMs` 调到 150 再试 |
| 暂停点不中 | 窗口不是 16:9 或暂停坐标没标定 | 改回 16:9，或按 README 重标 `pauseButton` |

## 手动复核

不进 Coopanion 也能核对每一步：

```powershell
cd C:\Users\Nina\Desktop\ds-ark\test
pnpm smoke --state                     # 看读数与是否已结算
pnpm smoke --watch                     # 只读循环：每 3 秒读一次，结算或按 Ctrl+C 结束
pnpm smoke --auto                      # 一次性战斗测试（固定策略，认到结算退出并打印汇总）
pnpm smoke --auto --auto-attempts 5 --hold 600 --gap 150   # 地块多试几次 + 放慢拖拽
pnpm smoke --deploy 0.12,0.90,0.45,0.55,right
```

`--watch` 只读，不会替你下干员；`--auto` 会真的下干员（固定策略，落位靠费用变化判断）。两个都用来确认「结算能认出来」「读数在动」「部署链路通」。
