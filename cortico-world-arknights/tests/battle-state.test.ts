import { describe, it, expect } from 'vitest';
import type { OcrLine } from '../src/mfw/ocr.ts';
import { regionOf } from '../src/battle/regions.ts';
import { describeBattleState, missingFields, parseBattleState } from '../src/battle/state.ts';

/** 造一行识别结果；坐标按 1280×720 帧的归一化比例给，省得每次写四个数。 */
function line(text: string, x: number, y: number, w = 0.04, h = 0.03): OcrLine {
  return { text, box: { x, y, w, h } };
}

const enemies = (text = '0/11') => line(text, 0.38, 0.02, 0.06);
const life = (text = '20') => line(text, 0.52, 0.02, 0.03);
const cost = (text = '28') => line(text, 0.94, 0.79);
const card = (text: string, x: number) => line(text, x, 0.92, 0.03);
const banner = (text = 'PAUSE') => line(text, 0.45, 0.40, 0.10, 0.06);

describe('区域归类', () => {
  it('顶部条、横幅、费用、手牌各归各位', () => {
    expect(regionOf(enemies().box)).toBe('top');
    expect(regionOf(life().box)).toBe('top');
    expect(regionOf(banner().box)).toBe('banner');
    expect(regionOf(cost().box)).toBe('cost');
    expect(regionOf(card('12', 0.05).box)).toBe('hand');
  });

  it('最右一张卡的费用算手牌，不会被当成部署费用', () => {
    expect(regionOf(card('24', 0.94).box)).toBe('hand');
  });

  it('画面中部的战斗文字不属于任何读数区', () => {
    expect(regionOf(line('行动结束', 0.4, 0.65, 0.1, 0.05).box)).toBe('unknown');
  });
});

describe('战场状态解析', () => {
  it('常规一帧：读出费用、生命、敌人与手牌费用', () => {
    const state = parseBattleState([
      enemies(),
      life(),
      cost(),
      card('12', 0.05),
      card('16', 0.22),
      card('18', 0.38),
    ]);
    expect(state.cost).toBe(28);
    expect(state.life).toBe(20);
    expect(state.enemies).toBe('0/11');
    expect(state.paused).toBeNull();
    expect(state.handCosts.map((c) => c.cost)).toEqual([12, 16, 18]);
  });

  it('手牌按横坐标排序，不依赖识别返回顺序', () => {
    const state = parseBattleState([card('18', 0.38), card('12', 0.05), card('16', 0.22)]);
    expect(state.handCosts.map((c) => c.cost)).toEqual([12, 16, 18]);
    expect(state.handCosts[0]!.x).toBeLessThan(state.handCosts[1]!.x);
  });

  it('认到暂停横幅就是 true，中文横幅同样算', () => {
    expect(parseBattleState([banner('PAUSE')]).paused).toBe(true);
    expect(parseBattleState([banner('---- 暂停中----')]).paused).toBe(true);
  });

  it('没认到横幅是「不知道」，不是「未暂停」', () => {
    expect(parseBattleState([enemies(), life()]).paused).toBeNull();
  });

  it('顶部条的 1X、关卡名等杂字不会被当数值', () => {
    const state = parseBattleState([line('1X', 0.88, 0.03, 0.05, 0.04), life(), enemies()]);
    expect(state.life).toBe(20);
    expect(state.enemies).toBe('0/11');
  });

  it('夹了单位的文字与空行一律丢弃', () => {
    const state = parseBattleState([line('12费', 0.05, 0.92, 0.03), line('  ', 0.06, 0.92, 0.03), cost('28.5')]);
    expect(state.handCosts).toEqual([]);
    expect(state.cost).toBeNull();
  });

  it('三位数被识别成「1 2 8」也能读成 128', () => {
    expect(parseBattleState([cost('1 2 8')]).cost).toBe(128);
  });

  it('空结果不编数字', () => {
    const state = parseBattleState([]);
    expect(state).toEqual({ cost: null, life: null, enemies: null, paused: null, handCosts: [] });
    expect(missingFields(state)).toEqual(['费用', '生命值', '剩余敌人', '手牌费用']);
  });

  it('缺项清单只列真的没读到的', () => {
    const state = parseBattleState([cost(), card('12', 0.05), card('16', 0.22)]);
    expect(missingFields(state)).toEqual(['生命值', '剩余敌人']);
  });
});

describe('战场状态回执', () => {
  it('有数字时逐项列出，并声明数字可能不准', () => {
    const text = describeBattleState(parseBattleState([enemies(), life(), cost(), card('12', 0.05), card('16', 0.22)]));
    expect(text).toContain('费用 28');
    expect(text).toContain('生命 20');
    expect(text).toContain('剩余敌人 0/11');
    expect(text).toContain('手牌费用从左到右 12 / 16');
    expect(text).toContain('请以附件画面为准');
  });

  it('没认到横幅时明说不代表没暂停', () => {
    const text = describeBattleState(parseBattleState([cost()]));
    expect(text).toContain('不代表游戏没有暂停');
    expect(text).not.toContain('未暂停');
  });

  it('认到横幅时只描述画面，不替模型下结论', () => {
    const text = describeBattleState(parseBattleState([banner()]));
    expect(text).toContain('暂停横幅');
    expect(text).not.toContain('已暂停');
  });

  it('认不到任何数字时如实说明，并列出缺项', () => {
    const text = describeBattleState(parseBattleState([]));
    expect(text).toContain('没有识别出任何数字');
    expect(text).toContain('没读到：费用、生命值、剩余敌人、手牌费用');
  });
});
