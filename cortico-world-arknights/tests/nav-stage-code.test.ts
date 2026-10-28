import { describe, expect, it } from 'vitest';
import {
  isChipStage,
  isMainStage,
  isResourceStage,
  isSideStage,
  mainChapterOf,
  normalizeOcrCode,
  normalizeStageCode,
  sameStage,
  stagePattern,
} from '../src/nav/stage-code.ts';

describe('关卡代号归一化', () => {
  it('统一破折号、全角字符与空格', () => {
    expect(normalizeStageCode('1—7')).toBe('1-7');
    expect(normalizeStageCode('1－7')).toBe('1-7');
    expect(normalizeStageCode(' 1 7 ')).toBe('17');
    expect(normalizeStageCode('ce－5')).toBe('CE-5');
    expect(normalizeStageCode('ＡＤ－８')).toBe('AD-8');
  });

  it('OCR 只纠数字段里的易混字符，不把字母代号改坏', () => {
    expect(normalizeOcrCode('I-7')).toBe('1-7');
    expect(normalizeOcrCode('l—7')).toBe('1-7');
    expect(normalizeOcrCode('1O-7')).toBe('10-7');
    expect(normalizeOcrCode('LS-5')).toBe('LS-5');
    expect(normalizeOcrCode('LS5')).toBe('LS-5');
    expect(normalizeOcrCode('PR-A-1')).toBe('PR-A-1');
  });

  it('去掉引号、括号与标点后再匹配', () => {
    expect(normalizeOcrCode('「1-7」')).toBe('1-7');
    expect(normalizeOcrCode('CE-5:')).toBe('CE-5');
  });

  it('整串相等才算同一关，S1-7 / 11-7 / 1-70 不会冒充 1-7', () => {
    expect(sameStage('1-7', '1-7')).toBe(true);
    expect(sameStage('I-7', '1-7')).toBe(true);
    expect(sameStage('S1-7', '1-7')).toBe(false);
    expect(sameStage('11-7', '1-7')).toBe(false);
    expect(sameStage('1-70', '1-7')).toBe(false);
    expect(sameStage('CE-5', 'CE-5')).toBe(true);
  });

  it('生成锚定的 OCR 正则，容忍空格与横线变体', () => {
    expect(stagePattern('1-7')).toBe('^\\s*1\\s*[-—–]\\s*7\\s*$');
    expect(stagePattern('PR-A-1')).toBe('^\\s*PR\\s*[-—–]\\s*A\\s*[-—–]\\s*1\\s*$');
  });

  it('按形状分类', () => {
    expect(isMainStage('1-7')).toBe(true);
    expect(isResourceStage('LS-5')).toBe(true);
    expect(isChipStage('PR-A-1')).toBe(true);
    expect(isSideStage('AD-8')).toBe(true);
    expect(isSideStage('1-7')).toBe(false);
  });

  it('主线的第一段就是章节号', () => {
    expect(mainChapterOf('1-7')).toBe(1);
    expect(mainChapterOf('12-4')).toBe(12);
    expect(mainChapterOf('CE-5')).toBeNull();
  });
});
