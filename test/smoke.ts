/**
 * 真机冒烟：绕开 Coopanion，直接验「窗口枚举 → 截图 → 点击」这条链路。
 *
 *   pnpm smoke                                  只截图，不点击
 *   pnpm smoke --click                          点配置里的暂停坐标（默认 0.97 / 0.06）
 *   pnpm smoke --click 60,555                   按像素点一个大目标，用来判断输入是否送达
 *   pnpm smoke --click --input AnchoredTouch    换输入方式
 *   pnpm smoke --click --pause 0.962,0.044      现场校准暂停坐标
 *   pnpm smoke --window "明日方舟" --shot trial 指定窗口关键字与输出前缀
 *
 * 每次点击后自动补拍一张 `<前缀>-after.png`，与 `<前缀>-before.png` 对照即可判断有没有生效。
 * 不联网、不读任何密钥；图片只写到当前目录。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  };

  const session = new ArknightsSession(undefined, (line) => console.warn(`[warn] ${line}`));
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
    console.warn(`[warn] 控制器尺寸 ${reported[0]}×${reported[1]} 与本帧 ${beforeSize.width}×${beforeSize.height} 不一致。`);
    console.warn('        常见于该截图方式抓到整屏（DXGI_DesktopDup）：坐标会按本帧换算，但落点仍在整屏坐标系里，');
    console.warn('        点不到游戏窗口内的按钮。做点击验证时请用能只截窗口的方式（如 Background）。');
  }
  console.log(`截图：${save('before', before.png)}（${before.png.byteLength} 字节）`);

  if (clickArg === undefined && pixelTarget === undefined) {
    console.log('未发送点击。要试点击：pnpm smoke --click');
    await session.stop();
    return;
  }

  // 目标坐标按本帧实际尺寸换算；显式给了像素就直接用像素。
  const frameSize: readonly [number, number] = beforeSize
    ? [beforeSize.width, beforeSize.height]
    : [width, height];
  const point = pixelTarget ?? toPoint(cfg.pauseButton, frameSize);
  console.log(`点击目标：(${point.x}, ${point.y})，输入方式 ${cfg.inputMethod}`);

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

  await session.stop();
}

await main();
