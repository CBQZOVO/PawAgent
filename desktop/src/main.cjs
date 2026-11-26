// Paw Electron 主进程：
// 1. spawn tsx 拉起现有 server 子进程（浏览器版同款，不改 server 架构）
// 2. BrowserWindow 加载 http://127.0.0.1:8787（server 托管 web/dist）
// 3. preload 暴露原生能力（选文件夹等），后续本地工具都走这条 IPC 通道
// 4. 窗口全关 / app 退出时杀掉 server 子进程，不留孤儿
const { app, BrowserWindow, ipcMain, dialog, screen, shell, Notification } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// 开发模式：先清掉宿主可能注入的 ELECTRON_RUN_AS_NODE（跟 run.cjs 一致）
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.NODE_OPTIONS;

// 打包后 app 布局为 Contents/Resources/app/{desktop,server,web}，
// __dirname = Resources/app/desktop/src → ROOT = Resources/app；
// 开发时 __dirname = <项目>/desktop/src → ROOT = <项目>。两种布局相对关系一致。
const ROOT = path.resolve(__dirname, '../..');
const APP_ICON = path.join(__dirname, '../assets/Paw.png'); // Dock/窗口用 PNG；打包用 assets/Paw.icns
const SERVER_PORT = Number(process.env.PAW_PORT || 8787);
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
let serverProc = null;
let win = null;

app.setName('Paw');

function startServer() {
  // 已在跑（比如用户手动起了浏览器版 server）就复用，不重复拉起
  return new Promise((resolve) => {
    const probe = http.get(`${SERVER_URL}/api/health`, (res) => {
      res.resume();
      console.log('[desktop] 检测到已有 server，复用');
      resolve(true);
    });
    probe.on('error', () => resolve(false));
    probe.setTimeout(1500, () => { probe.destroy(); resolve(false); });
  }).then((exists) => {
    if (exists) return;
    // 用编译后的纯 JS（server/dist/index.js），不依赖 tsx/esbuild 运行时转译。
    // 打包时 server/dist 和 shared/dist 会一起打进去；开发时若没编译，回落到 tsx 跑源码。
    const builtIndex = path.join(ROOT, 'server/dist/index.js');
    const devTsxCli = path.join(ROOT, 'server/node_modules/tsx/dist/cli.mjs');
    const useBuilt = fs.existsSync(builtIndex);
    // 用随包携带的 node 二进制，不用 process.execPath（那是 Electron 本体，跑 .mjs 会被当 app 启动）；
    // 开发时没这个内置 node，回落到 PATH 里的 node。Windows 的二进制叫 node.exe。
    const bundledNode = path.join(ROOT, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
    const nodeExe = fs.existsSync(bundledNode) ? bundledNode : 'node';
    const serverArgs = useBuilt ? [builtIndex] : [devTsxCli, 'src/index.ts'];
    // server 会自行读取 ~/.paw/gateway-config.json（优先于环境变量 GATEWAY_URL/GATEWAY_KEY）
    serverProc = spawn(nodeExe, serverArgs, {
      cwd: path.join(ROOT, 'server'),
      env: { ...process.env, PORT: String(SERVER_PORT) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 从 Finder 双击启动时 process.stdout 管道不存在，直接 write 会 EPIPE 崩主进程。
    // 用 console + try/catch 兜底，同时落日志文件方便排查。
    const LOG = path.join(ROOT, 'server.log');
    const log = (tag, d) => {
      const line = `[${tag}] ${d}`;
      try { process.stdout.write(line); } catch { /* 双击启动无 stdout，忽略 */ }
      try { fs.appendFileSync(LOG, line); } catch { /* 只读包等情况忽略 */ }
    };
    serverProc.stdout.on('data', (d) => log('server', d));
    serverProc.stderr.on('data', (d) => log('server-err', d));
    serverProc.on('exit', (code) => {
      console.log(`[desktop] server 退出 code=${code}`);
      serverProc = null;
    });
    // 等 server 就绪（最多 20s）
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const probe = http.get(`${SERVER_URL}/api/health`, (res) => { res.resume(); resolve(); });
        probe.on('error', () => {
          if (Date.now() - t0 > 20000) { console.error('[desktop] server 启动超时'); resolve(); }
          else setTimeout(tick, 500);
        });
      };
      tick();
    });
  });
}

function killServer() {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
    serverProc = null;
  }
}

