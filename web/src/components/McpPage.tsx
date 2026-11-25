import { useEffect, useState } from 'react';
import { ChevronRight, Plug, RefreshCw, Search, Server, X } from 'lucide-react';

interface McpTool { name: string; description: string }
interface McpServerView {
  name: string;
  status: 'connecting' | 'connected' | 'failed';
  transport: 'HTTP' | 'STDIO';
  source: string;
  target: string;
  toolCount: number;
  error?: string;
}
interface McpStatus { servers: string[]; views?: McpServerView[]; tools: McpTool[] }

type Filter = 'all' | 'mcp' | 'http' | 'sse' | 'stdio';

/** MCP 管理页：卡片式 server 列表 + 筛选 + 点卡片看工具（配置仍手动改文件） */
export default function McpPage() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    fetch('/api/mcp').then((r) => r.json())
      .then((d: McpStatus) => setStatus({
        ...d,
        // 老后端没有 views 时，用已连接名单兜底
        views: d.views?.length ? d.views : (d.servers || []).map((name) => ({
          name, status: 'connected' as const, transport: 'STDIO' as const,
          source: '', target: '', toolCount: (d.tools || []).filter((t) => t.name.startsWith(`${name}__`)).length,
        })),
      }))
      .catch(() => setStatus({ servers: [], views: [], tools: [] }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const byServer: Record<string, McpTool[]> = {};
  for (const t of status?.tools || []) {
    const s = t.name.split('__')[0] || '其它';
    (byServer[s] ||= []).push(t);
  }

  const views = status?.views || [];
  const filtered = views.filter((v) => {
    if (!v.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === 'all' || filter === 'mcp') return true;
    if (filter === 'http') return v.transport === 'HTTP';
    if (filter === 'stdio') return v.transport === 'STDIO';
    return false; // sse: 暂无
  });
  const connected = views.filter((v) => v.status === 'connected').length;

  return (
    <div className="manage-page">
      <header className="topbar">
        <span className="top-title"><Plug size={16} /> MCP 服务</span>
        <span className="top-sub">{views.length} 个服务（{connected} 已连接）· {status?.tools.length || 0} 个工具</span>
      </header>
      <div className="manage-body">
        <div className="mcp-toolbar">
          <div className="mcp-tabs">
            {(['all', 'mcp', 'http', 'sse', 'stdio'] as Filter[]).map((f) => (
              <button key={f} className={'mcp-tab' + (filter === f ? ' active' : '')} onClick={() => setFilter(f)}>
                {f === 'all' ? '全部' : f.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="manage-search"><Search size={14} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索" /></div>
          <button className="mcp-refresh" onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /> 刷新</button>
        </div>

        <div className="mcp-grid">
          {filtered.map((v) => (
            <button className="mcp-card" key={v.name} onClick={() => setActive(v.name)}>
              <div className="mcp-card-top">
                <span className="mcp-card-icon"><Server size={15} /></span>
                <span className="mcp-card-title">{v.name}</span>
                <span className={'mcp-card-badge' + (v.status !== 'connected' ? ' inactive' : '')}>
                  {v.status === 'connected' ? '已连接' : v.status === 'failed' ? '连接失败' : '连接中'}
                </span>
              </div>
              <div className="mcp-card-url" title={v.target}>{v.target || v.source}</div>
              <div className="mcp-card-foot">
                <span className={'mcp-card-status' + (v.status !== 'connected' ? ' inactive' : '')}>
                  <span className="dot" /> {v.status === 'connected' ? '运行中' : v.status === 'failed' ? '不可用' : '连接中'}
                </span>
                <span className="mcp-card-type">{v.transport}</span>
                <span className="mcp-card-count">{v.status === 'connected' ? `${v.toolCount} 个工具` : (v.source || '未配置')}</span>
              </div>
              <ChevronRight size={15} className="mcp-card-arrow" />
            </button>
          ))}
          {filtered.length === 0 && <div className="side-empty">没有匹配的 MCP 服务</div>}
        </div>
      </div>

      {active && (
        <div className="modal-backdrop" onClick={() => setActive(null)}>
          <div className="modal mcp-detail" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span><Server size={15} /> {active} · 工具列表</span>
              <button onClick={() => setActive(null)}><X size={15} /></button>
            </div>
            <div className="modal-body">
              {(() => {
                const v = views.find((x) => x.name === active);
                return <>
                  {v?.status === 'failed' && <div className="mcp-detail-error">连接失败：{v.error || '未知原因'}<br />请检查 <code>{v.source}</code> 中的配置，修改后重启 Paw。</div>}
                  <div className="mcp-detail-hint">共 {(byServer[active] || []).length} 个工具。配置请编辑 <code>~/paw-mcp.json</code>（HTTP）或 <code>~/.workbuddy/mcp.json</code>（stdio），重启生效。</div>
                  <div className="mcp-tool-tags">
                    {(byServer[active] || []).map((t) => (
                      <span className="mcp-tool-tag" key={t.name} title={t.name}>{t.name.replace(/^[^_]+__/, '')}</span>
                    ))}
                  </div>
                </>;
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
