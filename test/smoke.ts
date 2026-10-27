/**
 * 真机冒烟：绕开 Coopanion，直接验「窗口枚举 → 截图 → 识别 → 点击/拖拽」这条链路。
 *
 *   pnpm smoke                                  只截图，不点击
 *   pnpm smoke --state                          只读：抓帧 + 识别战场数字，打印原始行与结构化结果
 *   pnpm smoke --ocr                            只跑识别，额外打印原始识别明细（确认模型路径与返回结构）
 *   pnpm smoke --click                          点配置里的暂停坐标（默认 0.966 / 0.071）
 *   pnpm smoke --click 60,555                   按像素点一个大目标，用来判断输入是否送达
 *   pnpm smoke --click --input SendMessage      换输入方式（默认 AnchoredTouch）
 *   pnpm smoke --click --pause 0.966,0.071      现场校准暂停坐标（当前默认值）
 *   pnpm smoke --deploy 0.1,0.9,0.5,0.5,up      按归一化坐标部署：手牌x,y、地块x,y、朝向
 *   pnpm smoke --resource D:\models\ocr           临时指定 OCR 模型目录（覆盖包内模型）
 *   pnpm smoke --window "明日方舟" --shot trial 指定窗口关键字与输出前缀
 *
 * 每次点击/拖拽后自动补拍一张 `<前缀>-after.png`（部署时是 `<前缀>-deploy-after.png`），
 * 与 `<前缀>-before.png` 对照即可判断有没有生效。不联网、不读任何密钥；图片只写到当前目录。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEPLOY_DIRECTIONS, planDeploy } from '../cortico-world-arknights/src/battle/deploy.ts';
import { regionOf } from '../cortico-world-arknights/src/battle/regions.ts';
import { describeBattleState, missingFields, parseBattleState } from '../cortico-world-arknights/src/battle/state.ts';
import { ARKNIGHTS_DEFAULTS, type ArknightsConfigSection } from '../cortico-world-arknights/src/config.ts';
import { toPoint } from '../cortico-world-arknights/src/mfw/geometry.ts';
import { pngSize } from '../cortico-world-arknights/src/mfw/screen.ts';
import { ArknightsSession } from '../cortico-world-arknights/src/mfw/session.ts';

const argv = process.argv.slice(2);

/** `--name value` 与 `--name=value` 都认；没有值时返回 true。 */
function take(name: string): string | true | undefined {
  const inline = argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  return next && !next.startsWith('--') ? next : true;
}

class ArgError extends Error {}

function takePoint(name: string): { x: number; y: number } | undefined {
  const raw = take(name);
  if (typeof raw !== 'string') return undefined;
  const [x, y] = raw.split(',').map((part) => Number(part.trim()));
  // 参数写错就整体放弃，绝不退回默认坐标去点游戏。
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ArgError(`--${name} 需要 "数字,数字"，收到：${raw}`);
  return { x: x as number, y: y as number };
}

