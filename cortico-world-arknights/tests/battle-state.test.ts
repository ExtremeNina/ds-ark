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
/** 手牌卡费：真机帧里中心 y≈0.85，所以框顶取 0.84。 */
const card = (text: string, x: number) => line(text, x, 0.84, 0.03);
const banner = (text = 'PAUSE') => line(text, 0.45, 0.40, 0.10, 0.06);

/** 直接按像素写框（默认 1280×720 的真机帧），省得手算归一化写错。 */
function px(text: string, x: number, y: number, w: number, h: number, frameW = 1280, frameH = 720): OcrLine {
  return { text, box: { x: x / frameW, y: y / frameH, w: w / frameW, h: h / frameH } };
}

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

  it('费用带与手牌带在 y≈0.82 / 0.83 处分界', () => {
    // 中心 y=0.819 → 费用；中心 y=0.831 → 手牌（手牌判定在前，双保险）。
    expect(regionOf({ x: 0.9, y: 0.804, w: 0.04, h: 0.03 })).toBe('cost');
    expect(regionOf({ x: 0.9, y: 0.816, w: 0.04, h: 0.03 })).toBe('hand');
  });

  it('手牌带上界收在卡费行，卡面下沿的数字不算手牌', () => {
    // 中心 0.865 → 手牌；中心 0.89 → 落在区间外（真机上那里只有卡面图案）。
    expect(regionOf({ x: 0.3, y: 0.85, w: 0.04, h: 0.03 })).toBe('hand');
    expect(regionOf({ x: 0.3, y: 0.875, w: 0.04, h: 0.03 })).toBe('unknown');
  });

  it('右上角的速度/暂停图标不算顶部条，避免 I1 被纠错成假生命值', () => {
    // 真机里暂停图标被读成「I1」（中心 x≈0.94）；圈进 top 就会变成生命 11。
    expect(regionOf(px('I1', 1140, 31, 40, 40, 1233, 720).box)).toBe('unknown');
    expect(regionOf(px('1X', 1023, 16, 58, 58, 1233, 720).box)).toBe('unknown');
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

  it('结算横幅能认出来：行动结束=胜利，作战失败=失败，同帧两种字样按失败算', () => {
    expect(parseBattleState([line('行动结束', 0.4, 0.65, 0.1, 0.05)]).result).toBe('victory');
    expect(parseBattleState([line('作战失败', 0.4, 0.65, 0.1, 0.05)]).result).toBe('defeat');
    expect(parseBattleState([line('MISSION ACCOMPLISHED', 0.3, 0.5, 0.3, 0.05)]).result).toBe('victory');
    expect(
      parseBattleState([line('作战失败', 0.4, 0.65), line('行动结束', 0.4, 0.55)]).result,
    ).toBe('defeat');
  });

  it('对局中 result 为 null，结算后回执不再报缺项', () => {
    const playing = parseBattleState([line('20', 0.52, 0.02, 0.03)]);
    expect(playing.result).toBeNull();
    expect(describeBattleState(playing)).toContain('没读到');

    const finished = parseBattleState([line('行动结束', 0.4, 0.65, 0.1, 0.05)]);
    expect(describeBattleState(finished)).toContain('本局已结束');
    expect(describeBattleState(finished)).not.toContain('没读到');
  });

  it('空结果不编数字', () => {
    const state = parseBattleState([]);
    expect(state).toEqual({ cost: null, life: null, enemies: null, paused: null, handCosts: [], result: null });
    expect(missingFields(state)).toEqual(['费用', '生命值', '剩余敌人', '手牌费用']);
  });

  it('缺项清单只列真的没读到的', () => {
    const state = parseBattleState([cost(), card('12', 0.05), card('16', 0.22)]);
    expect(missingFields(state)).toEqual(['生命值', '剩余敌人']);
  });

  it('数字语境纠错：0 被认成 O 也能读出来，字母词不受影响', () => {
    expect(parseBattleState([enemies('O/11')]).enemies).toBe('0/11');
    expect(parseBattleState([life('2O')]).life).toBe(20);
    // PAUSE 里也有 O：纠错只在数字语境生效，否则横幅会变成 PA0SE 认不出来。
    expect(parseBattleState([banner('PAUSE')]).paused).toBe(true);
  });

  it('手牌卡费容忍图标前缀，三位数按邻卡粘连拆回两位', () => {
    expect(parseBattleState([card('N16', 0.26)]).handCosts.map((c) => c.cost)).toEqual([16]);
    expect(parseBattleState([card('1 6', 0.38)]).handCosts.map((c) => c.cost)).toEqual([16]);
    // 118 = 邻卡的 1 + 18；167 = 16 + 邻卡的 7；819 = 邻卡的 8 + 19（去首位都在 40 以内）。
    expect(parseBattleState([card('118', 0.51)]).handCosts.map((c) => c.cost)).toEqual([18]);
    expect(parseBattleState([card('A167', 0.35)]).handCosts.map((c) => c.cost)).toEqual([16]);
    expect(parseBattleState([card('819', 0.52)]).handCosts.map((c) => c.cost)).toEqual([19]);
    // 拆不出合法值就仍然丢弃：99 超上限，四位数更不可能是卡费。
    expect(parseBattleState([card('999', 0.60)]).handCosts).toEqual([]);
    expect(parseBattleState([card('1234', 0.70)]).handCosts).toEqual([]);
  });

  it('真机一帧回归：敌人、手牌、部署费用三处都不再读错', () => {
    // 坐标照抄 2026-10 真机日志（1280×720、暂停中）。
    const state = parseBattleState([
      px('N16', 340, 594, 66, 33),
      px('PAUSE', 484, 283, 306, 90),
      px('16', 486, 603, 28, 16),
      px('ENEH', 489, 33, 33, 17),
      px('O/11', 550, 14, 56, 29),
      px('暂停中', 593, 366, 91, 35),
      px('118', 656, 591, 70, 37),
      px('H', 682, 11, 31, 35),
      px('20', 740, 15, 36, 27),
      px('20', 874, 592, 67, 34),
      px('1X', 1066, 18, 60, 60),
      px('剩余可放置角色：8', 1080, 550, 178, 23),
      px('24', 1085, 591, 71, 39),
      px('C', 1160, 496, 41, 41),
      px('29', 1201, 491, 65, 49),
    ]);
    expect(state.enemies).toBe('0/11');
    expect(state.life).toBe(20);
    expect(state.paused).toBe(true);
    // `118` 现在是邻卡粘连的 18，不是被丢掉。
    expect(state.handCosts.map((c) => c.cost)).toEqual([16, 16, 18, 20, 24]);
    // 最右一张卡（24）留在 hand，部署费用取右下角的 29。
    expect(state.cost).toBe(29);
    expect(missingFields(state)).toEqual([]);
  });

  it('真机第二帧回归：手牌里不该冒出一张 4 费', () => {
    // 坐标照抄部署银灰之后那一帧（1233×720、暂停中）；「4」在卡面下沿 y=638。
    const frame = (text: string, x: number, y: number, w: number, h: number) => px(text, x, y, w, h, 1233, 720);
    const state = parseBattleState([
      frame('N12', 16, 600, 58, 33),
      frame('4', 123, 638, 20, 24),
      frame('N16', 222, 597, 58, 33),
      frame('A16', 331, 600, 58, 33),
      frame('A17', 427, 602, 58, 33),
      frame('PAUSE', 464, 283, 300, 88),
      frame('ENEMY', 472, 35, 60, 17),
      frame('O/11', 529, 11, 56, 29),
      frame('非18', 530, 597, 62, 33),
      frame('暂停中', 571, 365, 90, 35),
      frame('819', 635, 600, 62, 33),
      frame('漢', 653, 8, 28, 26),
      frame('20', 714, 17, 36, 27),
      frame('1X', 1023, 16, 58, 58),
      frame('剩余可放置角色：7', 1041, 555, 170, 23),
      frame('24', 1046, 598, 66, 34),
      frame('C', 1118, 506, 40, 40),
      frame('16', 1162, 501, 60, 44),
    ]);
    expect(state.enemies).toBe('0/11');
    expect(state.life).toBe(20);
    expect(state.paused).toBe(true);
    expect(state.cost).toBe(16);
    // 12 / 16 / 16 / 17 / 18 / 19 / 24：没有 4，`819` 拆成 19、`非18` 取 18。
    expect(state.handCosts.map((c) => c.cost)).toEqual([12, 16, 16, 17, 18, 19, 24]);
  });

  it('整帧与灰度条读到同一张卡时按 x 去重，只保留先出现的那条', () => {
    const state = parseBattleState([
      // 整帧那一路
      line('16', 0.26, 0.84, 0.04, 0.03),
      line('12', 0.10, 0.84, 0.04, 0.03),
      // 灰度条那一路：前两张与整帧重叠，最后一张只有它读到
      line('16', 0.262, 0.84, 0.04, 0.03),
      line('12', 0.101, 0.84, 0.04, 0.03),
      line('24', 0.86, 0.84, 0.04, 0.03),
    ]);
    expect(state.handCosts.map((c) => c.cost)).toEqual([12, 16, 24]);
  });

  it('同一位置两路读数冲突时保留整帧那条', () => {
    const state = parseBattleState([
      line('16', 0.26, 0.84, 0.04, 0.03),
      line('18', 0.262, 0.84, 0.04, 0.03),
    ]);
    expect(state.handCosts.map((c) => c.cost)).toEqual([16]);
  });

  it('认到胜利横幅且无失败字样时判定为 victory', () => {
    const state = parseBattleState([line('行动结束', 0.4, 0.4, 0.2, 0.1)]);
    expect(state.result).toBe('victory');
  });

  it('出现理智返还或放弃行动时断然判定为 defeat，杜绝误判为胜利', () => {
    // 玩家主动退出或失败时，画面上方常有「行动结束」，但下方有「理智返还 6」
    const state = parseBattleState([
      line('行动结束', 0.4, 0.1, 0.2, 0.05),
      line('理智返还 6', 0.5, 0.6, 0.1, 0.04),
    ]);
    expect(state.result).toBe('defeat');

    const desc = describeBattleState(state);
    expect(desc).toContain('画面显示本局失败或已退出');
    expect(desc).not.toContain('胜利');
  });

  it('手牌按排聚类：即便区间放进来了，偏离卡费行的数字也会被剔除', () => {
    const state = parseBattleState([
      line('12', 0.10, 0.83, 0.04, 0.03),
      line('16', 0.30, 0.83, 0.04, 0.03),
      line('20', 0.50, 0.83, 0.04, 0.03),
      // 中心 y=0.87，仍在手牌带内，但比这一排低 0.025。
      line('4', 0.70, 0.855, 0.03, 0.03),
    ]);
    expect(state.handCosts.map((c) => c.cost)).toEqual([12, 16, 20]);
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
