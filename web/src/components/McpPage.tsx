import { useEffect, useState } from 'react';
import { ChevronRight, Download, Loader2, Pencil, Plug, Plus, RefreshCw, Search, Server, Trash2, X } from 'lucide-react';
import ConfirmDialog from './ConfirmDialog';

interface McpTool { name: string; description: string }
interface McpServerConfig {
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  disabled?: boolean;
}
interface McpServerView {
  name: string;
  status: 'connecting' | 'connected' | 'failed' | 'disabled';
  transport: 'HTTP' | 'SSE' | 'STDIO';
  source: string;
  target: string;
  toolCount: number;
  error?: string;
  config?: McpServerConfig;
}
interface McpStatus { servers: string[]; views?: McpServerView[]; tools: McpTool[] }

type Filter = 'all' | 'mcp' | 'http' | 'sse' | 'stdio';

interface KvRow { key: string; value: string }

interface McpDraft {
  originalName?: string;
  name: string;
  type: 'http' | 'sse' | 'stdio';
  url: string;
  headers: KvRow[];
  command: string;
  argsText: string;
  env: KvRow[];
  description: string;
  disabled: boolean;
}

const emptyDraft = (): McpDraft => ({
  name: '',
  type: 'http',
  url: '',
  headers: [{ key: '', value: '' }],
  command: '',
  argsText: '',
  env: [],
  description: '',
  disabled: false,
});

function draftFromView(v: McpServerView): McpDraft {
  const cfg = v.config;
  const type: 'http' | 'sse' | 'stdio' =
    cfg?.type || (v.transport === 'SSE' ? 'sse' : v.transport === 'HTTP' ? 'http' : 'stdio');
  const headerRows = cfg?.headers ? Object.entries(cfg.headers).map(([key, value]) => ({ key, value })) : [];
  return {
    originalName: v.name,
    name: v.name,
    type,
    url: cfg?.url || (type !== 'stdio' ? v.target : ''),
    headers: headerRows.length ? headerRows : [{ key: '', value: '' }],
    command: cfg?.command || (type === 'stdio' ? v.target.split(/\s+/)[0] || '' : ''),
    argsText: cfg?.args?.length ? cfg.args.join('\n') : '',
    env: cfg?.env ? Object.entries(cfg.env).map(([key, value]) => ({ key, value })) : [],
    description: cfg?.description || '',
    disabled: !!cfg?.disabled || v.status === 'disabled',
  };
}

interface ParsedBatchEntry {
  name: string;
  config: McpServerConfig;
}