async function main(): Promise<void> {
  const windowArg = take('window');
  const inputArg = take('input');
  const screencapArg = take('screencap');
  const clickArg = take('click');
  const shotArg = take('shot');

  let pauseArg: { x: number; y: number } | undefined;
  let pixelTarget: { x: number; y: number } | undefined;
  try {
    pauseArg = takePoint('pause');
    pixelTarget = takePoint('click');
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    console.error(error.message);
    console.error('参数写错时不会发送任何点击。');
    process.exitCode = 2;
    return;
  }

  const stateArg = take('state');
  const ocrArg = take('ocr');
  const resourceArg = take('resource');
  const deployArg = take('deploy');

  if (deployArg !== undefined && typeof deployArg !== 'string') {
    console.error('--deploy 需要 "手牌x,手牌y,地块x,地块y,朝向"，例如 --deploy 0.1,0.9,0.5,0.5,up');
    process.exitCode = 2;
    return;
  }

  const prefix = typeof shotArg === 'string' ? shotArg : 'smoke';
  const cfg: ArknightsConfigSection = {
    ...ARKNIGHTS_DEFAULTS,
    enabled: true,
    windowMatch: typeof windowArg === 'string' ? windowArg : ARKNIGHTS_DEFAULTS.windowMatch,
    screencapMethod: (typeof screencapArg === 'string'
      ? screencapArg
      : ARKNIGHTS_DEFAULTS.screencapMethod) as ArknightsConfigSection['screencapMethod'],
    inputMethod: (typeof inputArg === 'string'
      ? inputArg
      : ARKNIGHTS_DEFAULTS.inputMethod) as ArknightsConfigSection['inputMethod'],
    pauseButton: pauseArg ?? ARKNIGHTS_DEFAULTS.pauseButton,
    resourceDir: typeof resourceArg === 'string' ? resourceArg : ARKNIGHTS_DEFAULTS.resourceDir,
  };

  const session = new ArknightsSession(
    undefined,
    (line) => console.warn(`[warn] ${line}`),
    (line) => console.log(`[info] ${line}`),
  );
  const save = (name: string, png: Uint8Array): string => {
    const file = join(process.cwd(), `${prefix}-${name}.png`);
    writeFileSync(file, png);
    return file;
  };

  console.log(`窗口关键字：${cfg.windowMatch}`);
  console.log(`输入方式：${cfg.inputMethod}　截图方式：${cfg.screencapMethod}`);

  const connected = await session.connect(cfg);
  if (!connected.ok) {
    console.error(connected.error);
    process.exitCode = 1;
    await session.stop();
    return;
  }

  const [width, height] = connected.resolution;
  const reported = session.controllerResolution;
  console.log(`窗口：「${connected.window.windowName}」（类名 ${connected.window.className}）`);
  console.log(`控制器报告的尺寸：${reported ? `${reported[0]}×${reported[1]}` : '未报告'}`);
  console.log(`点击换算用的尺寸：${width}×${height}`);

  const before = await session.screencap();
  if (!before.ok) {
    console.error(before.error);
    process.exitCode = 1;
    await session.stop();
    return;
  }

  const beforeSize = pngSize(before.png);
  console.log(`本帧实际像素尺寸：${beforeSize ? `${beforeSize.width}×${beforeSize.height}` : '读不出来'}`);
  if (beforeSize && reported && (beforeSize.width !== reported[0] || beforeSize.height !== reported[1])) {
    console.log(`[info] 控制器尺寸 ${reported[0]}×${reported[1]} 与本帧 ${beforeSize.width}×${beforeSize.height} 不同。`);
    console.log('       这是 MaaFramework 把截图短边缩到 720 的正常结果（窗口 1920×1080 → 帧 1280×720），');
    console.log('       点击按本帧换算。只有当控制器尺寸明显大于窗口、且帧里能看到桌面背景时，才是整屏抓取。');
  }
  console.log(`截图：${save('before', before.png)}（${before.png.byteLength} 字节）`);

  // 目标坐标按本帧实际尺寸换算；显式给了像素就直接用像素。
  const frameSize: readonly [number, number] = beforeSize
    ? [beforeSize.width, beforeSize.height]
    : [width, height];
  const wantsClick = clickArg !== undefined || pixelTarget !== undefined;
  const wantsOcr = stateArg !== undefined || ocrArg !== undefined;

  if (!wantsClick && !wantsOcr && deployArg === undefined) {
    console.log('未发送点击。要试点击：pnpm smoke --click；要读战场：pnpm smoke --state');
    await session.stop();
    return;
  }

  if (wantsOcr) {
    if (cfg.resourceDir.trim()) {
      console.log(`[ocr] 自定义模型目录：${cfg.resourceDir}`);
    }
    const ocr = await session.recognizeFrame(before.png, cfg.resourceDir);
    if (!ocr.ok) {
      // 识别不了不算脚本失败：--state 的意义就是看清楚「能读到什么」，降级信息本身也是结果。
      console.log(`[state] 这次读不出战场数字：${ocr.error}`);
      console.log('[state] 附件就是上面的 before 图，直接用眼睛看；确认包内 assets/resource/model/ocr 三件套齐全，或用 --resource 覆盖。');
      if (ocrArg !== undefined) process.exitCode = 1;
    } else {
      if (ocrArg !== undefined) {
        console.log('[ocr] 原始识别明细：');
        console.dir(ocr.rawDetail, { depth: 4 });
      }
      console.log(`[ocr] 识别到 ${ocr.lines.length} 行（区域用于核对 src/battle/regions.ts 的区间）：`);
      for (const line of ocr.lines) {
        const px = `${Math.round(line.box.x * frameSize[0])},${Math.round(line.box.y * frameSize[1])}`;
        console.log(
          `  「${line.text}」 归一化 ${line.box.x.toFixed(3)},${line.box.y.toFixed(3)}`
            + `　像素 ${px}　区域 ${regionOf(line.box)}`,
        );
      }
      if (ocr.debug) console.log(`  （${ocr.debug}）`);
      if (ocr.lines.length === 0) {
        console.log('  （0 行通常是模型与 maa-node 版本不兼容：看上面有没有「Failed to load det or rec」，');
        console.log('    再确认「OCR 模型加载自」指向的是包内 assets/resource/model/ocr；');
        console.log('    必要时用 --resource 指到 MaaCommonAssets 的 ppocr_v4 模型目录覆盖。）');
      }

      const state = parseBattleState(ocr.lines);
      console.log(`[state] ${describeBattleState(state)}`);
      console.log(`[state] 结构化：${JSON.stringify(state)}`);
      const missing = missingFields(state);
      if (missing.length > 0) console.log(`[state] 没读到：${missing.join('、')}`);
      console.log('[state] 某项一直读不到时，按上面每行的像素坐标去调 src/battle/regions.ts 的区间。');
    }
  }

  if (deployArg !== undefined) {
    const parts = (deployArg as string).split(',').map((part) => part.trim());
    const [cx, cy, tx, ty] = parts.slice(0, 4).map((part) => Number(part));
    const direction = parts[4];
    console.log(
      `部署目标：手牌 (${cx}, ${cy}) → 地块 (${tx}, ${ty})，朝向 ${String(direction)}`
        + `　画面 ${frameSize[0]}×${frameSize[1]}`,
    );
    const planned = planDeploy({ x: cx, y: cy }, { x: tx, y: ty }, direction, frameSize);
    if (!planned.ok) {
      console.error(planned.error);
      if (typeof direction !== 'string' || !(DEPLOY_DIRECTIONS as readonly string[]).includes(direction)) {
        console.error(`--deploy 的朝向必须是 ${DEPLOY_DIRECTIONS.join(' / ')} 之一。`);
      }
      console.error('参数不对时不发任何拖拽。');
      process.exitCode = 2;
      await session.stop();
      return;
    }

    const { plan } = planned;
    console.log(`  拖拽 1/2：(${plan.card.x}, ${plan.card.y}) → (${plan.tile.x}, ${plan.tile.y})，${plan.holdMs}ms`);
    const picked = await session.swipe(plan.card.x, plan.card.y, plan.tile.x, plan.tile.y, plan.holdMs);
    console.log(picked.ok ? '控制器回执：拖拽 1 已发送' : picked.error);
    if (!picked.ok) process.exitCode = 1;

    if (picked.ok) {
      console.log(
        `  拖拽 2/2：(${plan.tile.x}, ${plan.tile.y}) → (${plan.release.x}, ${plan.release.y})，${plan.directionMs}ms`,
      );
      const aimed = await session.swipe(plan.tile.x, plan.tile.y, plan.release.x, plan.release.y, plan.directionMs);
      console.log(aimed.ok ? '控制器回执：拖拽 2 已发送' : aimed.error);
      if (!aimed.ok) process.exitCode = 1;
    }

    const afterDeploy = await session.screencap();
    if (!afterDeploy.ok) {
      console.error(afterDeploy.error);
      process.exitCode = 1;
    } else {
      console.log(`对照帧：${save('deploy-after', afterDeploy.png)}（${afterDeploy.png.byteLength} 字节）`);
      console.log('对比 before / deploy-after：干员有没有出现在目标地块、朝向箭头对不对。');
    }
  }

  if (wantsClick) {
    const point = pixelTarget ?? toPoint(cfg.pauseButton, frameSize);
    const normX = point.x / Math.max(1, frameSize[0] - 1);
    const normY = point.y / Math.max(1, frameSize[1] - 1);
    console.log(`点击目标：(${point.x}, ${point.y})，输入方式 ${cfg.inputMethod}`);
    console.log(
      `  归一化：${normX.toFixed(3)},${normY.toFixed(3)}　画面比例：${(frameSize[0] / frameSize[1]).toFixed(3)}`
        + '（标定基准为 1.778，即 16:9）',
    );

    const clicked = await session.click(point.x, point.y);
    console.log(clicked.ok ? '控制器回执：点击已发送' : clicked.error);

    const after = await session.screencap();
    if (!after.ok) {
      console.error(after.error);
      process.exitCode = 1;
    } else {
      console.log(`对照帧：${save('after', after.png)}（${after.png.byteLength} 字节）`);
      console.log('对比 before / after 两张图：目标有没有被选中、有没有暂停，一眼就能看出来。');
    }
    if (!clicked.ok) process.exitCode = 1;
  }

  await session.stop();
}

await main();
