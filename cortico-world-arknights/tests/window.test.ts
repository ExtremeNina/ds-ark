import { describe, it, expect } from 'vitest';
import { DEFAULT_WINDOW_KEYWORDS, describeDevices, parseKeywords, pickWindow } from '../src/mfw/window.ts';
import type { MaaDesktopDevice } from '../src/mfw/native.ts';

const devices: readonly MaaDesktopDevice[] = [
  ['0x1', 'Notepad', '无标题 - 记事本'],
  ['0x2', 'UnityWndClass', '明日方舟'],
  ['0x3', 'UnityWndClass', 'Arknights'],
];

describe('窗口匹配', () => {
  it('逗号分隔的关键字按顺序命中，空白与空项被丢掉', () => {
    expect(parseKeywords(' 明日方舟 ,, Arknights ')).toEqual(['明日方舟', 'Arknights']);
    expect(parseKeywords('明日方舟，Arknights')).toEqual(['明日方舟', 'Arknights']);
  });

  it('没写关键字时退回默认的多个标题', () => {
    expect(parseKeywords('')).toEqual([...DEFAULT_WINDOW_KEYWORDS]);
    expect(parseKeywords('  ')).toEqual([...DEFAULT_WINDOW_KEYWORDS]);
  });

  it('第一个关键字先匹配，命中第一台设备即返回', () => {
    expect(pickWindow(devices, ['明日方舟'])?.handle).toBe('0x2');
    expect(pickWindow(devices, ['Arknights', '明日方舟'])?.handle).toBe('0x3');
  });

  it('大小写不敏感', () => {
    expect(pickWindow(devices, ['arknights'])?.handle).toBe('0x3');
  });

  it('没命中或没有设备时返回 null', () => {
    expect(pickWindow(devices, ['原神'])).toBeNull();
    expect(pickWindow([], ['明日方舟'])).toBeNull();
    expect(pickWindow(null, ['明日方舟'])).toBeNull();
  });

  it('窗口名为空的设备不参与匹配，空关键字也不会命中一切', () => {
    const blank: readonly MaaDesktopDevice[] = [['0x9', 'X', '   '], ['0x8', 'X', '明日方舟']];
    expect(pickWindow(blank, ['明日方舟'])?.handle).toBe('0x8');
    expect(pickWindow(blank, [''])).toBeNull();
  });

  it('回执里的窗口清单只列有名字的窗口，最多 8 条', () => {
    expect(describeDevices(devices)).toBe('「无标题 - 记事本」、「明日方舟」、「Arknights」');
    expect(describeDevices([])).toContain('没有可截图的窗口');
    const many: MaaDesktopDevice[] = Array.from({ length: 12 }, (_, i) => [`0x${i}`, 'X', `窗口${i}`] as const);
    expect(describeDevices(many).split('、')).toHaveLength(8);
  });
});
