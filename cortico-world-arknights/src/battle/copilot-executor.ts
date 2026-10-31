/**
 * Copilot 统一执行调度器（Facade）：
 * 统一调度 MaaCore 原生全权托管引擎与本地轻量解释器，负责模式判断、自动降级与结果聚合。
 */
import type { ArknightsConfigSection, CopilotEngine } from '../config.ts';
import type { MaaResourceLike, MaaTaskerLike } from '../mfw/native.ts';
import type { ArknightsSession } from '../mfw/session.ts';
import type { CopilotPlan } from './copilot.ts';
import { resolveActionTile, resolveHandCardPosition } from './copilot.ts';
import { isMaaCoreBattleSupported, runMaaCoreCopilot } from './copilot-maacore.ts';
import { planDeploy } from './deploy.ts';
import { parseBattleState } from './state.ts';
import { getStageDimension, loadStageMapInfo } from './tile-pos.ts';
import { OperatorDatabase } from './operator-db.ts';

export interface CopilotExecutionResult {
  readonly ok: boolean;
  readonly engine: 'maacore' | 'builtin';
  readonly resultText: string;
  readonly logs: string[];
  readonly durationMs: number;
  readonly finalShot?: Uint8Array | null;
}

export interface ExecuteCopilotContext {
  readonly plan: CopilotPlan;
  readonly cfg: ArknightsConfigSection;
  readonly session: ArknightsSession;
  readonly tasker?: MaaTaskerLike | null;
  readonly resource?: MaaResourceLike | null;
  readonly maxSeconds?: number;
  readonly info?: (line: string) => void;
}

/**
 * 战前高低台地块防呆校验：
 * 对比干员的站位属性（地面/高台）与关卡静态地图（M/R），拦截非法部署
 */
export function validatePlanTiles(plan: CopilotPlan, resourceDir?: string): { ok: boolean; reason?: string } {
  if (!plan.stage_name) return { ok: true };
  const mapInfo = loadStageMapInfo(plan.stage_name, resourceDir);
  if (!mapInfo) return { ok: true }; // 静态地图不可用时不强制阻断

  const db = OperatorDatabase.getInstance(resourceDir);

  for (let i = 0; i < plan.actions.length; i++) {
    const action = plan.actions[i]!;
    if (action.type !== 'Deploy' || !action.name || !Array.isArray(action.location)) continue;
    const [col, row] = action.location;
    if (row < 0 || row >= mapInfo.height || col < 0 || col >= mapInfo.width) {
      return {
        ok: false,
        reason: `【部署前置校验拦截】动作 #${i + 1} 干员「${action.name}」目标坐标 [${col}, ${row}] 超出关卡网格范围（地图尺寸：${mapInfo.width}列 × ${mapInfo.height}行）。`,
      };
    }

    const tile = mapInfo.tiles[row]?.[col];
    if (!tile) continue;

    const op = db.getOperator(action.name);
    if (!op) continue;

    if (tile.buildableType === 0) {
      return {
        ok: false,
        reason: `【部署前置校验拦截】动作 #${i + 1} 干员「${action.name}」目标坐标 [${col}, ${row}] 为障碍禁区（不可部署）！`,
      };
    }

    // 高台干员落在地面格
    if (op.position === 'RANGED' && tile.buildableType === 1) {
      const suggested = mapInfo.rangedTiles.slice(0, 8).map(([c, r]) => `[${c},${r}]`).join(', ');
      return {
        ok: false,
        reason: `【部署前置校验拦截】干员「${action.name}」为高台${op.profession}，目标地块 [${col}, ${row}] 为地面道路（仅限先锋/近卫/重装），无法部署！可用高台候选格为: ${suggested}...`,
      };
    }

    // 地面干员落在高台格
    if (op.position === 'MELEE' && tile.buildableType === 2) {
      const suggested = mapInfo.meleeTiles.slice(0, 8).map(([c, r]) => `[${c},${r}]`).join(', ');
      return {
        ok: false,
        reason: `【部署前置校验拦截】干员「${action.name}」为地面${op.profession}，目标地块 [${col}, ${row}] 为高台，无法部署！可用地面候选格为: ${suggested}...`,
      };
    }
  }

  return { ok: true };
}

