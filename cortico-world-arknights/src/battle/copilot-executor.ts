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
import { getStageDimension } from './tile-pos.ts';

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
  readonly tasker: MaaTaskerLike | null;
  readonly resource: MaaResourceLike | null;
  readonly maxSeconds?: number;
  readonly info?: (line: string) => void;
}

/**
 * 统一执行入口
 */
export async function executeCopilotPlan(ctx: ExecuteCopilotContext): Promise<CopilotExecutionResult> {
  const { plan, cfg, session, tasker, resource, maxSeconds = 180, info } = ctx;
  const engine: CopilotEngine = cfg.copilotEngine || 'auto';
  const maaSupported = isMaaCoreBattleSupported(tasker, resource, cfg.maaResourceDir);

  if (engine === 'maacore') {
    if (!maaSupported) {
      return {
        ok: false,
        engine: 'maacore',
        resultText: '配置为强制 MaaCore 模式，但未检测到有效 MAA 官方资源包。',
        logs: [
          '【错误】已配置强制使用 MaaCore 原生全托管，但未检测到可用的 MAA resource 目录。',
          '请在配置项 worlds.arknights.maaResourceDir 中指定（如 D:/MAA/resource），或将 copilotEngine 调整为 auto。',
        ],
        durationMs: 0,
      };
    }
    const maaOutcome = await runMaaCoreCopilot({
      plan,
      tasker: tasker!,
      resource: resource!,
      maaResourceDir: cfg.maaResourceDir,
      maxSeconds,
      info,
    });
    const shot = await session.screencap();
    return {
      ok: maaOutcome.ok,
      engine: 'maacore',
      resultText: maaOutcome.resultText,
      logs: maaOutcome.logs,
      durationMs: maaOutcome.durationMs,
      finalShot: shot.ok ? shot.png : null,
    };
  }

  if (engine === 'auto' && maaSupported) {
    const maaOutcome = await runMaaCoreCopilot({
      plan,
      tasker: tasker!,
      resource: resource!,
      maaResourceDir: cfg.maaResourceDir,
      maxSeconds,
      info,
    });
    const shot = await session.screencap();
    return {
      ok: maaOutcome.ok,
      engine: 'maacore',
      resultText: maaOutcome.resultText,
      logs: maaOutcome.logs,
      durationMs: maaOutcome.durationMs,
      finalShot: shot.ok ? shot.png : null,
    };
  }

  // 降级或指定走本地轻量解释器
  const fallbackLogs: string[] = [];
  if (engine === 'auto') {
    fallbackLogs.push('【执行引擎：本地轻量解释器（自动降级）】未检测到外部 MAA 完整战斗资源包，已使用内置轻量引擎执行。');
  } else {
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
        holdMs: cfg.deployHoldMs,
        gapMs: cfg.deployGapMs,
        directionMs: cfg.deployDirectionMs,
      });

      if (planned.ok) {
        const { plan: dp } = planned;
        await session.swipe(dp.card.x, dp.card.y, dp.tile.x, dp.tile.y, dp.holdMs);
        if (dp.gapMs > 0) await new Promise((r) => setTimeout(r, dp.gapMs));
        await session.swipe(dp.tile.x, dp.tile.y, dp.release.x, dp.release.y, dp.directionMs);
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
