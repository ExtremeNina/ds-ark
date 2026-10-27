# cortico-world-arknights

Coopanion（Cortico 框架）的 World 扩展：把国服《明日方舟》PC 客户端接进桌宠。

第一版只做三件事，用来把链路打通：

| 工具 | 做什么 | 不做什么 |
|---|---|---|
| `ark_connect` | 枚举本机窗口，按窗口名关键字找到客户端并建立连接，回报窗口名、类名、截图分辨率 | 不启动游戏、不切换账号 |
| `ark_screencap` | 抓取当前一帧，作为 PNG 附件随回执交给模型 | 不做识别、不读费用/手牌/关卡 |
| `ark_set_paused` | 向配置的暂停按钮位置发一次点击（`true` 暂停 / `false` 继续），默认再补拍一帧作为附件 | 不确认游戏是否真的暂停，只提供点击后的画面供模型自己判断 |

没有 OCR，没有自动战斗，不做选关与战败回退。不发任何网络请求。

## 安装到 Coopanion（本机目录）

1. 在本目录执行：

   ```bash
   corepack pnpm install
   pnpm test
   ```

2. 打开 Coopanion 的**扩展页** → **从本机目录安装**（以 `link` 方式装入，不是拷贝）。
   选中的目录就是这个包目录（含 `package.json` 的那一层）。
3. **重启 Coopanion 进程**，扩展才会被加载。
4. 到 **World 总览**启用「明日方舟」，否则三个工具不会挂载。
5. 之后改了源码，**重启进程**才生效。
6. 出问题时在 **World 总览**关掉它，或直接卸载扩展。

安装前 Coopanion 只读 `package.json` 做声明校验，不会执行包里的代码；但扩展一旦启用就跑在 Coopanion 核心进程里，没有沙箱——请先自己读完源码再决定启用。

## 第一次使用要校准暂停按钮

暂停按钮的位置按**画面比例**存，**在同一宽高比下**换分辨率不用重新校准：

```json
{
  "worlds": {
    "arknights": {
      "enabled": true,
      "windowMatch": "明日方舟,Arknights",
      "screencapMethod": "Default",
      "inputMethod": "AnchoredTouch",
      "pauseButton": { "x": 0.966, "y": 0.071 },
      "verifyAfterClick": true,
      "resourceDir": ""
    }
  }
}
```

`x` / `y` 是 0~1 的比例（0 = 最左/最上，1 = 最右/最下），按 `像素 / (边长 - 1)` 归一化，也可以在扩展的 World 页表单里改，改完下一次工具调用立即生效。默认值 `0.966 / 0.071` 是真机实测的暂停键中心（1280×720 帧里的 1236,51）。

### 只有 16:9 是保证的

默认值是在 16:9 画面上标定的（1280×720、1920×1080 等）。换成 16:10、21:9 或用户拖出来的任意比例时，按钮的**相对位置会变**，坐标不再保证命中。扩展会在每次连接的第一帧之后检查一次比例，不是 16:9 就往日志里写一条提示（不进模型上下文，不会打扰对话）。

换比例后要重新标定：

1. 让游戏窗口保持在要用的比例上，进一场战斗。
2. 在仓库根的 `test/` 包跑 `pnpm smoke`，看输出的帧尺寸，用看图工具量出暂停键中心的像素坐标。
3. 跑 `pnpm smoke --click --pause <x>,<y>`，脚本会回显该像素对应的归一化值，并打印当前画面的宽高比；点中后把这两个比例填回配置。
4. `x = 像素x / (帧宽 - 1)`、`y = 像素y / (帧高 - 1)`，保留 3 位小数即可（上面的归一化值就是这个算法）。
5. 每个常用比例各标一组；扩展本身不做黑边检测与自动补偿，非 16:9 只提示不动手。

**怎么快速校准**：先进一场已经打过的关卡让战斗跑起来，把暂停键中心的位置按上面的算法填进去，然后在仓库根的 `test/` 包里跑 `pnpm smoke --click`，看游戏是否真的暂停。