/**
 * 战后结算画面真伪胜负仲裁：
 * 基于截图 OCR 识别理智返还与失败关键词，杜绝任务链完成误报为胜利
 */
export async function evaluateBattleOutcome(
  shotPng: Uint8Array,
  resourceDir?: string,
  session?: ArknightsSession,
): Promise<{ isVictory: boolean; reason: string }> {
  if (!session) return { isVictory: true, reason: '作战胜利（已完成行动）' };
  const ocr = await session.recognizeFrame(shotPng, resourceDir || '');
  if (!ocr.ok) return { isVictory: true, reason: '作战胜利（已完成行动）' };

  const hasDefeatKeyword = ocr.lines.some((l) =>
    /理智返还|MISSION\s*FAILED|作战失败|放弃行动/i.test(l.text)
  );
  const hasReturnedSanity = ocr.lines.some((l) =>
    /理智.*返还|\+\s*\d+.*理智/i.test(l.text)
  );
  const bs = parseBattleState(ocr.lines);

  if (hasDefeatKeyword || hasReturnedSanity || bs.result === 'defeat') {
    return {
      isVictory: false,
      reason: '作战失败（检测到结算画面显示理智返还或失败标志）',
    };
  }
  return {
    isVictory: true,
    reason: '作战胜利（行动结束）',
  };
}

/**
 * 统一执行入口
 */
