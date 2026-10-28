/**
 * 原生运行时：`Resource` 与 `Tasker` 的唯一持有者。
 *
 * OCR 与 pipeline 共用同一个 Tasker：OCR 模型约 20 MB，加载两次既慢又占内存。
 * 两条能力各自独立降级——没有 `post_bundle` 只是没 pipeline，没有模型只是没识别，
 * 都不影响连接与点击。
 */
import { fileURLToPath } from 'node:url';
import type { MaaControllerLike, MaaModule, MaaResourceLike, MaaTaskerLike } from './native.ts';
import {
  builtinOcrModelDir,
  missingModelFiles,
  ocrModelCandidates,
  type OcrLoadResult,
} from './ocr.ts';
import { errorText, withTimeout } from './timeout.ts';

const MODEL_LOAD_TIMEOUT_MS = 30_000;
const BUNDLE_LOAD_TIMEOUT_MS = 15_000;

/** 包内 pipeline 资源根（`assets/resource`，下面有 `pipeline/` 与 `model/ocr/`）。 */
export function builtinPipelineBundleDir(): string {
  return fileURLToPath(new URL('../../assets/resource', import.meta.url));
}

export class ArknightsRuntime {
  private resource: MaaResourceLike | null = null;
  private tasker: MaaTaskerLike | null = null;
  private ocrLoaded = false;
  private ocrError: string | null = null;
  private bundleReady = false;
  private bundleError: string | null = null;
  private ocrLoading: Promise<void> | null = null;
  private bundleLoading: Promise<void> | null = null;

  constructor(
    private readonly maa: MaaModule,
    private readonly controller: MaaControllerLike,
    private readonly info: (line: string) => void = () => {},
    /** 内置模型目录，测试可注入临时目录；生产走包内 assets。 */
    private readonly builtinDir: string = builtinOcrModelDir(),
    /** pipeline 资源根，测试可注入；生产走包内 assets。 */
    private readonly bundleDir: string = builtinPipelineBundleDir(),
  ) {}

  get taskerInstance(): MaaTaskerLike | null {
    return this.tasker;
  }

  get ocrReady(): boolean {
    return this.ocrLoaded && this.tasker !== null;
  }

  get ocrStatus(): 'idle' | 'ready' | 'failed' {
    if (this.ocrReady) return 'ready';
    return this.ocrError ? 'failed' : 'idle';
  }

  get ocrFailure(): string | null {
    return this.ocrError;
  }

  get pipelineReady(): boolean {
    return this.bundleReady;
  }

  get pipelineFailure(): string | null {
    return this.bundleError;
  }

  /** 创建一次 Resource/Tasker；失败时留下可读原因，后续调用直接复用。 */
  private ensureTasker(): boolean {
    if (this.tasker) return true;
    const { Resource, Tasker } = this.maa;
    if (!Resource || !Tasker) {
      this.ocrError ??= '当前 @maaxyz/maa-node 没有导出 Resource / Tasker，这台机器上无法做 OCR。';
      return false;
    }
    try {
      const resource = new Resource();
      const tasker = new Tasker();
      tasker.resource = resource;
      tasker.controller = this.controller;
      this.resource = resource;
      this.tasker = tasker;
      return true;
    } catch (error) {
      this.ocrError ??= `无法创建 Resource / Tasker：${errorText(error)}`;
      return false;
    }
  }

  /** 幂等加载 OCR 模型；成功或失败都只尝试一次。 */
  async ensureOcrModel(resourceDir: string): Promise<OcrLoadResult> {
    if (this.ocrReady) return { ok: true };
    if (this.ocrError) return { ok: false, error: this.ocrError };
    this.ocrLoading ??= this.loadOcrModel(resourceDir);
    await this.ocrLoading;
    this.ocrLoading = null;
    return this.ocrError ? { ok: false, error: this.ocrError } : { ok: true };
  }

  private async loadOcrModel(resourceDir: string): Promise<void> {
    if (!this.ensureTasker()) return;
    const resource = this.resource!;
    const candidates = ocrModelCandidates(resourceDir, this.builtinDir);

    let lastError: string | null = null;
    const incomplete: string[] = [];
    for (const path of candidates) {
      // 先自己验三件套：`lazy_load` 只按文件名递归判断、不看大小，空文件或半包会被当成
      // 「加载成功」，直到识别时才 0 行。缺件直接跳过，并把缺哪个文件写进失败原因。
      const missing = missingModelFiles(path);
      if (missing.length > 0) {
        incomplete.push(`${path}（缺 ${missing.join('、')}）`);
        continue;
      }
      try {
        const job = await withTimeout(
          Promise.resolve(resource.post_ocr_model(path).wait()),
          MODEL_LOAD_TIMEOUT_MS,
          '加载 OCR 模型',
        );
        if (job.succeeded && resource.loaded) {
          this.ocrLoaded = true;
          this.info(`OCR 模型加载自 ${path}`);
          return;
        }
        lastError ??= `加载返回失败（状态码 ${String(job.status)}）`;
      } catch (error) {
        lastError = errorText(error);
      }
    }

    // 试过的路径、各自缺哪个文件、最后一次报错：排障缺一不可。
    const reason = lastError ? `（最后一次失败：${lastError}）` : '';
    const noFiles = incomplete.length > 0 ? `；${incomplete.join('；')}` : '';
    this.ocrError = `没找到可用的 OCR 模型：试过 ${candidates.join('、')}${noFiles}${reason}。`
      + '模型目录里必须平铺 det.onnx、rec.onnx、keys.txt 三个文件。';
  }

  /** 幂等加载自有 pipeline 资源包；没有 `post_bundle` 时给出可读原因。 */
  async ensureBundle(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.bundleReady) return { ok: true };
    if (this.bundleError) return { ok: false, error: this.bundleError };
    this.bundleLoading ??= this.loadBundle();
    await this.bundleLoading;
    this.bundleLoading = null;
    return this.bundleReady
      ? { ok: true }
      : { ok: false, error: this.bundleError ?? 'pipeline 资源加载失败。' };
  }

  private async loadBundle(): Promise<void> {
    if (!this.ensureTasker()) {
      this.bundleError = this.ocrError ?? '原生模块不可用，无法加载 pipeline 资源。';
      return;
    }
    const resource = this.resource!;
    if (typeof resource.post_bundle !== 'function') {
      this.bundleError = '当前 @maaxyz/maa-node 的 Resource 没有提供 post_bundle，无法加载 pipeline 资源。';
      return;
    }
    try {
      const job = await withTimeout(
        Promise.resolve(resource.post_bundle(this.bundleDir).wait()),
        BUNDLE_LOAD_TIMEOUT_MS,
        '加载 pipeline 资源',
      );
      if (!job.succeeded) {
        this.bundleError = `加载 pipeline 资源失败（状态码 ${String(job.status)}）：${this.bundleDir}`;
        return;
      }
      this.bundleReady = true;
      this.info(`pipeline 资源加载自 ${this.bundleDir}`);
    } catch (error) {
      this.bundleError = `加载 pipeline 资源失败：${errorText(error)}`;
    }
  }

  dispose(): void {
    try {
      this.tasker?.destroy();
    } catch {
      // 销毁失败不影响下一次连接重建。
    }
    try {
      this.resource?.destroy();
    } catch {
      // 同上。
    }
    this.tasker = null;
    this.resource = null;
    this.ocrLoaded = false;
    this.ocrError = null;
    this.bundleReady = false;
    this.bundleError = null;
    this.ocrLoading = null;
    this.bundleLoading = null;
  }
}
