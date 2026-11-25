import { useEffect, useState } from 'react';
import { Boxes, ChevronRight, Package, Power, RefreshCw, Search, X } from 'lucide-react';
import {
  getPlugins,
  reloadPlugins,
  updatePlugin,
  type PluginInventory,
} from '../api/client';

type Filter = 'all' | 'external' | 'builtin';

interface PluginCardItem {
  key: string;
  kind: 'builtin' | 'external';
  name: string;
  dir?: string;
  version?: string;
  description?: string;
  entry?: string;
  status: 'active' | 'disabled' | 'failed';
  tools: string[];
  config?: Record<string, unknown>;
  error?: string;
}

export default function PluginsPage() {
  const [inv, setInv] = useState<PluginInventory | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState('');
  const [configError, setConfigError] = useState('');
  const [saveNotice, setSaveNotice] = useState('');

  const load = (reload = false) => {
    setLoading(true);
    (reload ? reloadPlugins() : getPlugins())
      .then(setInv)
      .catch(() => setInv({ pluginsDir: '', builtin: [], external: [], disabled: [], skipped: [], failed: [] }))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(false); }, []);

  const items: PluginCardItem[] = [];
  if (inv) {
    for (const p of inv.external || []) {
      items.push({
        key: `ext:${p.dir}`,
        kind: 'external',
        name: p.name,
        dir: p.dir,
        version: p.version,
        description: p.description,
        entry: p.entry,
        status: 'active',
        tools: p.tools || [],
        config: p.config || {},
      });
    }
    for (const p of inv.disabled || []) {
      items.push({
        key: `ext:${p.dir}`,
        kind: 'external',
        name: p.name,
        dir: p.dir,
        version: p.version,
        description: p.description,
        status: 'disabled',
        tools: [],
        config: p.config || {},
      });
    }
    for (const p of inv.failed || []) {
      items.push({
        key: `ext:${p.dir}`,
        kind: 'external',
        name: p.name || p.dir,
        dir: p.dir,
        version: p.version,
        description: p.description,
        status: 'failed',
        tools: [],
        config: p.config || {},
        error: p.error,
      });
    }
    for (const p of inv.builtin || []) {
      items.push({
        key: `builtin:${p.name}`,
        kind: 'builtin',
        name: p.name,
        version: p.version,
        status: 'active',
        tools: p.tools || [],
      });
    }
  }

  const filtered = items.filter((item) => {
    if (filter !== 'all' && item.kind !== filter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return item.name.toLowerCase().includes(q)
      || (item.dir || '').toLowerCase().includes(q)
      || item.tools.some((t) => t.toLowerCase().includes(q));
  });

  const activeItem = activeKey ? items.find((i) => i.key === activeKey) || null : null;

  const openDetail = (item: PluginCardItem) => {
    setActiveKey(item.key);
    setConfigDraft(JSON.stringify(item.config || {}, null, 2));
    setConfigError('');
    setSaveNotice('');
  };

  const toggleExternal = async (item: PluginCardItem) => {
    if (!item.dir || busyKey) return;
    setBusyKey(item.key);
    try {
      const next = await updatePlugin(item.dir, { enabled: item.status === 'disabled' });
      setInv(next);
    } catch (e) {
      setConfigError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const saveConfig = async () => {
    if (!activeItem?.dir || busyKey) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(configDraft.trim() || '{}');
    } catch (e) {
      setConfigError(`JSON 语法错误：${(e as Error).message}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setConfigError('配置必须是 JSON 对象（例如 {"baseUrl": "..."}）');
      return;
    }
    setBusyKey(activeItem.key);
    setConfigError('');
    setSaveNotice('');
    try {
      const next = await updatePlugin(activeItem.dir, { config: parsed as Record<string, unknown> });
      setInv(next);
      setSaveNotice('已保存并重载插件');
    } catch (e) {
      setConfigError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const externalCount = (inv?.external.length || 0) + (inv?.disabled.length || 0) + (inv?.failed.length || 0);
  const builtinCount = inv?.builtin.length || 0;
  const totalTools = items.reduce((n, i) => n + i.tools.length, 0);

  return (
    <div className="manage-page">
      <header className="topbar">
        <span className="top-title"><Boxes size={16} /> 插件管理</span>
        <span className="top-sub">
          {externalCount} 个外部插件 · {builtinCount} 个内置插件 · {totalTools} 个工具
        </span>
      </header>
      <div className="manage-body">
        <div className="mcp-toolbar">
          <div className="mcp-tabs">
            {([
              ['all', '全部'],
              ['external', `外部 (${externalCount})`],
              ['builtin', `内置 (${builtinCount})`],
            ] as [Filter, string][]).map(([f, label]) => (
              <button key={f} className={'mcp-tab' + (filter === f ? ' active' : '')} onClick={() => setFilter(f)}>
                {label}
              </button>
            ))}
          </div>
          <div className="manage-search">
            <Search size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索插件或工具名" />
          </div>
          <button className="mcp-refresh" onClick={() => load(true)} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> 重新扫描
          </button>
        </div>

        {inv?.pluginsDir && (
          <div className="mcp-detail-hint" style={{ marginBottom: 14 }}>
            外部插件目录：<code>{inv.pluginsDir}</code>（配置文件 <code>plugins.json</code>，修改启停或配置后自动热重载）
          </div>
        )}

        <div className="mcp-grid">
          {filtered.map((item) => (
            <div className="mcp-card" key={item.key} onClick={() => openDetail(item)} role="button" tabIndex={0}>
              <div className="mcp-card-top">
                <span className="mcp-card-icon"><Package size={15} /></span>
                <span className="mcp-card-title">{item.name}</span>
                {item.kind === 'external' ? (
                  <button
                    className={'plugin-toggle' + (item.status === 'disabled' ? ' off' : '')}
                    disabled={busyKey === item.key}
                    title={item.status === 'disabled' ? '点击启用插件' : '点击禁用插件'}
                    onClick={(e) => { e.stopPropagation(); void toggleExternal(item); }}
                  >
                    <Power size={12} />
                    {item.status === 'disabled' ? '已禁用' : item.status === 'failed' ? '失败' : '已启用'}
                  </button>
                ) : (
                  <span className="mcp-card-badge">内置</span>
                )}
              </div>
              <div className="mcp-card-url" title={item.description || item.dir || 'Paw 内置插件'}>
                {item.description || (item.dir ? `目录：${item.dir}` : 'Paw 核心内置插件')}
              </div>
              <div className="mcp-card-foot">
                <span className={'mcp-card-status' + (item.status !== 'active' ? ' inactive' : '')}>
                  <span className="dot" />
                  {item.status === 'active' ? '运行中' : item.status === 'disabled' ? '已禁用' : '加载失败'}
                </span>
                <span className="mcp-card-type">{item.kind === 'external' ? (item.version ? `v${item.version}` : '外部') : 'BUILTIN'}</span>
                <span className="mcp-card-count">{item.tools.length} 个工具</span>
              </div>
              <ChevronRight size={15} className="mcp-card-arrow" />
            </div>
          ))}
          {filtered.length === 0 && <div className="side-empty">没有匹配的插件</div>}
        </div>
      </div>

      {activeItem && (
        <div className="modal-backdrop" onClick={() => setActiveKey(null)}>
          <div className="modal mcp-detail" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span><Package size={15} /> {activeItem.name}{activeItem.version ? ` v${activeItem.version}` : ''}</span>
              <button onClick={() => setActiveKey(null)}><X size={15} /></button>
            </div>
            <div className="modal-body">
              {activeItem.error && (
                <div className="mcp-detail-error">加载失败：{activeItem.error}</div>
              )}
              <div className="mcp-detail-hint">
                {activeItem.kind === 'external'
                  ? <>目录：<code>{activeItem.dir}</code>{activeItem.entry ? <> · 入口：<code>{activeItem.entry}</code></> : null}</>
                  : '内置插件随 Paw 一起加载，提供核心基础工具。'}
              </div>

              <div className="mcp-group-head">
                暴露工具 <span>{activeItem.tools.length} 个</span>
              </div>
              <div className="mcp-tool-tags" style={{ marginBottom: activeItem.kind === 'external' ? 16 : 0 }}>
                {activeItem.tools.length > 0
                  ? activeItem.tools.map((t) => <span className="mcp-tool-tag" key={t}>{t}</span>)
                  : <span className="mcp-detail-hint" style={{ marginBottom: 0 }}>当前未暴露工具</span>}
              </div>

              {activeItem.kind === 'external' && (
                <>
                  <div className="mcp-group-head">
                    插件配置 <span>写入 plugins.json 中的 config 字段</span>
                  </div>
                  <textarea
                    className="plugin-config-editor"
                    value={configDraft}
                    onChange={(e) => { setConfigDraft(e.target.value); setConfigError(''); setSaveNotice(''); }}
                    rows={6}
                    spellCheck={false}
                  />
                  {configError && <div className="mcp-detail-error" style={{ marginTop: 6 }}>{configError}</div>}
                  {saveNotice && <div className="plugin-save-ok">{saveNotice}</div>}
                  <div className="plugin-config-actions">
                    <button
                      className="mcp-refresh"
                      disabled={busyKey === activeItem.key}
                      onClick={() => void toggleExternal(activeItem)}
                    >
                      <Power size={13} /> {activeItem.status === 'disabled' ? '启用插件' : '禁用插件'}
                    </button>
                    <button
                      className="plugin-save-btn"
                      disabled={busyKey === activeItem.key}
                      onClick={() => void saveConfig()}
                    >
                      保存配置并重载
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
