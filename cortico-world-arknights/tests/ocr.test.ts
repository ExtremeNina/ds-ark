import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinOcrModelDir, missingModelFiles, ocrModelCandidates } from '../src/mfw/ocr.ts';

const created: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arknights-ocr-'));
  created.push(dir);
  return dir;
}

/** 造一套三件套；内容无所谓，校验只看存在且非空。 */
function writeModel(dir: string, names: readonly string[] = ['det.onnx', 'rec.onnx', 'keys.txt']): void {
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), 'fake');
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('内置 OCR 模型', () => {
  it('路径解析到包内 assets/resource/model/ocr，且三件套真的在包里', () => {
    const dir = builtinOcrModelDir();
    expect(dir.endsWith(join('assets', 'resource', 'model', 'ocr'))).toBe(true);
    // 发布包里少一个文件，等于没有内置模型：这条断言守住 npm files 配置。
    expect(existsSync(join(dir, 'det.onnx'))).toBe(true);
    expect(existsSync(join(dir, 'rec.onnx'))).toBe(true);
    expect(existsSync(join(dir, 'keys.txt'))).toBe(true);
  });
});

describe('ocrModelCandidates', () => {
  it('没配 resourceDir 时只试内置目录', () => {
    const builtin = join('C:', 'pkg', 'assets', 'resource', 'model', 'ocr');
    expect(ocrModelCandidates('', builtin)).toEqual([builtin]);
    expect(ocrModelCandidates('   ', builtin)).toEqual([builtin]);
  });

  it('配了 resourceDir 时先试其中的 model/ocr，再试目录本身，最后内置', () => {
    const builtin = join('C:', 'pkg', 'assets', 'resource', 'model', 'ocr');
    const root = join('C:', 'models');
    expect(ocrModelCandidates(root, builtin)).toEqual([
      join(root, 'model', 'ocr'),
      root,
      builtin,
    ]);
  });

  it('去掉结尾的斜杠，且同一目录只留一次', () => {
    const builtin = join('C:', 'pkg', 'assets', 'resource', 'model', 'ocr');
    // resourceDir 正好指到内置目录时：根目录本身就等于内置目录，去重后不再重复出现。
    expect(ocrModelCandidates(`${builtin}\\`, builtin)).toEqual([
      join(builtin, 'model', 'ocr'),
      builtin,
    ]);
  });
});

describe('missingModelFiles', () => {
  it('三件套齐全时没有缺件', () => {
    const dir = scratchDir();
    writeModel(dir);
    expect(missingModelFiles(dir)).toEqual([]);
  });

  it('缺 keys.txt 时只报 keys.txt', () => {
    const dir = scratchDir();
    writeModel(dir, ['det.onnx', 'rec.onnx']);
    expect(missingModelFiles(dir)).toEqual(['keys.txt']);
  });

  it('0 字节的文件算缺件', () => {
    const dir = scratchDir();
    writeModel(dir);
    writeFileSync(join(dir, 'det.onnx'), '');
    expect(missingModelFiles(dir)).toEqual(['det.onnx']);
  });

  it('目录不存在时三个都缺', () => {
    expect(missingModelFiles(join(scratchDir(), 'nope'))).toEqual(['det.onnx', 'rec.onnx', 'keys.txt']);
  });
});