// 默认窗口大小：2560x1440。
// 显示器装不下就铺满光标所在屏幕的可用工作区（等效全屏）；
// 显示器够大就用 2560x1440。
function resolveWindowBounds() {
  const DEFAULT_WIDTH = 2560;
  const DEFAULT_HEIGHT = 1440;

  // 优先用光标所在显示器的工作区尺寸判断；无显示器（罕见）时退化为默认尺寸
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display ? display.workArea : null;
  if (wa && (wa.width < DEFAULT_WIDTH || wa.height < DEFAULT_HEIGHT)) {
    return { width: wa.width, height: wa.height }; // 铺满可用工作区
  }
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

async function createWindow() {
  await startServer();
  win = new BrowserWindow({
    ...resolveWindowBounds(),
    minWidth: 900,
    minHeight: 600,
    title: 'Paw',
    icon: APP_ICON,
    backgroundColor: '#f3f6fb',
    // WorkBuddy 同款：隐藏原生标题栏，红绿灯内嵌到侧栏顶部，侧栏背景直达窗口顶
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      // y=20：54px 高的顶栏里垂直居中（灯高 14），跟标题文字同一条中线
      trafficLightPosition: { x: 14, y: 20 },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 内置浏览器用 <webview> 加载网页：iframe 会被目标站点的 X-Frame-Options/CSP 拦住
      webviewTag: true,
    },
  });
  win.loadURL(SERVER_URL);

  // 拖文件到窗口空白处时，Electron 默认把页面导航到 file:// ——
  // 用户看到的就是「拖进来一个文件，界面突然变成文件内容/白屏」。
  // 只允许留在自己的 server 页面，其它导航一律拦掉（2026-11-22 用户报的）。
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(SERVER_URL)) {
      e.preventDefault();
      console.warn('[paw] 已阻止导航到', url);
    }
  });
  // target=_blank / window.open：不在系统浏览器里开，转给渲染进程的内置浏览器面板
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) win.webContents.send('paw:open-url', url);
    return { action: 'deny' };
  });

  // 渲染进程崩溃兜底。
  // Electron 默认什么都不做：renderer 一挂，窗口就永远白着，只能手动退出重开
  // （2026-11-22 用户「用着用着白屏了」，日志是 EXC_BREAKPOINT + cppgc::internal::Fatal，
  //  即 Blink 堆分配失败，跟具体业务代码无关）。
  // 这里自动 reload；但同一分钟内崩 3 次以上就不再重试，避免页面本身有问题时无限刷新。
  let crashTimes = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[paw] 渲染进程退出：${details.reason}（exitCode=${details.exitCode}）`);
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < 60_000);
    crashTimes.push(now);
    if (crashTimes.length > 3) {
      console.error('[paw] 一分钟内反复崩溃，停止自动重载（请看控制台错误）');
      // 别再留白屏，给一句人话 + 出路
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<body style="font:14px -apple-system,BlinkMacSystemFont,sans-serif;padding:48px;color:#2D2F33;background:#fff">'
        + '<h2 style="margin:0 0 12px">界面崩溃了</h2>'
        + '<p style="margin:0 0 8px;line-height:1.7">已经自动重新加载 3 次仍然崩溃，先停在这里。</p>'
        + '<p style="margin:0;color:#747B8B;line-height:1.7">请退出 Paw 后重新打开；如果反复出现，把控制台日志发给开发者。</p>'
        + '</body>'));
      return;
    }
    console.log('[paw] 自动重载界面…');
    win.reload();
  });

  win.on('closed', () => { win = null; });
}

// ===== 原生能力 IPC（后续本地工具都加在这里）=====
// 选文件夹：返回选中绝对路径，取消返回 null
ipcMain.handle('paw:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 Paw 工作区目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
// 在 Finder / 文件管理器里显示指定路径（Tab 右键菜单用）
ipcMain.handle('paw:reveal', async (_e, target) => {
  if (typeof target === 'string' && target) shell.showItemInFolder(target);
});
// 内置浏览器里打不开的站点：显式交给系统浏览器（只放行 http/https）
ipcMain.handle('paw:openExternal', async (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});
// 系统通知：由 App 自己发，通知栏才是 Paw 的图标和应用名（osascript 发的身份不可控）。
// 点一下把窗口叫回前台——这是 osascript 做不到的。
ipcMain.handle('paw:notify', (_e, payload) => {
  if (!Notification.isSupported()) return;
  const title = typeof payload?.title === 'string' ? payload.title : 'Paw';
  const body = typeof payload?.body === 'string' ? payload.body : '';
  const n = new Notification({ title, body, icon: APP_ICON });
  n.on('click', () => {
    app.focus({ steal: true });
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  n.show();
});

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.paw.desktop');
  if (process.platform === 'darwin') app.dock.setIcon(APP_ICON);
  await createWindow();
});
app.on('window-all-closed', () => {
  killServer();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
app.on('before-quit', killServer);
process.on('exit', killServer);
