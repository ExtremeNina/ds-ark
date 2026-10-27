import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cropRgba, decodePng, encodePng, toGrayscale, type RgbaImage } from '../src/mfw/png.ts';

/** 造一张带渐变与透明度的图，确保每个通道都被覆盖到。 */
function sample(width = 8, height = 6): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = (x * 31) & 0xff;
      data[i + 1] = (y * 41) & 0xff;
      data[i + 2] = (x * y * 7) & 0xff;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('PNG 编解码', () => {
  it('编码后再解码，尺寸与像素完全一致', () => {
    const image = sample();
    const encoded = encodePng(image);
    expect(encoded).not.toBeNull();

    const decoded = decodePng(encoded!);
    expect(decoded).not.toBeNull();
    expect(decoded!.width).toBe(image.width);
    expect(decoded!.height).toBe(image.height);
    expect([...decoded!.data]).toEqual([...image.data]);
  });

  it('裁切按像素搬运，超界部分夹到边缘', () => {
    const image = sample(8, 6);
    const cropped = cropRgba(image, { x: 2, y: 1, w: 3, h: 2 });
    expect(cropped).not.toBeNull();
    expect(cropped!.width).toBe(3);
    expect(cropped!.height).toBe(2);
    // 左上角对应原图 (2,1)
    const source = (1 * 8 + 2) * 4;
    expect(cropped!.data[0]).toBe(image.data[source]);
    expect(cropped!.data[1]).toBe(image.data[source + 1]);

    // 请求超出画面：夹到边界，不越界
    expect(cropRgba(image, { x: 6, y: 5, w: 100, h: 100 })!.width).toBe(2);
    expect(cropRgba(image, { x: 20, y: 20, w: 5, h: 5 })).toBeNull();
  });

  it('转灰度后三个通道相等，且落在原亮度的合理区间', () => {
    const image = sample();
    const gray = toGrayscale(image);
    for (let i = 0; i < gray.data.length; i += 4) {
      expect(gray.data[i]).toBe(gray.data[i + 1]);
      expect(gray.data[i]).toBe(gray.data[i + 2]);
      expect(gray.data[i + 3]).toBe(image.data[i + 3]);
    }
    const r = image.data[0]!;
    const g = image.data[1]!;
    const b = image.data[2]!;
    expect(gray.data[0]).toBe(Math.round(0.299 * r + 0.587 * g + 0.114 * b));
  });

  it('不支持的输入返回 null，不抛错', () => {
    expect(decodePng(null)).toBeNull();
    expect(decodePng(new Uint8Array(4))).toBeNull();
    expect(decodePng(new Uint8Array(64))).toBeNull();
    // 只有 IHDR、没有 IDAT 的「假 PNG」
    const headerOnly = encodePng(sample(2, 2))!;
    const truncated = headerOnly.subarray(0, 33);
    expect(decodePng(truncated)).toBeNull();
    expect(encodePng({ width: 0, height: 0, data: new Uint8Array(0) })).toBeNull();
  });

  it('能解真机截图（存在时）：尺寸与像素数量对得上', () => {
    const file = fileURLToPath(new URL('../../test/smoke-before.png', import.meta.url));
    if (!existsSync(file)) return; // 仓库里没有这张图时跳过，不制造假失败
    const decoded = decodePng(new Uint8Array(readFileSync(file)));
    expect(decoded).not.toBeNull();
    expect(decoded!.width).toBeGreaterThan(0);
    expect(decoded!.data.byteLength).toBe(decoded!.width * decoded!.height * 4);
    // 整屏 RGB 真彩色截图，不应该解成全黑
    expect(decoded!.data.some((value) => value > 32)).toBe(true);
  });
});
