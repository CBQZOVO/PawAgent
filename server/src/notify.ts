// macOS 桌面通知：Agent 一轮跑完后提醒人。
// 只在 macOS 生效；发通知是副作用，任何失败都静默忽略，不影响主流程。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 默认开启；设 PAW_NOTIFY=0/off/false 关闭。 */
function enabled(): boolean {
  const v = (process.env.PAW_NOTIFY || '').trim().toLowerCase();
  return v !== '0' && v !== 'off' && v !== 'false';
}

/** 转成 AppleScript 字符串字面量：先压平换行、限长，再转义反斜杠和双引号。 */
function literal(text: string): string {
  const flat = text.replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, 200);
  return `"${flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 弹一条系统通知，异步发出、不等结果。 */
export function notifyDone(body: string, title = 'Paw'): void {
  if (process.platform !== 'darwin' || !enabled()) return;
  const script = `display notification ${literal(body)} with title ${literal(title)} sound name "Glass"`;
  run('osascript', ['-e', script], { timeout: 5000 }).catch(() => {});
}
