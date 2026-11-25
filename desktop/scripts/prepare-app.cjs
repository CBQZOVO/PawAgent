// 用安装的 Electron 运行时生成一个本地 Paw.app：
// macOS 的 Dock/菜单名称来自 .app 包，只改 app.setName 不够。
// 产物在 desktop/.local/（已 gitignore），首次启动复制约 230MB，之后复用。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROJECT = path.resolve(__dirname, '../..');
const TARGET = path.join(PROJECT, 'desktop/.local/Paw.app');
const PLIST = path.join(TARGET, 'Contents/Info.plist');
const MARKER = path.join(TARGET, '.built-from');

function plistSet(key, value) {
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, PLIST]); }
  catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, PLIST]); }
}

/** 返回 Paw.app 内的可执行文件路径；首次、Electron 或图标变化时重建 */
function ensurePawApp(electronExecutable) {
  const executable = path.join(TARGET, 'Contents/MacOS/Paw');
  const icon = path.join(PROJECT, 'desktop/assets/Paw.icns');
  const iconStat = fs.statSync(icon);
  const stamp = `${electronExecutable}|${iconStat.size}:${Math.round(iconStat.mtimeMs)}`;
  const builtFrom = fs.existsSync(MARKER) ? fs.readFileSync(MARKER, 'utf-8').trim() : '';
  if (fs.existsSync(executable) && builtFrom === stamp) return executable;

  const sourceBundle = path.dirname(path.dirname(path.dirname(electronExecutable)));
  console.log('[desktop] 首次生成 Paw.app 图标/名称…');
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.rmSync(TARGET, { recursive: true, force: true });
  execFileSync('ditto', [sourceBundle, TARGET]);

  const sourceExe = path.join(TARGET, 'Contents/MacOS/Electron');
  if (fs.existsSync(sourceExe)) fs.renameSync(sourceExe, executable);
  plistSet('CFBundleExecutable', 'Paw');
  plistSet('CFBundleName', 'Paw');
  plistSet('CFBundleDisplayName', 'Paw');
  plistSet('CFBundleIdentifier', 'com.paw.desktop');
  plistSet('CFBundleIconFile', 'Paw');
  fs.copyFileSync(icon, path.join(TARGET, 'Contents/Resources/Paw.icns'));
  fs.writeFileSync(MARKER, stamp);
  return executable;
}

module.exports = { ensurePawApp };
