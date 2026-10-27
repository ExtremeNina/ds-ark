/**
 * OCR：借本机 MAA 资源包里的 OCR 模型，对扩展自己抓的帧做识别。
 *
 * 边界很窄：只加载 OCR 模型、只调用 `post_recognition`，不加载 pipeline、不调用 `post_task`，
 * 也不接管截图与点击——控制权始终在 `ArknightsSession` 的控制器那边。
 * 没有资源目录、绑定没导出 Resource/Tasker、模型加载失败，都折成可读原因交给回执，不抛错。
 */
import { join } from 'node:path';
import type { MaaControllerLike, MaaModule, MaaResourceLike, MaaTaskJobLike, MaaTaskerLike } from './native.ts';
import { pngSize } from './screen.ts';
import { errorText, withTimeout } from './timeout.ts';

const MODEL_LOAD_TIMEOUT_MS = 30_000;
const RECO_TIMEOUT_MS = 15_000;

/** 一条识别结果：文字 + 归一化外框（0~1，相对整帧左上角）。 */
export interface OcrLine {
  readonly text: string;
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export type OcrOutcome =
  | { readonly ok: true; readonly lines: readonly OcrLine[]; readonly debug?: string }
  | { readonly ok: false; readonly error: string };

export type OcrLoadResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * 资源包里 OCR 模型可能的层级，按优先级排列。
 * MaaAssistantArknights 的布局是 `<根>/model/ocr`；自家整理过的包可能只到 `model`。
 */
export function ocrModelCandidates(resourceDir: string): string[] {
  const root = resourceDir.trim().replace(/[\\/]+$/, '');
  if (!root) return [];
  return [join(root, 'model', 'ocr'), join(root, 'model'), root];
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

/** 一次加载、多次识别的 OCR 句柄；失败原因缓存，不在每次调用重试。 */
export class ArknightsOcr {
  private resource: MaaResourceLike | null = null;
  private tasker: MaaTaskerLike | null = null;
  private failure: string | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly maa: MaaModule,
    private readonly controller: MaaControllerLike,
    private readonly info: (line: string) => void = () => {},
  ) {}

  /** `null` 表示还没试过；用于回执里区分「没开」和「加载失败」。 */
  get status(): 'idle' | 'ready' | 'failed' {
    if (this.resource && this.tasker) return 'ready';
    return this.failure ? 'failed' : 'idle';
  }

  get ready(): boolean {
    return this.status === 'ready';
  }

  async load(resourceDir: string): Promise<OcrLoadResult> {
    if (this.ready) return { ok: true };
    if (this.failure) return { ok: false, error: this.failure };
    this.loading ??= this.loadModel(resourceDir);
    await this.loading;
    this.loading = null;
    return this.failure ? { ok: false, error: this.failure } : { ok: true };
  }

  private async loadModel(resourceDir: string): Promise<void> {
    const { Resource, Tasker } = this.maa;
    if (!Resource || !Tasker) {
      this.failure = '当前 @maaxyz/maa-node 没有导出 Resource / Tasker，这台机器上无法做 OCR。';
      return;
    }

    const candidates = ocrModelCandidates(resourceDir);
    if (candidates.length === 0) {
      this.failure = '配置 worlds.arknights.resourceDir 为空，无法加载 OCR 模型。';
      return;
    }

    for (const path of candidates) {
      let resource: MaaResourceLike | null = null;
      try {
        resource = new Resource();
        const job = await withTimeout(
          Promise.resolve(resource.post_ocr_model(path).wait()),
          MODEL_LOAD_TIMEOUT_MS,
          '加载 OCR 模型',
        );
        if (job.succeeded && resource.loaded) {
          const tasker = new Tasker();
          tasker.resource = resource;
          tasker.controller = this.controller;
          this.resource = resource;
          this.tasker = tasker;
          this.info(`OCR 模型加载自 ${path}`);
          return;
        }
      } catch (error) {
        this.failure = `加载 OCR 模型失败：${errorText(error)}`;
      }
      try {
        resource?.destroy();
      } catch {
        // 销毁失败没有后续可做，保留原因更有意义。
      }
    }

    this.failure ??= `没找到可用的 OCR 模型：试过 ${candidates.join('、')}。`
      + 'resourceDir 应指向 MAA 资源包根目录（内含 model/ocr）。';
  }

  async recognize(png: Uint8Array, frameSize?: readonly [number, number]): Promise<OcrOutcome> {
    const tasker = this.tasker;
    if (!tasker) return { ok: false, error: this.failure ?? 'OCR 还没加载，先调用一次识别。' };

    const size = frameSize ?? (() => {
      const read = pngSize(png);
      return read ? ([read.width, read.height] as const) : null;
    })();
    if (!size) return { ok: false, error: '识别失败：读不出这一帧的像素尺寸。' };

    let job: MaaTaskJobLike;
    try {
      // 绑定的 ImageData 是 ArrayBuffer；`slice()` 保证拿到的是一段连续的、属于本帧的缓冲。
      const image = png.slice().buffer as ArrayBuffer;
      job = tasker.post_recognition('OCR', { roi: [0, 0, size[0], size[1]], only_rec: false }, image);
      const done = await withTimeout(Promise.resolve(job.wait()), RECO_TIMEOUT_MS, 'OCR 识别');
      if (!done.succeeded) return { ok: false, error: `识别失败：控制器返回失败（状态码 ${String(done.status)}）。` };
    } catch (error) {
      return { ok: false, error: `识别失败：${errorText(error)}` };
    }

    const lines = toOcrLines(this.pickDetail(tasker, job), size);
    return lines.length > 0
      ? { ok: true, lines }
      : { ok: true, lines, debug: '识别完成，但结果里没有带文字的条目' };
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

  dispose(): void {
    try {
      this.tasker?.destroy();
    } catch {
      // 同上：销毁失败不影响下一次连接重建。
    }
    try {
      this.resource?.destroy();
    } catch {
      // 同上。
    }
    this.tasker = null;
    this.resource = null;
    this.failure = null;
    this.loading = null;
  }
}