/** 解析批量 MCP JSON：支持 { "mcpServers": { ... } }、{ "name1": {...}, "name2": {...} } 或无外层花括号片段 */
function parseBatchMcpJson(raw: string): ParsedBatchEntry[] {
  const trimmed = raw.trim().replace(/,\s*$/, '');
  if (!trimmed) throw new Error('请先粘贴 JSON 配置');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 兼容直接复制一个或多个 "name": { ... } 片段
    parsed = JSON.parse(`{${trimmed}}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON 必须是对象');
  }
  const obj = parsed as Record<string, unknown>;
  const map: Record<string, unknown> =
    obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
      ? (obj.mcpServers as Record<string, unknown>)
      : obj;

  const entries = Object.entries(map);
  if (!entries.length) throw new Error('未识别到任何 MCP 服务');

  const out: ParsedBatchEntry[] = [];
  for (const [name, val] of entries) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      throw new Error(`「${name}」的配置必须是对象`);
    }
    const entry = val as Record<string, unknown>;
    const rawType = String(entry.type || '').toLowerCase();
    const type: 'http' | 'sse' | 'stdio' =
      rawType === 'sse'
        ? 'sse'
        : rawType === 'http' || rawType === 'streamablehttp' || (typeof entry.url === 'string' && rawType !== 'stdio')
          ? 'http'
          : 'stdio';

    const headersObj = entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)
      ? (entry.headers as Record<string, unknown>)
      : {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersObj)) {
      if (k.trim()) headers[k.trim()] = String(v ?? '').trim();
    }
    const envObj = entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
      ? (entry.env as Record<string, unknown>)
      : {};
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(envObj)) {
      if (k.trim()) env[k.trim()] = String(v ?? '');
    }
    const args = Array.isArray(entry.args) ? entry.args.map((a) => String(a)).filter(Boolean) : [];
    const description = typeof entry.description === 'string' && entry.description.trim() ? entry.description.trim() : undefined;
    const disabled = entry.disabled === true ? true : undefined;

    const config: McpServerConfig = type === 'stdio'
      ? {
        type: 'stdio',
        command: typeof entry.command === 'string' ? entry.command.trim() : '',
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(description ? { description } : {}),
        ...(disabled ? { disabled: true } : {}),
      }
      : {
        type,
        url: typeof entry.url === 'string' ? entry.url.trim() : '',
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(description ? { description } : {}),
        ...(disabled ? { disabled: true } : {}),
      };
    out.push({ name: name.trim(), config });
  }
  return out;
}

function draftFromParsedEntry(entry: ParsedBatchEntry, originalName?: string): McpDraft {
  const c = entry.config;
  const headerRows = c.headers ? Object.entries(c.headers).map(([key, value]) => ({ key, value })) : [];
  return {
    originalName,
    name: entry.name,
    type: c.type,
    url: c.url || '',
    headers: headerRows.length ? headerRows : [{ key: '', value: '' }],
    command: c.command || '',
    argsText: c.args?.length ? c.args.join('\n') : '',
    env: c.env ? Object.entries(c.env).map(([key, value]) => ({ key, value })) : [],
    description: c.description || '',
    disabled: !!c.disabled,
  };
}

function rowsToRecord(rows: KvRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.value.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function KvEditor({
  rows, onChange, keyPlaceholder, valuePlaceholder, addLabel,
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  return (
    <div className="mcp-kv-list">
      {rows.map((r, i) => (
        <div className="mcp-kv-row" key={i}>
          <input
            value={r.key}
            placeholder={keyPlaceholder}
            onChange={(e) => onChange(rows.map((x, idx) => (idx === i ? { ...x, key: e.target.value } : x)))}
          />
          <input
            value={r.value}
            placeholder={valuePlaceholder}
            onChange={(e) => onChange(rows.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x)))}
          />
          <button
            type="button"
            className="mcp-kv-del"
            title="删除"
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="mcp-kv-add"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
      >
        <Plus size={13} /> {addLabel}
      </button>
    </div>
  );
}

/** MCP 管理页：卡片式 server 列表 + 筛选 + 新增/编辑/删除/热重连 + 工具列表 */
export default function McpPage() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [importModal, setImportModal] = useState(false);
  const [importText, setImportText] = useState('');
  const [importErr, setImportErr] = useState('');
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);

  const applyStatus = (d: McpStatus) => setStatus({
    ...d,
    // 老后端没有 views 时，用已连接名单兜底
    views: d.views?.length ? d.views : (d.servers || []).map((name) => ({
      name, status: 'connected' as const, transport: 'STDIO' as const,
      source: '', target: '', toolCount: (d.tools || []).filter((t) => t.name.startsWith(`${name}__`)).length,
    })),
  });

  const load = (reload = false) => {
    setLoading(true);
    const req = reload
      ? fetch('/api/mcp/reload', { method: 'POST' })
      : fetch('/api/mcp');
    req.then((r) => r.json())
      .then((d: McpStatus) => applyStatus(d))
      .catch(() => setStatus({ servers: [], views: [], tools: [] }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(false); }, []);

  const openCreate = () => {
    setFormErr('');
    setDraft(emptyDraft());
  };

  const openImport = () => {
    setImportErr('');
    setImportText('');
    setImportModal(true);
  };

  const openEdit = (v: McpServerView) => {
    setFormErr('');
    setActive(null);
    setDraft(draftFromView(v));
  };

  const batchPreview = (() => {
    if (!importText.trim()) return { entries: [] as ParsedBatchEntry[], error: '' };
    try {
      return { entries: parseBatchMcpJson(importText), error: '' };
    } catch (e) {
      return { entries: [] as ParsedBatchEntry[], error: (e as Error).message };
    }
  })();

  const submitBatchImport = async () => {
    if (importing) return;
    setImportErr('');
    let entries: ParsedBatchEntry[];
    try {
      entries = parseBatchMcpJson(importText);
    } catch (e) {
      setImportErr(`JSON 解析失败：${(e as Error).message}`);
      return;
    }
    setImporting(true);
    try {
      const mcpServers: Record<string, McpServerConfig> = {};
      for (const item of entries) mcpServers[item.name] = item.config;
      const r = await fetch('/api/mcp/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpServers }),
      });
      const d = await r.json() as McpStatus & { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) {
        setImportErr(d.error || `导入失败（HTTP ${r.status}）`);
        return;
      }
      applyStatus(d);
      setImportModal(false);
      setImportText('');
    } catch (e) {
      setImportErr((e as Error).message || '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const saveDraft = async () => {
    if (!draft || saving) return;
    setFormErr('');
    setSaving(true);
    try {
      const desc = draft.description.trim() || undefined;
      const disabled = draft.disabled ? true : undefined;
      const config: McpServerConfig = draft.type === 'stdio'
        ? {
          type: 'stdio',
          command: draft.command.trim(),
          args: draft.argsText.split('\n').map((s) => s.trim()).filter(Boolean),
          env: rowsToRecord(draft.env),
          description: desc,
          disabled,
        }
        : {
          type: draft.type,
          url: draft.url.trim(),
          headers: rowsToRecord(draft.headers),
          description: desc,
          disabled,
        };
      const r = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          originalName: draft.originalName,
          config,
        }),
      });
      const d = await r.json() as McpStatus & { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) {
        setFormErr(d.error || `保存失败（HTTP ${r.status}）`);
        return;
      }
      applyStatus(d);
      setDraft(null);
    } catch (e) {
      setFormErr((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    const target = deletingName;
    if (!target) return;
    setDeletingName(null);
    try {
      const r = await fetch(`/api/mcp/${encodeURIComponent(target)}`, { method: 'DELETE' });
      const d = await r.json() as McpStatus & { ok?: boolean };
      if (r.ok && d.ok) {
        applyStatus(d);
        if (active === target) setActive(null);
      }
    } catch { /* ignore */ }
  };

  const reconnect = async (name: string) => {
    setReconnecting(name);
    try {
      const r = await fetch(`/api/mcp/${encodeURIComponent(name)}/reconnect`, { method: 'POST' });
      const d = await r.json() as McpStatus & { ok?: boolean };
      if (r.ok && d.ok) applyStatus(d);
    } finally {
      setReconnecting(null);
    }
  };

  const byServer: Record<string, McpTool[]> = {};
  for (const t of status?.tools || []) {
    const s = t.name.split('__')[0] || '其它';
    (byServer[s] ||= []).push(t);
  }

  const views = status?.views || [];
  const q = search.trim().toLowerCase();
  const filtered = views.filter((v) => {
    if (q && !(v.name + ' ' + v.target + ' ' + (v.config?.description || '')).toLowerCase().includes(q)) return false;
    if (filter === 'all' || filter === 'mcp') return true;
    if (filter === 'http') return v.transport === 'HTTP';
    if (filter === 'sse') return v.transport === 'SSE';
    if (filter === 'stdio') return v.transport === 'STDIO';
    return false;
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
          <button className="mcp-refresh" onClick={() => load(true)} disabled={loading} title="重新加载配置并重连">
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> 刷新
          </button>
          <button className="mcp-refresh" onClick={openImport} title="批量粘贴 mcpServers JSON 导入">
            <Download size={14} /> 导入 JSON
          </button>
          <button className="mcp-add-btn" onClick={openCreate}>
            <Plus size={14} /> 新增 MCP
          </button>
        </div>

        <div className="mcp-grid">
          {filtered.map((v) => (
            <div
              className="mcp-card"
              key={v.name}
              role="button"
              tabIndex={0}
              onClick={() => setActive(v.name)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(v.name); } }}
            >
              <div className="mcp-card-top">
                <span className="mcp-card-icon"><Server size={15} /></span>
                <span className="mcp-card-title">{v.name}</span>
                <div className="mcp-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="mcp-card-act"
                    title="编辑配置"
                    onClick={() => openEdit(v)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="mcp-card-act danger"
                    title="删除服务"
                    onClick={() => setDeletingName(v.name)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <span className={
                  'mcp-card-badge' + (v.status === 'disabled' ? ' disabled' : v.status !== 'connected' ? ' inactive' : '')
                }>
                  {v.status === 'connected' ? '已连接' : v.status === 'disabled' ? '已禁用' : v.status === 'failed' ? '连接失败' : '连接中'}
                </span>
              </div>
              <div className="mcp-card-url" title={v.target}>{v.target || v.source}</div>
              <div className="mcp-card-foot">
                <span className={
                  'mcp-card-status' + (v.status === 'disabled' ? ' disabled' : v.status !== 'connected' ? ' inactive' : '')
                }>
                  <span className="dot" /> {v.status === 'connected' ? '运行中' : v.status === 'disabled' ? '已禁用' : v.status === 'failed' ? '不可用' : '连接中'}
                </span>
                <span className="mcp-card-type">{v.transport}</span>
                <span className="mcp-card-count">{v.status === 'connected' ? `${v.toolCount} 个工具` : (v.source || '未配置')}</span>
              </div>
              <ChevronRight size={15} className="mcp-card-arrow" />
            </div>
          ))}
          {filtered.length === 0 && <div className="side-empty">没有匹配的 MCP 服务</div>}
        </div>
      </div>

      {active && (() => {
        const v = views.find((x) => x.name === active);
        return (
          <div className="modal-backdrop" onClick={() => setActive(null)}>
            <div className="modal mcp-detail" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <span><Server size={15} /> {active} · 工具列表</span>
                <button onClick={() => setActive(null)}><X size={15} /></button>
              </div>
              <div className="modal-body">
                {v?.status === 'failed' && (
                  <div className="mcp-detail-error">
                    连接失败：{v.error || '未知原因'}
                  </div>
                )}
                <div className="mcp-detail-hint">
                  共 {(byServer[active] || []).length} 个工具
                  {v?.target ? <> · <code>{v.target}</code></> : null}
                  {v?.source ? <> · 来源 <code>{v.source}</code></> : null}
                </div>
                <div className="mcp-tool-tags">
                  {(byServer[active] || []).map((t) => {
                    const sep = t.name.indexOf('__');
                    const shortName = sep >= 0 ? t.name.slice(sep + 2) : t.name;
                    return (
                      <span className="mcp-tool-tag" key={t.name} title={t.description || t.name}>
                        {shortName}
                      </span>
                    );
                  })}
                  {!(byServer[active] || []).length && <div className="side-empty">暂无可用工具</div>}
                </div>
                {v && (
                  <div className="mcp-detail-foot">
                    <button
                      type="button"
                      className="mcp-refresh"
                      disabled={reconnecting === v.name}
                      onClick={() => void reconnect(v.name)}
                    >
                      <RefreshCw size={13} className={reconnecting === v.name ? 'spin' : ''} /> 重新连接
                    </button>
                    <button type="button" className="mcp-refresh" onClick={() => openEdit(v)}>
                      <Pencil size={13} /> 编辑配置
                    </button>
                    <button
                      type="button"
                      className="mcp-refresh danger"
                      onClick={() => setDeletingName(v.name)}
                    >
                      <Trash2 size={13} /> 删除
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {importModal && (
        <div className="modal-backdrop" onClick={() => { if (!importing) setImportModal(false); }}>
          <div className="modal mcp-form-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span><Download size={15} /> 批量导入 MCP 配置（JSON）</span>
              <button disabled={importing} onClick={() => setImportModal(false)}><X size={15} /></button>
            </div>
            <div className="modal-body mcp-form-body">
              {importErr && <div className="mcp-detail-error">{importErr}</div>}
              <label className="mcp-field">
                <span>粘贴 <code>mcpServers</code> JSON（可一次粘贴多个服务）</span>
                <textarea
                  autoFocus
                  rows={12}
                  value={importText}
                  placeholder={`{\n  "mcpServers": {\n    "crm-harness": {\n      "type": "http",\n      "url": "http://127.0.0.1:3000/mcp",\n      "headers": { "Authorization": "Bearer ..." }\n    },\n    "dms": {\n      "command": "/opt/anaconda3/bin/python",\n      "args": ["/path/to/mcp_server.py"],\n      "env": {}\n    }\n  }\n}`}
                  onChange={(e) => { setImportText(e.target.value); setImportErr(''); }}
                />
              </label>

              {batchPreview.error && (
                <div className="mcp-import-warn">JSON 语法提示：{batchPreview.error}</div>
              )}
              {batchPreview.entries.length > 0 && (
                <div className="mcp-import-preview">
                  <div className="mcp-import-preview-title">
                    已识别 <strong>{batchPreview.entries.length}</strong> 个服务：
                  </div>
                  <div className="mcp-import-chips">
                    {batchPreview.entries.map((item) => (
                      <span
                        className={'mcp-import-chip' + (item.config.disabled ? ' disabled' : '')}
                        key={item.name}
                      >
                        <strong>{item.name}</strong>
                        <em>{item.config.type.toUpperCase()}</em>
                        {item.config.disabled && <small>已禁用</small>}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="mcp-form-tip">
                导入将合并写入 <code>~/.paw/mcp.json</code>（同名覆盖），并立即并行热连接启用项；<code>"disabled": true</code> 的服务会保留配置但不启动连接。
              </div>

              <div className="modal-actions">
                <button type="button" className="btn-ghost" disabled={importing} onClick={() => setImportModal(false)}>取消</button>
                {batchPreview.entries.length === 1 && (
                  <button
                    type="button"
                    className="mcp-refresh"
                    disabled={importing}
                    onClick={() => {
                      setDraft(draftFromParsedEntry(batchPreview.entries[0]));
                      setImportModal(false);
                      setImportText('');
                    }}
                  >
                    填入表单编辑
                  </button>
                )}
                <button
                  type="button"
                  className="btn-solid"
                  disabled={importing || batchPreview.entries.length === 0}
                  onClick={() => void submitBatchImport()}
                >
                  {importing
                    ? <><Loader2 size={14} className="spin" /> 导入并连接中…</>
                    : `导入并连接${batchPreview.entries.length ? ` (${batchPreview.entries.length})` : ''}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {draft && (
        <div className="modal-backdrop" onClick={() => { if (!saving) setDraft(null); }}>
          <div className="modal mcp-form-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span><Plug size={15} /> {draft.originalName ? `编辑 MCP · ${draft.originalName}` : '新增 MCP 服务'}</span>
              <button disabled={saving} onClick={() => setDraft(null)}><X size={15} /></button>
            </div>
            <div className="modal-body mcp-form-body">
              {formErr && <div className="mcp-detail-error">{formErr}</div>}

              {!draft.originalName && (
                <div className="mcp-import-bar">
                  <button
                    type="button"
                    className="mcp-import-toggle"
                    onClick={() => { setDraft(null); openImport(); }}
                  >
                    <Download size={13} /> 批量导入配置（JSON）
                  </button>
                </div>
              )}

              <label className="mcp-field">
                <span>服务名称 <em>*</em></span>
                <input
                  autoFocus
                  value={draft.name}
                  placeholder="例如 crm-harness、filesystem（仅字母/数字/下划线/短横线）"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>

              <div className="mcp-field">
                <span>传输类型</span>
                <div className="mcp-seg three">
                  <button
                    type="button"
                    className={draft.type === 'http' ? 'active' : ''}
                    onClick={() => setDraft({ ...draft, type: 'http' })}
                  >
                    HTTP（远程服务）
                  </button>
                  <button
                    type="button"
                    className={draft.type === 'sse' ? 'active' : ''}
                    onClick={() => setDraft({ ...draft, type: 'sse' })}
                  >
                    SSE（事件流）
                  </button>
                  <button
                    type="button"
                    className={draft.type === 'stdio' ? 'active' : ''}
                    onClick={() => setDraft({ ...draft, type: 'stdio' })}
                  >
                    STDIO（本地命令）
                  </button>
                </div>
              </div>

              {draft.type !== 'stdio' ? (
                <>
                  <label className="mcp-field">
                    <span>服务地址 (URL) <em>*</em></span>
                    <input
                      value={draft.url}
                      placeholder={draft.type === 'sse' ? 'http://127.0.0.1:3000/sse' : 'http://127.0.0.1:3000/mcp'}
                      onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                    />
                  </label>
                  <div className="mcp-field">
                    <span>请求头（Headers，可选）</span>
                    <KvEditor
                      rows={draft.headers}
                      onChange={(headers) => setDraft({ ...draft, headers })}
                      keyPlaceholder="KEY（如 Authorization / X-Ecc-Current-Tenant）"
                      valuePlaceholder="VALUE（如 Bearer ...）"
                      addLabel="添加请求头"
                    />
                  </div>
                </>
              ) : (
                <>
                  <label className="mcp-field">
                    <span>启动命令 (Command) <em>*</em></span>
                    <input
                      value={draft.command}
                      placeholder="例如 npx、python3、node"
                      onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                    />
                  </label>
                  <label className="mcp-field">
                    <span>命令参数 (Args，每行一个，可选)</span>
                    <textarea
                      rows={3}
                      value={draft.argsText}
                      placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/workspace'}
                      onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
                    />
                  </label>
                  <div className="mcp-field">
                    <span>环境变量 (Env，可选)</span>
                    <KvEditor
                      rows={draft.env}
                      onChange={(env) => setDraft({ ...draft, env })}
                      keyPlaceholder="变量名，如 API_KEY"
                      valuePlaceholder="变量值"
                      addLabel="添加环境变量"
                    />
                  </div>
                </>
              )}

              <label className="mcp-field">
                <span>描述（可选）</span>
                <textarea
                  rows={2}
                  value={draft.description}
                  placeholder="描述该 MCP 服务的用途"
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </label>

              <label className="mcp-check-row">
                <input
                  type="checkbox"
                  checked={!draft.disabled}
                  onChange={(e) => setDraft({ ...draft, disabled: !e.target.checked })}
                />
                <span>启用此服务（取消勾选则仅保留配置，不启动连接）</span>
              </label>

              <div className="mcp-form-tip">
                配置将保存至 <code>~/.paw/mcp.json</code> 并立即尝试热连接，无需重启 Paw。
              </div>

              <div className="modal-actions">
                <button type="button" className="btn-ghost" disabled={saving} onClick={() => setDraft(null)}>取消</button>
                <button type="button" className="btn-solid" disabled={saving} onClick={() => void saveDraft()}>
                  {saving ? <><Loader2 size={14} className="spin" /> 保存中…</> : draft.disabled ? '仅保存配置' : '保存并连接'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deletingName && (
        <ConfirmDialog
          title={`删除 MCP 服务「${deletingName}」`}
          body="删除后将立即断开该服务并从列表中移除（外部 ~/.workbuddy/mcp.json 原文件不会被修改）。"
          confirmText="确认删除"
          onCancel={() => setDeletingName(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}
