import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import TokenGate from './components/TokenGate';
import { getTokenStatus, type TokenStatus } from './api/client';
import './styles/editor-theme.css';
import './styles.css';

// Electron 桌面版（macOS）：hiddenInset 标题栏 → 红绿灯内嵌侧栏顶部。
// 加 class 让 CSS 给红绿灯留位、把顶部空白区设为窗口拖拽区；浏览器版完全不受影响。
const desktop = (window as unknown as { pawDesktop?: { platform?: string } }).pawDesktop;
if (desktop?.platform === 'darwin') document.documentElement.classList.add('paw-mac');

// 编辑器主题（GitHub Light 默认 / Dark 可选）：启动即应用，避免首帧闪色
document.documentElement.setAttribute('data-editor-theme',
  localStorage.getItem('paw-editor-theme') === 'dark' ? 'dark' : 'light');

/** 网关 token 门：未配置（文件不存在或空）时先让用户填，保存后进入主界面 */
function Root() {
  // null = 检测中；configured=true 直接进；false 显示配置页
  const [status, setStatus] = useState<TokenStatus | null>(null);
  useEffect(() => {
    getTokenStatus()
      .then(setStatus)
      .catch(() => setStatus({ configured: true, file: '~/.paw/gateway-config.json' })); // 接口不通时放行，避免卡死
  }, []);
  if (!status) return <div className="token-boot"><Loader /></div>;
  if (!status.configured) {
    return <TokenGate status={status} onDone={() => {
      void getTokenStatus().then(setStatus).catch(() => setStatus({ ...status, configured: true }));
    }} />;
  }
  return <App
    gatewayBaseUrl={status.baseUrl}
    onLogout={() => setStatus({ ...status, configured: false })}
  />;
}
function Loader() {
  return <div className="token-boot-inner"><span className="spin">◌</span> 正在启动…</div>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
