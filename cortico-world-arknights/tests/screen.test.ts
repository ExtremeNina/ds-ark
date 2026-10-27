import { describe, it, expect } from 'vitest';
import { pngSize, screenshotName, toPngBytes } from '../src/mfw/screen.ts';

/** 造一个只有 IHDR 头的 PNG，够 pngSize 读尺寸用。 */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe('截图数据整形', () => {
  it('从 IHDR 读出真实像素尺寸', () => {
    expect(pngSize(pngHeader(1084, 610))).toEqual({ width: 1084, height: 610 });
    expect(pngSize(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('不是 PNG 或数据不完整时返回 null，不猜尺寸', () => {
    expect(pngSize(null)).toBeNull();
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull();
    const notPng = pngHeader(10, 10);
    notPng[1] = 0;
    expect(pngSize(notPng)).toBeNull();
    const notIhdr = pngHeader(10, 10);
    notIhdr[12] = 0x58;
    expect(pngSize(notIhdr)).toBeNull();
    expect(pngSize(pngHeader(0, 10))).toBeNull();
  });

  it('ArrayBuffer、Uint8Array、空数据都归一成字节视图', () => {
    const bytes = pngHeader(64, 32);
    expect(toPngBytes(bytes.buffer as ArrayBuffer)?.byteLength).toBe(33);
    expect(toPngBytes(bytes)?.byteLength).toBe(33);
    expect(toPngBytes(new Uint8Array(0))).toBeNull();
    expect(toPngBytes(null)).toBeNull();
  });

  it('附件名带秒级时间戳', () => {
    expect(screenshotName(new Date(2026, 0, 2, 3, 4, 5))).toBe('arknights-20260102-030405.png');
  });
});
