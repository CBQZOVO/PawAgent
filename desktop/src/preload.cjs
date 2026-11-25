// preload：把原生能力安全地暴露给渲染进程（window.pawDesktop）。
// contextIsolation 开启，渲染进程拿不到 Node API，只能用这里白名单的方法。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pawDesktop', {
  isDesktop: true,
  platform: process.platform, // 'darwin' → 前端给红绿灯留位 + 拖拽区
  /** 弹 macOS 原生文件夹选择器，返回选中绝对路径（取消返回 null） */
  pickFolder: () => ipcRenderer.invoke('paw:pickFolder'),
  /** 在 Finder（macOS）/ 文件管理器里显示指定文件或目录 */
  reveal: (target) => ipcRenderer.invoke('paw:reveal', target),
  /** 内置浏览器打不开时显式用系统浏览器打开（http/https） */
  openExternal: (url) => ipcRenderer.invoke('paw:openExternal', url),
  /** 系统通知：桌面版由 App 自己发，带 Paw 图标，点一下回到窗口 */
  notify: (payload) => ipcRenderer.invoke('paw:notify', payload),
  /** Electron 拦下的 target=_blank 链接：交给渲染进程打开内置浏览器标签 */
  onOpenUrl: (cb) => {
    const listener = (_e, url) => cb(url);
    ipcRenderer.on('paw:open-url', listener);
    return () => ipcRenderer.removeListener('paw:open-url', listener);
  },
  /** Electron 33 起 File.path 不再暴露；用官方 API 取拖入/上传文件的本机路径 */
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return undefined; }
  },
});
