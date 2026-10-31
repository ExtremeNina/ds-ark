import { describe, expect, it } from 'vitest';
import { findMaaCoreDir, loadMaaCoreLib, MAA_WIN32_INPUT, MAA_WIN32_SCREENCAP } from '../src/mfw/asst-ffi.ts';

describe('Asst FFI 原生加载器', () => {
  it('导出的 Win32 输入与截图常量掩码符合 MaaCore 规范', () => {
    expect(MAA_WIN32_INPUT.SendMessageWithCursorPos).toBe(32n);
    expect(MAA_WIN32_INPUT.SendMessage).toBe(2n);
    expect(MAA_WIN32_INPUT.Seize).toBe(1n);
    expect(MAA_WIN32_SCREENCAP.DXGI_OR_GDI).toBe(18n);
  });
  it('findMaaCoreDir 能正确探测有效 MAA 安装目录', () => {
    const dir = findMaaCoreDir('D:/soft/MAA-v6');
    expect(dir).toBe('D:/soft/MAA-v6');

    // 传入 resource 子目录时自动回退根目录
    const fromSub = findMaaCoreDir('D:/soft/MAA-v6/resource');
    expect(fromSub).toBe('D:/soft/MAA-v6');

    // 虚假目录返回 null
    expect(findMaaCoreDir('C:/NonExistentPath_Maa_12345')).toBeNull();
  });

  it('loadMaaCoreLib 真实加载 MaaCore.dll 获取版本与生命周期', async () => {
    const lib = loadMaaCoreLib('D:/soft/MAA-v6');
    if (!lib) {
      // 机器未安装时跳过
      return;
    }
    expect(lib.version).toMatch(/v\d+/);

    const handle = lib.create();
    expect(handle).not.toBeNull();

    // 5 参数安全挂载：即使窗口不存在也不会段错误闪退
    const attached = lib.attachWindow(handle, '0x12345');
    expect(attached).toBe(false);

    await lib.destroy(handle);
  });

  it('loadMaaCoreLib 支持回调与安全异步析构（无死锁）', async () => {
    const lib = loadMaaCoreLib('D:/soft/MAA-v6');
    if (!lib) return;

    let callbackFired = false;
    const handle = lib.create((msg, details) => {
      callbackFired = true;
    });
    expect(handle).not.toBeNull();

    // 销毁时 C++ 发送消息，异步析构不产生主线程死锁
    await lib.destroy(handle);
    expect(callbackFired).toBe(true);
  });
});
