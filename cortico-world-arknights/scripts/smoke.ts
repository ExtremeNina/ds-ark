/**
 * 真机冒烟：绕开 Coopanion，直接验「窗口枚举 → 截图 → 点击」这条链路。
 *
 *   pnpm smoke          找窗口、打印分辨率、存一张 png，不点击
 *   pnpm smoke --click  额外对配置的暂停坐标点一次
 *
 * 不联网、不读任何密钥；图片只写到当前目录，方便肉眼看截图对不对。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARKNIGHTS_DEFAULTS } from '../src/config.ts';
import { toPoint } from '../src/mfw/geometry.ts';
import { screenshotName } from '../src/mfw/screen.ts';
import { ArknightsSession } from '../src/mfw/session.ts';

const click = process.argv.includes('--click');
const session = new ArknightsSession();

const connected = await session.connect({ ...ARKNIGHTS_DEFAULTS, enabled: true });
if (!connected.ok) {
  console.error(`连接失败：${connected.error}`);
  process.exitCode = 1;
} else {
  const [width, height] = connected.resolution;
  console.log(`窗口：「${connected.window.windowName}」（类名 ${connected.window.className}）`);
  console.log(`分辨率：${width}×${height}`);

  const shot = await session.screencap();
  if (!shot.ok) {
    console.error(`截图失败：${shot.error}`);
    process.exitCode = 1;
  } else {
    const file = join(process.cwd(), screenshotName(new Date()));
    writeFileSync(file, shot.png);
    console.log(`截图已保存：${file}（${shot.png.byteLength} 字节）`);
    console.log('打开这张图确认画面不是全黑、也不是别的窗口。');
  }

  if (click) {
    const { x, y } = toPoint(ARKNIGHTS_DEFAULTS.pauseButton, [width, height]);
    const clicked = await session.click(x, y);
    console.log(clicked.ok ? `已向 (${x}, ${y}) 发送一次点击，去游戏里看暂停键是否响应。` : `点击失败：${clicked.error}`);
    if (!clicked.ok) process.exitCode = 1;
  } else {
    console.log('未发送点击。要试点击请跑：pnpm smoke --click');
  }
}

await session.stop();
