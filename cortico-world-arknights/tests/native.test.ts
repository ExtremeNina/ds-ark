import { describe, it, expect } from 'vitest';
import { unwrapMaaModule } from '../src/mfw/native.ts';

const controller = class {} as unknown as never;

describe('原生模块形状', () => {
  it('具名导出直接用', () => {
    const mod = { Win32Controller: controller };
    expect(unwrapMaaModule(mod).Win32Controller).toBe(controller);
  });

  it('CJS 包被 import() 包成 { default } 时取 default', () => {
    // @maaxyz/maa-node 的 module.exports 是动态挂载的，ESM 只看得见 default。
    const mod = { default: { Win32Controller: controller } };
    expect(unwrapMaaModule(mod).Win32Controller).toBe(controller);
  });

  it('两种形状都没有 Win32Controller 时给出可读原因', () => {
    expect(() => unwrapMaaModule({})).toThrow(/没有导出 Win32Controller/);
    expect(() => unwrapMaaModule({ default: {} })).toThrow(/没有导出 Win32Controller/);
  });
});
