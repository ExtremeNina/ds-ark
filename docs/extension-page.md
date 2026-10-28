# 扩展页 README（上架时复制）

> 这是 `cortico-world-arknights` 发布页文案的草稿。上架时把本文件整段复制到扩展页，并按当时的
> 资源版本更新日期、下载地址与校验值；仓库内的 `README.md` 只描述运行时行为与边界。

## 这是什么

把国服《明日方舟》PC 客户端接进 Coopanion 桌宠：连接窗口、后台截图、读战场数字、部署干员，
以及用内置 pipeline 走到关卡编队页或集成战略主题页。扩展只提供代码与自己的 pipeline，
**OCR 模型随包发布，开箱即用，不需要安装 MAA，也不联网**。

## 资源从哪来

| 资源 | 是否随包 | 说明 |
|---|---|---|
| OCR 模型（PP-OCRv6 small） | 随包 | `assets/resource/model/ocr/`，Apache-2.0，约 20 MB，无需下载 |
| 导航 pipeline（六个 JSON） | 随包 | 本项目编写；坐标参考 MAA 资源的实测值（快照见 CHANGELOG） |
| MAA 的 `tasks/`、`template/`、`copilot/`、`roguelike/`、`Arknights-Tile-Pos/` | 不随包 | 将来若启用模板匹配或抄作业回退，才需要用户自备 |

## 如何下载与安装（可选资源）

当前版本**不需要下载任何资源**。将来需要 MAA 资源时：

1. 从 MAA 官方发布页（<https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases>）
   下载对应版本的 zip。
2. 校验 SHA256（发布页会给出校验值；PowerShell：`Get-FileHash <文件> -Algorithm SHA256`）。
3. 解压到任意目录（例如 `D:\soft\MAA-v6`）。
4. 扩展页 → 明日方舟 → 配置 → 把该目录填进资源路径；扩展只读取、不复制、不上传。

## 常见问题

- **`ark_battle_state` 读不出数字**：先看日志里「OCR 模型加载自」是否指向包内
  `assets/resource/model/ocr`；三件套缺一都会在回执里写明缺哪个文件。
- **选关失败、零点击**：回执里列出执行到的节点与当前画面文字。先用 `pnpm smoke --ping`
  验证 pipeline 链路，再 `pnpm smoke --enter CE-5` 校准 ROI；失败多数是 PC 端布局与
  MAA 手游快照有偏差，只调 ROI 不改节点结构。
- **权限**：游戏与 Coopanion 必须同权限级别（都管理员或都普通），否则截图与点击都会被拦。