## 真机冒烟（不经过 Coopanion）

冒烟脚本不在本包内，放在仓库根的 `test/` 包里（它需要真机、游戏窗口与原生模块，不该随扩展发布）：

```bash
cd ../test
corepack pnpm install
pnpm smoke                                   # 只截图，存 <前缀>-before.png
pnpm smoke --click                           # 点配置里的暂停坐标，再存一张 <前缀>-after.png
pnpm smoke --click 60,555                    # 按像素点一个大目标，用来判断输入有没有送达
pnpm smoke --click --input SendMessage       # 换输入方式（默认 AnchoredTouch）
pnpm smoke --click --pause 0.966,0.071       # 现场校准暂停坐标，不用改源码
pnpm smoke --window "明日方舟" --shot trial  # 换窗口关键字与输出前缀
pnpm smoke --screencap DXGI_DesktopDup       # 换截图方式
```

脚本会打印「控制器报告的尺寸」「本帧实际像素尺寸」「点击换算用的尺寸」「最终落点」，点击时还会回显该像素的**归一化值**（保留 3 位小数）与**当前画面宽高比**，方便按分辨率逐个补坐标。点击后自动补拍对照帧 `<前缀>-after.png`。

控制器尺寸与帧尺寸不一致是常态：MaaFramework 会把截图短边缩到 720（窗口 1920×1080 → 帧 1280×720），脚本会把它当 info 打印。只有当控制器尺寸明显大于窗口、且帧里能看到桌面背景时，才是整屏抓取。

脚本直接引用本包源码，改完扩展不用重装依赖；它会写出 `<前缀>-before.png`（点击前）与 `<前缀>-after.png`（点击后），可以拿它们核对截图是否正常、点击有没有生效。这一步验证的是最不确定的三件事：窗口能不能被枚举到、DXGI/后台截图是否出画面、所选输入方式点击游戏是否响应。三者任一不通，后面的功能都无从谈起。

## 开发命令

```bash
corepack pnpm install   # 装依赖（含 @maaxyz/maa-node 预编译原生包，下载较慢）
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run（44 个用例，不需要游戏，也不加载原生模块）
```

测试用假的 maa 模块替掉原生绑定，覆盖坐标换算、窗口匹配、未连接降级、回执形状，以及 `tools()` / `describe.json` / `ENV_PROMPT.md` 三者的一致性。

> `pnpm check:extension` / `pnpm describe:extension` 必须在 **Cortico 仓库根**执行，本包没有克隆整个框架，因此 `describe.json` 是手写并靠测试锁一致性的。如果你本地有 Cortico 检出，建议在发布前跑一次：

```bash
pnpm check:extension <本包目录>
```

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 由 World 总览或部署配置打开 |
| `windowMatch` | `明日方舟,Arknights` | 窗口标题包含其一即命中，逗号分隔 |
| `screencapMethod` | `Default` | 取值见 `@maaxyz/maa-node` 的 `Win32ScreencapMethod`；`Default` 用后台可采的 `Background`（FramePool \| PrintWindow） |
| `inputMethod` | `AnchoredTouch` | 取值见 `Win32InputMethod`；实测能命中右上角小按钮且不抢前台，`SendMessage` 系在本客户端点不中 |
| `pauseButton` | `0.966 / 0.071` | 暂停按钮中心的比例坐标，只在 16:9 下保证 |
| `verifyAfterClick` | `true` | 暂停/恢复点击后补拍一帧作为附件；关掉可省一次抓帧与一张图的 token |
| `resourceDir` | 空 | 预留给后续 OCR，本版不加载 `Resource`/`Tasker` |

## 权限要求（实测踩过）

**Coopanion 与游戏必须是同一权限级别。** 如果游戏以管理员身份运行、而 Coopanion 不是，Windows 的 UIPI 会同时拦掉两件事：

- 后台截图失败，连接直接被拒（状态码 `4000`），MaaFramework 日志里会出现
  `SetWindowLongPtr failed ... GetLastError()=5`
- 合成点击（`SendMessage` / `PostMessage`）被丢弃，工具回执照样说「已发送点击」，但游戏毫无反应

