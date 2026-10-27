/**
 * 极简 PNG 编解码：只为了「把截图裁一条、转灰度、再送去 OCR」这一个用途。
 *
 * 只覆盖 MaaFramework 截图会出现的形态——8 位、非隔行、灰度 / RGB / 灰度+Alpha / RGBA
 * （真机实测是 colorType=2 的 RGB）。调色板、16 位、隔行图一律返回 `null`，调用方退回原图。
 * 依赖 `node:zlib`，不引入任何第三方图像库。
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** 长度恒为 `width * height * 4` 的 RGBA8 数据。 */
  readonly data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < SIGNATURE.length) return false;
  return SIGNATURE.every((value, index) => bytes[index] === value);
}

function channelsOf(colorType: number): number {
  switch (colorType) {
    case 0: // 灰度
      return 1;
    case 2: // RGB
      return 3;
    case 4: // 灰度 + Alpha
      return 2;
    case 6: // RGBA
      return 4;
    default:
      return 0;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(type: number, a: number, b: number, c: number): number {
  switch (type) {
    case 0:
      return 0;
    case 1:
      return a;
    case 2:
      return b;
    case 3:
      return (a + b) >> 1;
    case 4:
      return paeth(a, b, c);
    default:
      return 0;
  }
}

/** 解码成 RGBA8；不支持的形态或数据损坏时返回 `null`，由调用方决定退回什么。 */
export function decodePng(bytes: Uint8Array | null | undefined): RgbaImage | null {
  if (!bytes || !hasSignature(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  let channels = 0;
  const parts: Uint8Array[] = [];
  let offset = 8;

  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const start = offset + 8;
    if (start + length + 4 > bytes.byteLength) return null;

    if (type === 'IHDR') {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      const bitDepth = bytes[start + 8]!;
      const colorType = bytes[start + 9]!;
      const compression = bytes[start + 10]!;
      const filter = bytes[start + 11]!;
      const interlace = bytes[start + 12]!;
      if (bitDepth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) return null;
      channels = channelsOf(colorType);
      if (width <= 0 || height <= 0 || channels === 0) return null;
    } else if (type === 'IDAT') {
      parts.push(bytes.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = start + length + 4;
  }

  if (width === 0 || height === 0 || parts.length === 0) return null;

  const merged = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let cursor = 0;
  for (const part of parts) {
    merged.set(part, cursor);
    cursor += part.byteLength;
  }

  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(merged));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.byteLength < (stride + 1) * height) return null;

  const data = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const type = raw[rowStart]!;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? current[i - channels]! : 0;
      const b = previous[i]!;
      const c = i >= channels ? previous[i - channels]! : 0;
      current[i] = (raw[rowStart + 1 + i]! + unfilter(type, a, b, c)) & 0xff;
    }
    const out = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = out + x * 4;
      if (channels <= 2) {
        const gray = current[src]!;
        data[dst] = gray;
        data[dst + 1] = gray;
        data[dst + 2] = gray;
        data[dst + 3] = channels === 2 ? current[src + 1]! : 255;
      } else {
        data[dst] = current[src]!;
        data[dst + 1] = current[src + 1]!;
        data[dst + 2] = current[src + 2]!;
        data[dst + 3] = channels === 4 ? current[src + 3]! : 255;
      }
    }
    previous.set(current);
  }

  return { width, height, data };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)));
  return out;
}

/** 编码成 RGBA8 PNG；尺寸非法时返回 `null`。 */
export function encodePng(image: RgbaImage): Uint8Array | null {
  const { width, height, data } = image;
  if (width <= 0 || height <= 0 || data.byteLength < width * height * 4) return null;

  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None
    raw.set(data.subarray(y * stride, (y + 1) * stride), rowStart + 1);
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  // 10/11/12 已经是 0：compression / filter / interlace

  let compressed: Uint8Array;
  try {
    compressed = new Uint8Array(deflateSync(raw));
  } catch {
    return null;
  }

  const chunks = [chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))];
  const total = chunks.reduce((sum, part) => sum + part.byteLength, 0) + SIGNATURE.length;
  const out = new Uint8Array(total);
  out.set(SIGNATURE, 0);
  let cursor = SIGNATURE.length;
  for (const part of chunks) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

/** 裁一块矩形；越界部分按最近的边缘夹住，完全落在图外返回 `null`。 */
export function cropRgba(
  image: RgbaImage,
  rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
): RgbaImage | null {
  const x0 = Math.max(0, Math.min(image.width, Math.round(rect.x)));
  const y0 = Math.max(0, Math.min(image.height, Math.round(rect.y)));
  const x1 = Math.max(x0, Math.min(image.width, Math.round(rect.x + rect.w)));
  const y1 = Math.max(y0, Math.min(image.height, Math.round(rect.y + rect.h)));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = ((y0 + y) * image.width + x0) * 4;
    data.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** 转灰度（保留 Alpha）：det 对色彩边缘敏感，去色能让数字的亮度梯度占主导。 */
export function toGrayscale(image: RgbaImage): RgbaImage {
  const data = new Uint8Array(image.data);
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!);
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
  }
  return { width: image.width, height: image.height, data };
}
