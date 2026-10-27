/**
 * 截图数据整形。绑定的 `ImageData` 是 `ArrayBuffer`，内容是 MaaFramework 编码后的图片
 * （`MaaImageBufferGetEncoded`），所以这里不需要自己编码 PNG，也不引入 sharp 之类的原生依赖。
 */

export const SCREENSHOT_MIME = 'image/png';

/** 把绑定返回的缓冲折成 `Uint8Array`；空数据给 `null`，由调用方转成失败回执。 */
export function toPngBytes(image: ArrayBuffer | Uint8Array | ArrayBufferView | null | undefined): Uint8Array | null {
  if (!image) return null;
  if (image instanceof Uint8Array) return image.byteLength > 0 ? image : null;
  if (image instanceof ArrayBuffer) return image.byteLength > 0 ? new Uint8Array(image) : null;
  if (ArrayBuffer.isView(image)) {
    const view = new Uint8Array(image.buffer, image.byteOffset, image.byteLength);
    return view.byteLength > 0 ? view : null;
  }
  return null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 从 PNG 的 IHDR 读出真实像素尺寸，不解码整张图。
 * 用途是核对「点击换算用的分辨率」与「这一帧的实际尺寸」是否同一个坐标系。
 */
export function pngSize(bytes: Uint8Array | null | undefined): { width: number; height: number } | null {
  if (!bytes || bytes.byteLength < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  const type = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (type !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/** 附件名带上时间戳，方便在会话记录里区分不同帧。 */
export function screenshotName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `arknights-${stamp}.png`;
}
