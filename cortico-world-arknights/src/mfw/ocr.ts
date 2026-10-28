/**
 * OCR：用随包发布的内置 PP-OCRv6 small 模型，对扩展自己抓的帧做识别。
 *
 * 边界很窄：只调用 `post_recognition`，不接管截图与点击——控制权始终在 `ArknightsSession`
 * 的控制器那边。模型与 Tasker 由 `ArknightsRuntime` 持有（pipeline 共用同一个），
 * 模型缺失、绑定没导出 Resource/Tasker、加载失败都折成可读原因交给回执，不抛错。
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cropRgba, decodePng, encodePng, toGrayscale } from './png.ts';
import type { MaaTaskJobLike, MaaTaskerLike } from './native.ts';
import type { ArknightsRuntime } from './runtime.ts';
import { pngSize } from './screen.ts';
import { errorText, withTimeout } from './timeout.ts';

const RECO_TIMEOUT_MS = 15_000;
/**
 * 手牌条的起始高度（占整帧比例）：底部 22% 覆盖卡费那一排。
 *
 * 二次识别会先裁这一条再转灰度——实测彩色下最后一张卡的「24」压在浅色立绘上，
 * det 认不出来；转灰度后同一批像素就能出框。整帧那一次仍然保留，两路结果按 x 归并。
 */
const HAND_STRIP_TOP = 0.78;

/** 一条识别结果：文字 + 归一化外框（0~1，相对整帧左上角）。 */
export interface OcrLine {
  readonly text: string;
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export type OcrOutcome =
  | {
    readonly ok: true;
    readonly lines: readonly OcrLine[];
    /** 绑定返回的原始明细：只给冒烟脚本 `--ocr` 排障用，不进模型上下文、工具也不读它。 */
    readonly rawDetail?: unknown;
    readonly debug?: string;
  }
  | { readonly ok: false; readonly error: string };

export type OcrLoadResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** MaaFramework 只认这三个固定文件名，且必须与模型同目录（rec + keys 必需，det 仅 only_rec 时可缺）。 */
export const OCR_MODEL_FILENAMES = ['det.onnx', 'rec.onnx', 'keys.txt'] as const;

/** 随包发布的内置模型目录：`src/mfw/ocr.ts` 上溯两级就是包根，发布前后层级一致。 */
export function builtinOcrModelDir(): string {
  return fileURLToPath(new URL('../../assets/resource/model/ocr', import.meta.url));
}

/**
 * 目录里缺哪些模型文件；空数组表示三件套齐全且都不是空文件。
 *
 * 必须自己验：MaaFramework 的 `lazy_load` 只按文件名递归判断、不看大小，空文件或半包会被
 * 当成「加载成功」，直到识别时才表现为 0 行——那种失败没人看得懂。
 */
export function missingModelFiles(dir: string): string[] {
  const missing: string[] = [];
  for (const name of OCR_MODEL_FILENAMES) {
    try {
      const stat = statSync(join(dir, name));
      if (!stat.isFile() || stat.size <= 0) missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * 候选目录，按优先级排列：
 *
 * 1. `<resourceDir>/model/ocr`：配置填资源包根（MaaFramework 标准 bundle）时命中；
 * 2. `<resourceDir>`：直接把模型目录填进配置时命中；
 * 3. 内置目录：什么都不配也能识别。
 *
 * 每个候选都要过 `missingModelFiles`，缺件的跳过并写进失败原因。
 */
export function ocrModelCandidates(resourceDir: string, builtinDir = builtinOcrModelDir()): string[] {
  const root = resourceDir.trim().replace(/[\\/]+$/, '');
  const candidates = root ? [join(root, 'model', 'ocr'), root, builtinDir] : [builtinDir];
  return [...new Set(candidates.filter((path) => path.trim() !== ''))];
}

function isRect(value: unknown): value is readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length < 4) return false;
  return value.slice(0, 4).every((n) => typeof n === 'number' && Number.isFinite(n));
}

interface RawEntry {
  readonly text: string;
  readonly box: readonly [number, number, number, number];
}

/**
 * 从 maa-node 的识别明细里刮出带文字的条目。
 * 明细形状随版本变动（RecoDetail / `{all,filtered}` / 数组），这里只认「有 text 有 box」的形状。
 */
function collectEntries(node: unknown, depth = 0): RawEntry[] {
  if (!node || depth > 6) return [];
  if (Array.isArray(node)) return node.flatMap((item) => collectEntries(item, depth + 1));
  if (typeof node !== 'object') return [];

  const obj = node as Record<string, unknown>;
  if (typeof obj.text === 'string' && isRect(obj.box)) return [{ text: obj.text, box: obj.box }];

  if (Array.isArray(obj.filtered) && obj.filtered.length > 0) return collectEntries(obj.filtered, depth + 1);
  if (Array.isArray(obj.all)) return collectEntries(obj.all, depth + 1);
  if (obj.detail !== undefined) return collectEntries(obj.detail, depth + 1);
  if (obj.reco !== undefined) return collectEntries(obj.reco, depth + 1);
  return [];
}

/** 把识别明细折成按 x 排序的归一化文字行；空文字与非法框直接丢掉。 */
export function toOcrLines(detail: unknown, frameSize: readonly [number, number]): OcrLine[] {
  const [width, height] = frameSize;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];

  const lines: OcrLine[] = [];
  for (const entry of collectEntries(detail)) {
    const text = entry.text.trim();
    if (!text) continue;
    const [x, y, w, h] = entry.box;
    lines.push({ text, box: { x: x / width, y: y / height, w: w / width, h: h / height } });
  }
  return lines.sort((a, b) => a.box.x - b.box.x);
}

/** 一次加载、多次识别的 OCR 句柄；Resource/Tasker 由 `ArknightsRuntime` 持有并复用。 */
export class ArknightsOcr {
  constructor(private readonly runtime: ArknightsRuntime) {}

