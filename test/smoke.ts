/**
 * 真机冒烟：绕开 Coopanion，直接验「窗口枚举 → 截图 → 识别 → 点击/拖拽」这条链路。
 *
 *   pnpm smoke                                  只截图，不点击
 *   pnpm smoke --state                          只读：抓帧 + 识别战场数字，打印原始行与结构化结果
 *   pnpm smoke --watch [ms]                     只读循环：每 ms（默认 3000）读一次，认到结算自动退出
 *   pnpm smoke --auto                           本地自动打一局（固定策略，不需要模型）：下得起就下，直到结算
 *   pnpm smoke --auto --auto-tiles "0.4,0.55;0.5,0.65"   自己给候选地块（默认一张常见清单）
 *   pnpm smoke --auto --auto-max 40             最多读多少次状态（默认 30）
 *   pnpm smoke --auto --auto-attempts 5         每步最多试几个地块（默认 3）
 *   pnpm smoke --auto --auto-time 900           整体时间上限，秒（默认 600）
 *   pnpm smoke --deploy ... --hold 600 --gap 150 --dir 250   临时改部署时序（毫秒），不写进配置
 *   pnpm smoke --ping                           只跑 NavCommon@Ping，验证 post_bundle/post_task 链路
 *   pnpm smoke --enter CE-5                     用内置 pipeline 选关，停在编队页并打印轨迹/理智
 *   pnpm smoke --roguelike 傀影                 导航到集成战略主题页，不点「开始探索」
 *   pnpm smoke --ocr-all                        读全屏文字与坐标（导航用），不点击
 *   pnpm smoke --click-at "0.12,0.90"           按归一化坐标点一次
 *   pnpm smoke --swipe "0.5,0.8,0.5,0.4,400"    从一点拖到另一点（可选时长）
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
import { planClick, planSwipe } from '../cortico-world-arknights/src/battle/actions.ts';
import { DEPLOY_DIRECTIONS, planDeploy } from '../cortico-world-arknights/src/battle/deploy.ts';
import { regionOf } from '../cortico-world-arknights/src/battle/regions.ts';
import { describeBattleState, missingFields, parseBattleState } from '../cortico-world-arknights/src/battle/state.ts';
import { ARKNIGHTS_DEFAULTS, type ArknightsConfigSection } from '../cortico-world-arknights/src/config.ts';
import { pausePoint, toPoint } from '../cortico-world-arknights/src/mfw/geometry.ts';
import { pngSize } from '../cortico-world-arknights/src/mfw/screen.ts';
import { ArknightsSession } from '../cortico-world-arknights/src/mfw/session.ts';
import { roguelikeRoute, routeFor } from '../cortico-world-arknights/src/nav/route.ts';
import { describeSanity, parseSanity } from '../cortico-world-arknights/src/nav/sanity.ts';
import { describeTrace } from '../cortico-world-arknights/src/nav/trace.ts';

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

/** `--auto-tiles "0.4,0.55;0.5,0.65"` → 候选地块列表。 */
function parseTiles(raw: string): Array<{ x: number; y: number }> {
  const tiles = raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((pair) => {
      const [x, y] = pair.split(',').map((value) => Number(value.trim()));
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ArgError(`--auto-tiles 里有非法坐标：${pair}`);
      return { x: x as number, y: y as number };
    });
  if (tiles.length === 0) throw new ArgError('--auto-tiles 至少给一个 "x,y"');
  return tiles;
}

/**
 * 只读循环：每隔一段时间抓帧 + 识别一次，打印一行摘要；认到结算就退出。
 *
 * 它不下干员、不点暂停——「让模型自己打」靠的是 Coopanion 里的模型，
 * 这里只用来确认「结算能不能认出来」和「读数在动」。
 */
