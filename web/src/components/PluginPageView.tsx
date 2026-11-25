import { useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { PluginPageInfo } from '../api/client';

/** 外部插件自定义页面容器：顶栏提供标题与刷新，主体全高同源 iframe */
export default function PluginPageView({ page }: { page: PluginPageInfo }) {
  const [reloadKey, setReloadKey] = useState(0);
  const src = reloadKey > 0
    ? `${page.url}${page.url.includes('?') ? '&' : '?'}_r=${reloadKey}`
    : page.url;

  return (
    <div className="plugin-page-shell">
      <header className="topbar plugin-page-topbar">
        <span className="top-title">{page.label}</span>
        <span className="top-sub">插件：{page.pluginName}</span>
        <div className="plugin-page-actions">
          <button
            className="mcp-refresh"
            onClick={() => setReloadKey((k) => k + 1)}
            title="刷新页面"
          >
            <RefreshCw size={13} /> 刷新
          </button>
          <a
            className="mcp-refresh"
            href={page.url}
            target="_blank"
            rel="noreferrer"
            title="在新标签页打开"
          >
            <ExternalLink size={13} /> 新窗口
          </a>
        </div>
      </header>
      <iframe
        key={`${page.key}:${reloadKey}`}
        className="plugin-page-iframe"
        src={src}
        title={page.label}
      />
    </div>
  );
}
