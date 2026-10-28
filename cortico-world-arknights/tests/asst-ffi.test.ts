import { describe, expect, it } from 'vitest';
import { findMaaCoreDir, loadMaaCoreLib } from '../src/mfw/asst-ffi.ts';

describe('Asst FFI 原生加载器', () => {
  it('findMaaCoreDir 能正确探测有效 MAA 安装目录', () => {
    const dir = findMaaCoreDir('D:/soft/MAA-v6');
    expect(dir).toBe('D:/soft/MAA-v6');

    // 传入 resource 子目录时自动回退根目录
    const fromSub = findMaaCoreDir('D:/soft/MAA-v6/resource');
    expect(fromSub).toBe('D:/soft/MAA-v6');

    // 虚假目录返回 null
    expect(findMaaCoreDir('C:/NonExistentPath_Maa_12345')).toBeNull();
  });

  it('loadMaaCoreLib 真实加载 MaaCore.dll 获取版本与生命周期', () => {
    const lib = loadMaaCoreLib('D:/soft/MAA-v6');
    if (!lib) {
      // 机器未安装时跳过
      return;
    }
    expect(lib.version).toMatch(/v\d+/);

    const handle = lib.create();
    expect(handle).not.toBeNull();
    lib.destroy(handle);
  });
});