  /** `null` 表示还没试过；用于回执里区分「没开」和「加载失败」。 */
  get status(): 'idle' | 'ready' | 'failed' {
    return this.runtime.ocrStatus;
  }

  get ready(): boolean {
    return this.runtime.ocrReady;
  }

  async load(resourceDir: string): Promise<OcrLoadResult> {
    return this.runtime.ensureOcrModel(resourceDir);
  }

  async recognize(png: Uint8Array, frameSize?: readonly [number, number]): Promise<OcrOutcome> {
    const tasker = this.runtime.taskerInstance;
    if (!tasker) {
      return { ok: false, error: this.runtime.ocrFailure ?? 'OCR 还没加载，先调用一次识别。' };
    }

    const size = frameSize ?? (() => {
      const read = pngSize(png);
      return read ? ([read.width, read.height] as const) : null;
    })();
    if (!size) return { ok: false, error: '识别失败：读不出这一帧的像素尺寸。' };

    let detail: unknown;
    let lines: OcrLine[];
    try {
      const full = await this.runOcr(tasker, png, [0, 0, size[0], size[1]], size);
      detail = full.detail;
      lines = full.lines;
    } catch (error) {
      return { ok: false, error: `识别失败：${errorText(error)}` };
    }

    // 手牌条再来一次（灰度）：整帧那次认不出的卡费，去色后往往能出框。
    const strip = await this.runHandStrip(tasker, png, size);
    if (strip.length > 0) lines = [...lines, ...strip];

    return lines.length > 0
      ? { ok: true, lines, rawDetail: detail }
      : { ok: true, lines, rawDetail: detail, debug: '识别完成，但结果里没有带文字的条目' };
  }

  /** 跑一次 OCR；失败抛错，由调用方折成可读原因。 */
  private async runOcr(
    tasker: MaaTaskerLike,
    imageBytes: Uint8Array,
    roi: readonly [number, number, number, number],
    size: readonly [number, number],
  ): Promise<{ detail: unknown; lines: OcrLine[] }> {
    // 绑定的 ImageData 是 ArrayBuffer；`slice()` 保证拿到的是一段连续的、属于本帧的缓冲。
    const image = imageBytes.slice().buffer as ArrayBuffer;
    const job = tasker.post_recognition('OCR', { roi: [...roi], only_rec: false }, image);
    const done = await withTimeout(Promise.resolve(job.wait()), RECO_TIMEOUT_MS, 'OCR 识别');
    if (!done.succeeded) throw new Error(`控制器返回失败（状态码 ${String(done.status)}）。`);
    const detail = this.pickDetail(tasker, job);
    return { detail, lines: toOcrLines(detail, size) };
  }

  /**
   * 手牌条二次识别：裁底部一条 → 转灰度 → 重新编码 → OCR，最后把框平移回整帧坐标。
   *
   * 这是增强项：解码不支持、编码失败、绑定报错都只意味着少了这一路结果，不会让整次识别失败。
   */
  private async runHandStrip(
    tasker: MaaTaskerLike,
    png: Uint8Array,
    size: readonly [number, number],
  ): Promise<OcrLine[]> {
    const [width, height] = size;
    const top = Math.round(height * HAND_STRIP_TOP);
    const stripHeight = height - top;
    if (stripHeight <= 0) return [];

    try {
      const decoded = decodePng(png);
      if (!decoded) return [];
      const cropped = cropRgba(decoded, { x: 0, y: top, w: width, h: stripHeight });
      if (!cropped) return [];
      const encoded = encodePng(toGrayscale(cropped));
      if (!encoded) return [];

      const { lines } = await this.runOcr(tasker, encoded, [0, 0, width, stripHeight], [width, stripHeight]);
      // 条带的框是按条高归一化的，映射回整帧时要先乘回条高、再加上偏移，最后按整帧高归一化。
      const scaleY = stripHeight / height;
      const offsetY = top / height;
      return lines.map((line) => ({
        text: line.text,
        box: {
          x: line.box.x,
          y: offsetY + line.box.y * scaleY,
          w: line.box.w,
          h: line.box.h * scaleY,
        },
      }));
    } catch {
      return [];
    }
  }

  /** 先按 `TaskDetail.nodes → node_detail().reco` 取；取不到再退回 `recognition_detail()`。 */
  private pickDetail(tasker: MaaTaskerLike, job: MaaTaskJobLike): unknown {
    try {
      const task = job.get();
      if (task && typeof task === 'object') {
        const nodes = (task as { nodes?: unknown }).nodes;
        if (Array.isArray(nodes) && nodes.length > 0) {
          const node = tasker.node_detail(nodes[0] as number);
          if (node && typeof node === 'object') {
            const reco = (node as { reco?: unknown }).reco;
            if (reco) return reco;
          }
        }
      }
    } catch {
      // 两路取详情，这一路不行就换下一路。
    }
    try {
      return tasker.recognition_detail(job.id);
    } catch {
      return null;
    }
  }

  /** 生命周期由 `ArknightsRuntime` 管理：这里不销毁共享的 Tasker/Resource。 */
  dispose(): void {}
}