async function runWatch(session: ArknightsSession, cfg: ArknightsConfigSection, intervalMs: number): Promise<void> {
  console.log(`[watch] 每 ${intervalMs}ms 读一次，认到结算即退出，Ctrl+C 结束。只读，不点击。`);
  for (let round = 1; ; round += 1) {
    const shot = await session.screencap();
    if (!shot.ok) {
      console.log(`[watch] 第 ${round} 次抓帧失败：${shot.error}`);
      return;
    }
    const ocr = await session.recognizeFrame(shot.png, cfg.resourceDir);
    if (!ocr.ok) {
      console.log(`[watch] 第 ${round} 次识别失败：${ocr.error}`);
    } else {
      const state = parseBattleState(ocr.lines);
      const missing = missingFields(state);
      console.log(
        `[watch ${round}] ${state.result ?? '对局中'}｜费用 ${state.cost ?? '?'}｜生命 ${state.life ?? '?'}`
          + `｜敌人 ${state.enemies ?? '?'}｜手牌 ${state.handCosts.length || '?'} 张`
          + (missing.length > 0 ? `｜没读到 ${missing.join('、')}` : ''),
      );
      if (state.result) {
        console.log(`[watch] 已结算：${state.result === 'victory' ? '胜利' : '失败'}`);
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** `--auto` 的默认地块清单：常见关卡中前段的几处，按顺序试，落不了位就换下一个。 */
const AUTO_TILES: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0.4, y: 0.55 },
  { x: 0.5, y: 0.55 },
  { x: 0.6, y: 0.55 },
  { x: 0.35, y: 0.65 },
  { x: 0.45, y: 0.65 },
  { x: 0.55, y: 0.65 },
  { x: 0.65, y: 0.65 },
  { x: 0.45, y: 0.45 },
  { x: 0.55, y: 0.45 },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type AutoRead =
  | { readonly ok: true; readonly state: ReturnType<typeof parseBattleState> }
  | { readonly ok: false; readonly error: string };

async function readState(session: ArknightsSession, cfg: ArknightsConfigSection): Promise<AutoRead> {
  const shot = await session.screencap();
  if (!shot.ok) return { ok: false, error: shot.error };
  const ocr = await session.recognizeFrame(shot.png, cfg.resourceDir);
  if (!ocr.ok) return { ok: false, error: ocr.error };
  return { ok: true, state: parseBattleState(ocr.lines) };
}

export interface AutoOptions {
  /** 最多读多少次状态（每次状态算一步）。 */
  readonly maxSteps: number;
  /** 每步最多试几个地块：一次没落位就换下一个，避免一张卡反复拖同一处。 */
  readonly attempts: number;
  /** 整体时间上限（毫秒），到点就收工。 */
  readonly maxMs: number;
  readonly timing: { holdMs: number; gapMs: number; directionMs: number };
}

/**
 * 一次性战斗测试：固定策略，不调任何模型。
 *
 * 策略很朴素——费用够就下最左边那张，往候选地块轮流试，靠「费用有没有掉」判断落位；
 * 每步最多试 attempts 个地块，认到结算、步数或时间到上限就收工，最后打印一行汇总。
 * 用途是验收整条链路（读状态 → 部署 → 再读 → 结算），不追求通关质量。
 */
async function runAuto(
  session: ArknightsSession,
  cfg: ArknightsConfigSection,
  tiles: ReadonlyArray<{ x: number; y: number }>,
  opts: AutoOptions,
): Promise<void> {
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  let steps = 0;
  let landed = 0;
  let missed = 0;
  let tileCursor = 0;
  let result: 'victory' | 'defeat' | null = null;

  const finish = (reason: string): void => {
    const outcome = result === null ? '未结算' : result === 'victory' ? '胜利' : '失败';
    console.log(
      `[auto] 结束：${outcome}｜用时 ${elapsed()}｜步数 ${steps}｜落位 ${landed}｜失败尝试 ${missed}（${reason}）`,
    );
  };

  console.log(
    `[auto] 一次性战斗测试：最多 ${opts.maxSteps} 步 / ${Math.round(opts.maxMs / 1000)}s，`
      + `每步最多试 ${opts.attempts} 个地块；`
      + `按住 ${opts.timing.holdMs}ms / 间隔 ${opts.timing.gapMs}ms / 定向 ${opts.timing.directionMs}ms。`,
  );

  for (let step = 1; step <= opts.maxSteps; step += 1) {
    if (Date.now() - started > opts.maxMs) {
      finish('到达时间上限');
      return;
    }
    const read = await readState(session, cfg);
    if (!read.ok) {
      console.log(`[auto ${step}] 读状态失败：${read.error}`);
      finish('读状态失败');
      return;
    }
    const { state } = read;
    steps = step;
    console.log(
      `[auto ${step}] ${state.result ?? '对局中'}｜费用 ${state.cost ?? '?'}｜生命 ${state.life ?? '?'}`
        + `｜敌人 ${state.enemies ?? '?'}｜手牌 ${state.handCosts.length || '?'} 张｜${elapsed()}`,
    );
    if (state.result) {
      result = state.result;
      finish('已结算');
      return;
    }

    const size = session.resolution;
    if (!size) {
      await sleep(1000);
      continue;
    }

    if (state.paused === true) {
      const point = pausePoint(cfg.pauseButton, size);
      console.log(`[auto] 画面在暂停，点 (${point.x}, ${point.y}) 继续`);
      await session.click(point.x, point.y);
      await sleep(900);
      continue;
    }

    const affordable = state.cost === null ? [] : state.handCosts.filter((card) => card.cost <= state.cost!);
    if (affordable.length === 0) {
      console.log(`[auto] 费用 ${state.cost ?? '?'} 不够下任何一张，等 3 秒`);
      await sleep(3000);
      continue;
    }

    const card = affordable[0]!;
    let placed = false;
    for (let attempt = 1; attempt <= opts.attempts && !placed; attempt += 1) {
      const tile = tiles[tileCursor++ % tiles.length]!;
      const planned = planDeploy({ x: Math.min(0.98, card.x + 0.02), y: 0.9 }, tile, 'right', size, opts.timing);
      if (!planned.ok) {
        console.log(`[auto] 计划被拒：${planned.error}`);
        break;
      }
      const { plan } = planned;
      console.log(
        `[auto] 下 ${card.cost} 费卡（尝试 ${attempt}/${opts.attempts}）：`
          + `(${plan.card.x}, ${plan.card.y}) → (${plan.tile.x}, ${plan.tile.y}) → (${plan.release.x}, ${plan.release.y})`,
      );
      const picked = await session.swipe(plan.card.x, plan.card.y, plan.tile.x, plan.tile.y, plan.holdMs);
      if (!picked.ok) {
        console.log(`[auto] 手牌 → 地块没发出去：${picked.error}`);
        finish('拖拽被拒绝');
        return;
      }
      if (plan.gapMs > 0) await sleep(plan.gapMs);
      const aimed = await session.swipe(plan.tile.x, plan.tile.y, plan.release.x, plan.release.y, plan.directionMs);
      if (!aimed.ok) {
        console.log(`[auto] 定向拖拽没发出去：${aimed.error}`);
        finish('拖拽被拒绝');
        return;
      }

      await sleep(1200);
      const after = await readState(session, cfg);
      if (!after.ok) {
        missed += 1;
        console.log(`[auto] 落位核对失败：${after.error}`);
        continue;
      }
      if (after.state.result) {
        result = after.state.result;
        finish('已结算');
        return;
      }
      const before = state.cost;
      const now = after.state.cost;
      if (before !== null && now !== null && now < before - 3) {
        landed += 1;
        placed = true;
        console.log(`[auto] 落位成功（费用 ${before} → ${now}）`);
      } else {
        missed += 1;
        console.log(`[auto] 这次没落位（费用 ${before ?? '?'} → ${now ?? '?'}），换地块再试`);
      }
    }
    if (!placed) await sleep(1500);
  }

  finish(`到达步数上限 ${opts.maxSteps}`);
}

/**
 * pipeline 冒烟：打印入口、轨迹、最终画面、OCR 与（选关时）理智。
 * 返回「pipeline 成功且终点画面命中」；只在真机由用户执行。
 */
async function runNav(
  session: ArknightsSession,
  cfg: ArknightsConfigSection,
  entry: string,
  overrides: Record<string, unknown>,
  label: string,
  expect: RegExp,
  wantSanity: boolean,
  save: (name: string, png: Uint8Array) => string,
): Promise<boolean> {
  const started = Date.now();
  const result = await session.runPipeline(entry, overrides, cfg.resourceDir);
  console.log(`[nav] ${label}：入口 ${entry}`);
  console.log(`[nav] ${result.ok ? '成功' : '失败'}（${Date.now() - started}ms）${result.error ? `：${result.error}` : ''}`);
  console.log(`[nav] 轨迹：${describeTrace(result.trace)}`);

  const shot = await session.screencap();
  if (!shot.ok) {
    console.error(`[nav] 补拍失败：${shot.error}`);
    return false;
  }
  console.log(`[nav] 截图：${save('nav-after', shot.png)}`);

  const ocr = await session.recognizeFrame(shot.png, cfg.resourceDir);
  if (!ocr.ok) {
    console.log(`[nav] 识别失败：${ocr.error}`);
    return result.ok;
  }
  const lines = [...ocr.lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  console.log(`[nav] 识别到 ${lines.length} 行：`);
  for (const line of lines.slice(0, 20)) {
    console.log(`  「${line.text}」 中心 ${line.box.x.toFixed(3)},${line.box.y.toFixed(3)}`);
  }
  const hit = lines.some((line) => expect.test(line.text));
  console.log(`[nav] 终点校验 ${expect}：${hit ? '命中' : '没命中'}；可对照 nav-after.png 判断。`);
  if (wantSanity) console.log(`[nav] 理智：${describeSanity(parseSanity(lines))}`);
  return result.ok && hit;
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
  const ocrAllArg = take('ocr-all');
  const clickAtArg = take('click-at');
  const swipeArg = take('swipe');
  const watchArg = take('watch');
  const autoArg = take('auto');
  const autoTilesArg = take('auto-tiles');
  const autoMaxArg = take('auto-max');
  const autoAttemptsArg = take('auto-attempts');
  const autoTimeArg = take('auto-time');
  const holdArg = take('hold');
  const gapArg = take('gap');
  const dirArg = take('dir');
  const pingArg = take('ping');
  const enterArg = take('enter');
  const roguelikeArg = take('roguelike');

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

  /** 命令行优先，其次配置；都缺就落到默认值。 */
  const msOf = (raw: unknown, fallback: number): number =>
    typeof raw === 'string' && Number.isFinite(Number(raw)) ? Number(raw) : fallback;
  const timing = {
    holdMs: msOf(holdArg, cfg.deployHoldMs),
    gapMs: msOf(gapArg, cfg.deployGapMs),
    directionMs: msOf(dirArg, cfg.deployDirectionMs),
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

  if (pingArg !== undefined) {
    const result = await session.runPipeline('NavCommon@Ping', {}, cfg.resourceDir);
    console.log(`[ping] ${result.ok ? '成功' : '失败'}${result.error ? `：${result.error}` : ''}`);
    console.log(`[ping] 轨迹：${describeTrace(result.trace)}`);
    process.exitCode = result.ok ? 0 : 1;
    await session.stop();
    return;
  }

  if (enterArg !== undefined) {
    if (typeof enterArg !== 'string') {
      console.error('--enter 需要关卡代号，例如 --enter CE-5');
      process.exitCode = 2;
      await session.stop();
      return;
    }
    const planned = routeFor(enterArg, { maxScrolls: cfg.navMaxScrolls });
    if (!planned.ok) {
      console.error(`[enter] ${planned.error}`);
      process.exitCode = 2;
      await session.stop();
      return;
    }
    const ok = await runNav(
      session, cfg, planned.route.entry, planned.route.overrides, planned.route.label,
      /开始行动|代理指挥/, true, save,
    );
    if (!ok) process.exitCode = 1;
    await session.stop();
    return;
  }

  if (roguelikeArg !== undefined) {
    if (typeof roguelikeArg !== 'string') {
      console.error('--roguelike 需要主题关键词，例如 --roguelike 傀影');
      process.exitCode = 2;
      await session.stop();
      return;
    }
    const planned = roguelikeRoute(roguelikeArg, { maxScrolls: cfg.navMaxScrolls });
    if (!planned.ok) {
      console.error(`[roguelike] ${planned.error}`);
      process.exitCode = 2;
      await session.stop();
      return;
    }
    const ok = await runNav(
      session, cfg, planned.route.entry, planned.route.overrides, planned.route.label,
      /开始探索|深入调查/, false, save,
    );
    if (!ok) process.exitCode = 1;
    await session.stop();
    return;
  }

  if (watchArg !== undefined) {
    const watchMs = typeof watchArg === 'string' ? Number(watchArg) : Number.NaN;
    const interval = Number.isFinite(watchMs) && watchMs >= 500 ? Math.min(watchMs, 30_000) : 3000;
    await runWatch(session, cfg, interval);
    await session.stop();
    return;
  }

  if (autoArg !== undefined) {
    let tiles: ReadonlyArray<{ x: number; y: number }>;
    try {
      tiles = typeof autoTilesArg === 'string' ? parseTiles(autoTilesArg) : AUTO_TILES;
    } catch (error) {
      if (!(error instanceof ArgError)) throw error;
      console.error(error.message);
      console.error('参数写错时不会发送任何点击。');
      process.exitCode = 2;
      await session.stop();
      return;
    }
    const intOf = (raw: unknown, fallback: number, min: number, max: number): number => {
      const value = typeof raw === 'string' ? Number(raw) : Number.NaN;
      return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
    };
    const maxSteps = intOf(autoMaxArg, 30, 1, 80);
    const attempts = intOf(autoAttemptsArg, 3, 1, 9);
    const maxSeconds = intOf(autoTimeArg, 600, 30, 3600);
    await runAuto(session, cfg, tiles, { maxSteps, attempts, maxMs: maxSeconds * 1000, timing });
    await session.stop();
    return;
  }

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

  const wantsAction = deployArg !== undefined || clickAtArg !== undefined || swipeArg !== undefined || ocrAllArg !== undefined;
  if (!wantsClick && !wantsOcr && !wantsAction) {
    console.log('未发送点击。要试点击：pnpm smoke --click；要读战场：pnpm smoke --state；'
      + '要看全屏文字：pnpm smoke --ocr-all');
    await session.stop();
    return;
  }

  if (ocrAllArg !== undefined) {
    const ocr = await session.recognizeFrame(before.png, cfg.resourceDir);
    if (!ocr.ok) {
      console.log(`[ocr-all] 识别失败：${ocr.error}`);
    } else {
      const lines = [...ocr.lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
      console.log(`[ocr-all] 共 ${lines.length} 行（归一化 x,y,w,h　像素 x,y,w,h）：`);
      for (const line of lines) {
        const { x, y, w, h } = line.box;
        const px = `${Math.round(x * frameSize[0])},${Math.round(y * frameSize[1])},`
          + `${Math.round(w * frameSize[0])},${Math.round(h * frameSize[1])}`;
        console.log(`  「${line.text}」 ${x.toFixed(3)},${y.toFixed(3)} ${w.toFixed(3)},${h.toFixed(3)}　像素 ${px}`);
      }
    }
  }

  if (typeof clickAtArg === 'string') {
    const [x, y] = clickAtArg.split(',').map((part) => Number(part.trim()));
    const planned = planClick({ x, y }, frameSize);
    if (!planned.ok) {
      console.error(planned.error);
      process.exitCode = 2;
    } else {
      const { at } = planned.plan;
      console.log(`[click-at] 目标 (${at.x}, ${at.y})　归一化 ${String(x)},${String(y)}（画面 ${frameSize[0]}×${frameSize[1]}）`);
      const clicked = await session.click(at.x, at.y);
      console.log(clicked.ok ? '控制器回执：点击已发送' : clicked.error);
      if (!clicked.ok) process.exitCode = 1;
    }
  }

  if (typeof swipeArg === 'string') {
    const parts = swipeArg.split(',').map((part) => Number(part.trim()));
    const [x1, y1, x2, y2, ms] = parts;
    const planned = planSwipe({ x: x1, y: y1 }, { x: x2, y: y2 }, parts.length > 4 ? ms : undefined, frameSize);
    if (!planned.ok) {
      console.error(planned.error);
      process.exitCode = 2;
    } else {
      const { from, to, durationMs } = planned.plan;
      console.log(`[swipe] (${from.x}, ${from.y}) → (${to.x}, ${to.y})，${durationMs}ms`);
      const dragged = await session.swipe(from.x, from.y, to.x, to.y, durationMs);
      console.log(dragged.ok ? '控制器回执：拖拽已发送' : dragged.error);
      if (!dragged.ok) process.exitCode = 1;
    }
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
    const planned = planDeploy({ x: cx, y: cy }, { x: tx, y: ty }, direction, frameSize, timing);
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
    console.log(
      `  时序：按住 ${plan.holdMs}ms，间隔 ${plan.gapMs}ms，定向 ${plan.directionMs}ms`
        + '（--hold / --gap / --dir 可临时覆盖，配置里是 deployHoldMs / deployGapMs / deployDirectionMs）',
    );
    console.log(`  拖拽 1/2：(${plan.card.x}, ${plan.card.y}) → (${plan.tile.x}, ${plan.tile.y})，${plan.holdMs}ms`);
    const picked = await session.swipe(plan.card.x, plan.card.y, plan.tile.x, plan.tile.y, plan.holdMs);
    console.log(picked.ok ? '控制器回执：拖拽 1 已发送' : picked.error);
    if (!picked.ok) process.exitCode = 1;

    if (picked.ok) {
      if (plan.gapMs > 0) await sleep(plan.gapMs);
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