export async function executeCopilotPlan(ctx: ExecuteCopilotContext): Promise<CopilotExecutionResult> {
  const { plan, cfg, session, maxSeconds = 180, info } = ctx;
  const engine: CopilotEngine = cfg.copilotEngine || 'auto';
  const maaDirCandidate = cfg.maaResourceDir || cfg.resourceDir;
  const maaSupported = isMaaCoreBattleSupported(maaDirCandidate);
  const fallbackLogs: string[] = [];

  // 1. 战前地块与干员高低台合法性前置防呆校验
  const validation = validatePlanTiles(plan, maaDirCandidate || cfg.resourceDir);
  if (!validation.ok) {
    return {
      ok: false,
      engine: engine === 'builtin' ? 'builtin' : 'maacore',
      resultText: validation.reason!,
      logs: [validation.reason!],
      durationMs: 0,
    };
  }

  if (engine === 'maacore') {
    if (!maaSupported) {
      return {
        ok: false,
        engine: 'maacore',
        resultText: '配置为强制 MaaCore 模式，但未检测到有效 MAA 安装目录。',
        logs: [
          '【错误】已配置强制使用 MaaCore 原生全托管，但未检测到可用的 MaaCore.dll。',
          '请在配置项 worlds.arknights.maaResourceDir 中指定（如 D:/soft/MAA-v6），或将 copilotEngine 调整为 auto。',
        ],
        durationMs: 0,
      };
    }
    const maaOutcome = await runMaaCoreCopilot({
      plan,
      hwnd: session.window?.handle,
      maaResourceDir: maaDirCandidate,
      maxSeconds,
      info,
    });
    const shot = await session.screencap();
    let finalOk = maaOutcome.ok;
    let finalResultText = maaOutcome.resultText;
    if (maaOutcome.ok && shot.ok) {
      const evaluation = await evaluateBattleOutcome(shot.png, maaDirCandidate, session);
      finalOk = evaluation.isVictory;
      finalResultText = evaluation.reason;
      if (!evaluation.isVictory) {
        maaOutcome.logs.push(`【战后图像仲裁】结算画面识别到失败标志或理智返还，最终战果裁定为：作战失败。`);
      }
    }
    return {
      ok: finalOk,
      engine: 'maacore',
      resultText: finalResultText,
      logs: maaOutcome.logs,
      durationMs: maaOutcome.durationMs,
      finalShot: shot.ok ? shot.png : null,
    };
  }

  if (engine === 'auto' && maaSupported) {
    // 画面感知：判断当前是否已经在战斗进行中
    let isAlreadyInBattle = false;
    if (session.connected) {
      try {
        const shot = await session.screencap();
        if (shot.ok) {
          const ocr = await session.recognizeFrame(shot.png, cfg.resourceDir);
          if (ocr.ok) {
            const isFormation = ocr.lines.some((l) => /编队|代理指挥|开始行动/i.test(l.text))
              || (ocr.lines.some((l) => /开始/i.test(l.text)) && ocr.lines.some((l) => /行动/i.test(l.text)));
            const hasBattleKeywords = ocr.lines.some((l) => /可部署|剩余可部署|剩余敌人|行动结束/i.test(l.text));
            const hasCostKeyword = ocr.lines.some((l) => /COST|费用/i.test(l.text));
            const bs = parseBattleState(ocr.lines);
            // 只要不是编队界面，且同时满足战场特征词、或结算结果、或明确的 COST 标识时，判定已处于战斗状态
            if (!isFormation && (hasBattleKeywords || bs.result !== null || (bs.cost !== null && hasCostKeyword))) {
              isAlreadyInBattle = true;
            }
          }
        }
      } catch {
        // 忽略感知异常，回退正常调度
      }
    }

    if (isAlreadyInBattle) {
      return {
        ok: false,
        engine: 'builtin',
        resultText: '拒绝执行：战斗已在进行中，严禁在战斗中途提交新的 Copilot 作业。所有部署计划必须在编队界面一次性规划完成。',
        logs: [
          '【安全拦截】检测到当前游戏画面已处于战场内（已有费用/战斗信息）。',
          '明日方舟实战部署讲求一气呵成，所有部署计划必须在编队界面规划完毕后统一托管；严禁在战斗中途追加或重复提交 Copilot JSON，请等待当前战斗结算完毕。',
        ],
        durationMs: 0,
      };
    }

    const maaOutcome = await runMaaCoreCopilot({
      plan,
      hwnd: session.window?.handle,
      maaResourceDir: maaDirCandidate,
      maxSeconds,
      info,
    });

      if (maaOutcome.ok) {
        const shot = await session.screencap();
        let finalOk = true;
        let finalResultText = maaOutcome.resultText;
        if (shot.ok) {
          const evaluation = await evaluateBattleOutcome(shot.png, maaDirCandidate || cfg.resourceDir, session);
          finalOk = evaluation.isVictory;
          finalResultText = evaluation.reason;
          if (!evaluation.isVictory) {
            maaOutcome.logs.push(`【战后图像仲裁】结算画面识别到失败标志或理智返还，最终战果裁定为：作战失败。`);
          }
        }
        return {
          ok: finalOk,
          engine: 'maacore',
          resultText: finalResultText,
          logs: maaOutcome.logs,
          durationMs: maaOutcome.durationMs,
          finalShot: shot.ok ? shot.png : null,
        };
      }

      const isResolutionError = maaOutcome.resultText.includes('16:9') || maaOutcome.logs.some((l) => l.includes('16:9') || l.includes('UnsupportedResolution'));
      const detailHint = isResolutionError
        ? `（窗口非 16:9 标准比例，建议调整窗口为 1920x1080、1280x720 或 2560x1440）`
        : `（${maaOutcome.resultText}）`;
      fallbackLogs.push(`【执行引擎：本地轻量解释器（自动降级）】原生 MaaCore 执行异常${detailHint}，已无缝切换至内置轻量引擎继续部署。`);
      if (maaOutcome.logs.length > 0) {
        fallbackLogs.push('  【MaaCore 诊断信息】:');
        for (const logLine of maaOutcome.logs.slice(-5)) {
          fallbackLogs.push(`    - ${logLine}`);
        }
      }

      // 状态守卫：检查当前画面是否仍停留在编队界面（防止在编队页盲目执行下人部署）
      if (session.connected) {
        try {
          const postShot = await session.screencap();
          if (postShot.ok) {
            const ocr = await session.recognizeFrame(postShot.png, cfg.resourceDir);
            if (ocr.ok) {
              const formationLine = ocr.lines.find((l) => /开始行动|代理指挥/.test(l.text));
              const hasBattleKeywords = ocr.lines.some((l) => /可部署|剩余可部署|剩余敌人|行动结束/i.test(l.text));
              const bs = parseBattleState(ocr.lines);
              // 如果仍处于编队界面（非战斗界面且无费用）
              if (formationLine && !hasBattleKeywords && bs.cost === null) {
                fallbackLogs.push('【状态守卫】检测到当前画面仍停留在编队界面（MaaCore 未能成功触发进战），尝试执行可靠点击「开始行动」...');
                const btnX = formationLine.box ? formationLine.box.x + formationLine.box.w / 2 : 0.86;
                const btnY = formationLine.box ? formationLine.box.y + formationLine.box.h / 2 : 0.70;
                await session.click(btnX, btnY, { double: true });
                await new Promise((r) => setTimeout(r, 3000));

                // 再次确认是否成功进入战场
                let enteredBattle = false;
                const checkShot = await session.screencap();
                if (checkShot.ok) {
                  const checkOcr = await session.recognizeFrame(checkShot.png, cfg.resourceDir);
                  if (checkOcr.ok) {
                    const stillFormation = checkOcr.lines.some((l) => /开始行动|代理指挥/.test(l.text));
                    const checkBattle = checkOcr.lines.some((l) => /可部署|剩余可部署|剩余敌人|行动结束/i.test(l.text));
                    const checkBs = parseBattleState(checkOcr.lines);
                    if (!stillFormation || checkBattle || checkBs.cost !== null) {
                      enteredBattle = true;
                    }
                  }
                }

                if (!enteredBattle) {
                  fallbackLogs.push('【安全中止】检测到仍未成功进入战场。为防止在编队界面误触卡槽，内置轻量引擎已安全终止。');
                  const finalShot = await session.screencap();
                  return {
                    ok: false,
                    engine: 'builtin',
                    resultText: '未能进入战场（仍停留在编队界面）',
                    logs: fallbackLogs,
                    durationMs: maaOutcome.durationMs + 3000,
                    finalShot: finalShot.ok ? finalShot.png : null,
                  };
                }
                fallbackLogs.push('【状态守卫】已成功触发进战，内置轻量引擎接管战场部署。');
              }
            }
          }
        } catch {
          // 忽略感知异常，按常规流程走
        }
      }
  }

  // 降级或指定走本地轻量解释器
  if (engine === 'auto' && fallbackLogs.length === 0) {
    fallbackLogs.push('【执行引擎：本地轻量解释器（自动降级）】未检测到外部 MAA 完整战斗资源包，已使用内置轻量引擎执行。');
  } else if (engine === 'builtin') {
    fallbackLogs.push('【执行引擎：本地轻量解释器】按配置指定使用内置轻量引擎执行。');
  }

  const builtinOutcome = await runBuiltinCopilot({
    plan,
    session,
    cfg,
    maxSeconds,
  });

  return {
    ok: builtinOutcome.ok,
    engine: 'builtin',
    resultText: builtinOutcome.resultText,
    logs: [...fallbackLogs, ...builtinOutcome.logs],
    durationMs: builtinOutcome.durationMs,
    finalShot: builtinOutcome.finalShot,
  };
}