两种解法：把游戏改成普通权限启动（启动器/游戏 exe 属性 → 兼容性 → 取消「以管理员身份运行」），或者让 Coopanion 也以管理员身份运行。前者更安全。

诊断时可以只截一个普通窗口（比如记事本）做对照：同样的 `Background` 方式能连上普通窗口却连不上游戏，就是权限不对等。

## 已知风险

- **点击可能不生效**：默认的 `AnchoredTouch` 实测能点中暂停键与倍速键，也不把游戏抢到前台，但仍然可能被游戏某次更新忽略。`SendMessage` / `PostMessage` 系更静默，但实测在本客户端点不中右上角的小按钮；`Seize` 能点但会抢占鼠标。注意：MVP 文档里「后台静默执行」这条验收指标在部分游戏上可能根本达不到。
- **暂停坐标只在 16:9 下保证**：默认值按 16:9 标定，换宽高比后不保证命中。扩展只在第一帧之后往日志里提示一次「不是 16:9」，不做黑边检测与坐标补偿；重标步骤见上一节。
- **补拍有代价**：`verifyAfterClick` 默认开启，每次暂停/恢复都会多抓一帧，并把这张图放进模型上下文（多一次截图延迟、一张图的 token）。不想要就把它关掉，回执退回纯文字。
- **截图可能全黑**：独占全屏、HDR、多显卡切换、窗口最小化都会影响。`Background` 系对最小化窗口有伪最小化支持，其他方式会失败。
- **`DXGI_DesktopDup` 抓到的是整屏**：实测它会把整个桌面按比例缩放后交回来（例如 2560×1600 的桌面变成 1152×720 的帧），游戏窗口只是其中一块。用这种方式算出来的点击坐标落在整屏坐标系里，点不中游戏按钮。排查时可以用它验证「能不能看到画面」，但**不要用它做点击验证**。扩展内部已改成始终按「最近一帧的真实像素尺寸」换算，并在帧尺寸与控制器尺寸不一致时记一条 warn。
- **状态不可回读**：本版没有识别能力，工具只能保证「点击已发出」。回执不会说「已暂停」，只说「附件是点击之后抓的一帧，请据此判断」，把结论留给模型自己看画面。
- **游戏条款**：自动化操作可能违反游戏服务条款，风险由使用者承担。请只在自己的账号上、以不破坏公平性的方式使用。
- **只支持 Windows**：`package.json` 里 `os` 为 `win32`，其他平台会被拒绝安装。

## 隐私

- 不读取、不保存、不上传 API Key 或任何凭据；扩展不读 `ctx.secret()`。
- 不发网络请求，不下载任何资源。
- 截图（含 `ark_set_paused` 的补拍）只在本机内存里流转一次：作为工具回执的附件交给 Coopanion，由 Coopanion 决定是否发给**你自己配置的模型端点**。也就是说，**画面会进入模型上下文**——如果不希望画面离开本机，请不要接云端模型，或不要调用 `ark_screencap` 并把 `verifyAfterClick` 关掉。
- 日志只记录连接成功与错误原因，不记录截图内容、窗口句柄、用户目录。

## 素材与许可

- 本包从 `Pal-AI-Lab/Cortico` 的 `templates/extension/world` 模板起步，复制时仅改了包名、id、前缀与实现。Cortico 采用 **MIT** 许可证：<https://github.com/Pal-AI-Lab/Cortico>。
- 运行时依赖 `@maaxyz/maa-node`（作者 nekosu），来自 MaaFramework 仓库：<https://github.com/MaaXYZ/MaaFramework>，采用 **LGPL-3.0**。它以依赖形式安装，不随本包源码分发；其 npm 包内含的 MaaFramework 动态库、OCR 模型与 Agent 二进制同样遵循上游许可。
- 本包**不携带**任何游戏截图、UI 切片、OCR 模型或 pipeline 资源。`resourceDir` 只指向用户自己的本地资源目录。
- 本包自身许可见 `LICENSE`（MIT）。
