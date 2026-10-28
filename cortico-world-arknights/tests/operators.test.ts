import { describe, expect, it } from 'vitest';
import { findOperatorByName, matchOperatorName, parseVisibleOperators } from '../src/battle/operators.ts';

describe('干员识别与名册匹配', () => {
  it('正确匹配标准干员名，排除杂字', () => {
    expect(matchOperatorName('银灰')).toBe('银灰');
    expect(matchOperatorName('桃金娘')).toBe('桃金娘');
    expect(matchOperatorName('克洛丝')).toBe('克洛丝');
    expect(matchOperatorName('编队中')).toBeNull();
    expect(matchOperatorName('开始行动')).toBeNull();
    expect(matchOperatorName('精英2')).toBeNull();
  });

  it('提取画面中的干员列表并按横向坐标排序', () => {
    const mockLines = [
      { text: '克洛丝', box: { x: 0.6, y: 0.5, w: 0.08, h: 0.04 } },
      { text: '桃金娘', box: { x: 0.2, y: 0.5, w: 0.08, h: 0.04 } },
      { text: '芬', box: { x: 0.4, y: 0.5, w: 0.08, h: 0.04 } },
      { text: '开始行动', box: { x: 0.88, y: 0.8, w: 0.1, h: 0.05 } },
    ];

    const result = parseVisibleOperators(mockLines);
    expect(result.length).toBe(3);
    expect(result[0]?.name).toBe('桃金娘');
    expect(result[1]?.name).toBe('芬');
    expect(result[2]?.name).toBe('克洛丝');
  });

  it('查找指定干员返回坐标', () => {
    const mockLines = [
      { text: '塞雷娅', box: { x: 0.35, y: 0.5, w: 0.08, h: 0.04 } },
      { text: '银灰', box: { x: 0.75, y: 0.5, w: 0.08, h: 0.04 } },
    ];

    const found = findOperatorByName(mockLines, '银灰');
    expect(found).not.toBeNull();
    expect(found?.name).toBe('银灰');
    expect(found?.center.x).toBeCloseTo(0.79, 1);

    const notFound = findOperatorByName(mockLines, '泥岩');
    expect(notFound).toBeNull();
  });
});