interface BuiltinCopilotOptions {
  readonly plan: CopilotPlan;
  readonly session: ArknightsSession;
  readonly cfg: ArknightsConfigSection;
  readonly maxSeconds: number;
}

/**
 * 本地轻量循环解释器（OCR 轮询费用 + 动态卡槽拖拽）
 */
export async function runBuiltinCopilot(options: BuiltinCopilotOptions): Promise<{
  readonly ok: boolean;
  readonly resultText: string;
  readonly logs: string[];
  readonly durationMs: number;
  readonly finalShot: Uint8Array | null;
}> {
  const { plan, session, cfg, maxSeconds } = options;
  const size = session.resolution || [1280, 720];
  const dimension = getStageDimension(plan.stage_name, cfg.resourceDir);
  const logs: string[] = [];
  const startTime = Date.now();

  logs.push(`开始执行关卡【${plan.stage_name}】Copilot 作业，共 ${plan.actions.length} 步动作。`);

  let finalShot: Uint8Array | null = null;
  let battleFinished = false;
  let battleResultText = '战斗仍在进行或已超时';
  let deployedCount = 0;

  for (let i = 0; i < plan.actions.length; i++) {
    if (Date.now() - startTime > maxSeconds * 1000) {
      logs.push(`达到最大超时限制（${maxSeconds}秒），停止后续动作。`);
      break;
    }

    const act = plan.actions[i]!;
    const actType = act.type;
    let lastBattleState: ReturnType<typeof parseBattleState> | null = null;

    // 检查战斗是否提前结束
    const shot = await session.screencap();
    if (shot.ok) {
      finalShot = shot.png;
      const ocr = await session.recognizeFrame(shot.png, cfg.resourceDir);
      if (ocr.ok) {
        const state = parseBattleState(ocr.lines);
        lastBattleState = state;
        if (state.result === 'victory') {
          logs.push('检测到【作战胜利】（行动结束）！');
          battleFinished = true;
          battleResultText = '作战胜利（行动结束）';
          break;
        }
        if (state.result === 'defeat') {
          logs.push('检测到【作战失败】！');
          battleFinished = true;
          battleResultText = '作战失败或已退出（理智返还）';
          break;
        }
      }
    }

    // 等待费用满足
    if (typeof act.costs === 'number' && act.costs > 0) {
      let waitCount = 0;
      while (waitCount < 20) {
        const s = await session.screencap();
        if (s.ok) {
          finalShot = s.png;
          const ocr = await session.recognizeFrame(s.png, cfg.resourceDir);
          if (ocr.ok) {
            const state = parseBattleState(ocr.lines);
            lastBattleState = state;
            if (state.result) {
              battleFinished = true;
              battleResultText = state.result === 'victory' ? '作战胜利（行动结束）' : '作战失败或已退出（理智返还）';
              break;
            }
            if (state.cost !== null && state.cost >= act.costs) {
              break;
            }
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
        waitCount++;
      }
      if (battleFinished) break;
    }

    // 动作前置等待 (pre_delay)
    if (typeof act.pre_delay === 'number' && act.pre_delay > 0) {
      logs.push(`第 ${i + 1} 步（${act.type}）：前置等待 pre_delay ${act.pre_delay}ms...`);
      await new Promise((r) => setTimeout(r, act.pre_delay));
    }

    // 执行动作
    if (actType === 'SpeedUp' || actType === '二倍速') {
      const px = Math.round(0.938 * size[0]);
      const py = Math.round(0.052 * size[1]);
      await session.click(px, py);
      logs.push(`第 ${i + 1} 步：点击二倍速加速。`);
    } else if (actType === 'Deploy' || actType === '部署') {
      const tile = resolveActionTile(act, dimension);
      if (!tile) {
        logs.push(`第 ${i + 1} 步（部署 ${act.name || ''}）：缺少目标地块位置，已跳过。`);
        continue;
      }

      const cardNorm = resolveHandCardPosition(act, {
        handCosts: lastBattleState?.handCosts,
        deployedCount,
      });
      const dir = (act.direction?.toLowerCase() || 'right') as 'up' | 'down' | 'left' | 'right';
      const planned = planDeploy(cardNorm, tile, dir, size, {
        holdMs: Math.max(380, cfg.deployHoldMs),
        gapMs: cfg.deployGapMs,
        directionMs: cfg.deployDirectionMs,
      });

      if (planned.ok) {
        const { plan: dp } = planned;
        await session.swipe(dp.card.x, dp.card.y, dp.tile.x, dp.tile.y, dp.holdMs);
        if (dp.gapMs > 0) await new Promise((r) => setTimeout(r, dp.gapMs));
        await session.swipe(dp.tile.x, dp.tile.y, dp.release.x, dp.release.y, dp.directionMs);

        // 落位校验与自适应补偿重试机制（解决拖拽落空问题）
        const beforeCost = lastBattleState?.cost;
        if (typeof act.costs === 'number' && act.costs > 0 && typeof beforeCost === 'number') {
          await new Promise((r) => setTimeout(r, 350));
          const verifyShot = await session.screencap();
          if (verifyShot.ok) {
            finalShot = verifyShot.png;
            const verifyOcr = await session.recognizeFrame(verifyShot.png, cfg.resourceDir);
            if (verifyOcr.ok) {
              const verifyState = parseBattleState(verifyOcr.lines);
              // 若费用未扣除，说明干员未成功被提起或放下，执行微调补偿重试
              if (verifyState.cost !== null && verifyState.cost >= beforeCost && !verifyState.result) {
                logs.push(`  * 第 ${i + 1} 步初次拖拽未落位（费用未变化），正在执行微调补偿重试...`);
                const retryCardNorm = { x: Math.min(0.92, cardNorm.x + 0.02), y: cardNorm.y };
                const retryPlanned = planDeploy(retryCardNorm, tile, dir, size, {
                  holdMs: Math.max(450, cfg.deployHoldMs + 120),
                  gapMs: Math.max(100, cfg.deployGapMs),
                  directionMs: cfg.deployDirectionMs,
                });
                if (retryPlanned.ok) {
                  const { plan: rdp } = retryPlanned;
                  await session.swipe(rdp.card.x, rdp.card.y, rdp.tile.x, rdp.tile.y, rdp.holdMs);
                  if (rdp.gapMs > 0) await new Promise((r) => setTimeout(r, rdp.gapMs));
                  await session.swipe(rdp.tile.x, rdp.tile.y, rdp.release.x, rdp.release.y, rdp.directionMs);
                }
              }
            }
          }
        }

        deployedCount++;
        logs.push(`第 ${i + 1} 步：部署【${act.name || '干员'}】（卡槽 x≈${cardNorm.x.toFixed(2)}）到地块 (${tile.x}, ${tile.y}) 朝向 ${dir}。`);
      } else {
        logs.push(`第 ${i + 1} 步：部署规划失败（${planned.error}）。`);
      }
    } else if (actType === 'Skill' || actType === '技能') {
      const tile = resolveActionTile(act, dimension);
      if (tile) {
        const px = Math.round(tile.x * size[0]);
        const py = Math.round(tile.y * size[1]);
        await session.click(px, py);
        await new Promise((r) => setTimeout(r, 200));
        logs.push(`第 ${i + 1} 步：点击地块 (${tile.x}, ${tile.y}) 释放技能。`);
      }
    }

    // 动作后置等待 (rear_delay / delay)
    const postDelay = act.rear_delay ?? act.delay;
    if (typeof postDelay === 'number' && postDelay > 0) {
      logs.push(`第 ${i + 1} 步（${act.type}）：后置等待 ${postDelay}ms...`);
      await new Promise((r) => setTimeout(r, postDelay));
    }
  }

  // 动作全部执行完成后，额外等待 3 秒捕获最终结果
  if (!battleFinished) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await session.screencap();
    if (s.ok) {
      finalShot = s.png;
      const ocr = await session.recognizeFrame(s.png, cfg.resourceDir);
      if (ocr.ok) {
        const state = parseBattleState(ocr.lines);
        if (state.result === 'victory') {
          battleFinished = true;
          battleResultText = '作战胜利（行动结束）';
        } else if (state.result === 'defeat') {
          battleFinished = true;
          battleResultText = '作战失败或已退出（理智返还）';
        }
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const ok = battleResultText.includes('胜利');

  return {
    ok,
    resultText: battleResultText,
    logs,
    durationMs,
    finalShot,
  };
}
