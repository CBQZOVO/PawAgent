import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle, Check, Cloud, KeyRound, Link2, Loader2,
  Pencil, Plus, Send, ShieldCheck, Trash2, X, Zap,
} from 'lucide-react';
import ConfirmDialog from './ConfirmDialog';

/**
 * 系统连接：把外部系统登记成一条连接，Agent 用 call_api 调它的接口。
 *
 * 默认支持通用 HTTP 连接；安装外部认证/SSO 插件（如 ~/.paw/plugins/）后，
 * 页面自动根据后端返回的 authProviders / ssoProviders 动态呈现扩展选项。
 */
interface ProviderFieldSchema {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
}

interface AuthProviderView {
  kind: string;
  label: string;
  configKey: string;
  badgeSigned?: string;
  badgeUnsigned?: string;
  tagSigned?: string;
  tagUnsigned?: string;
  secretLabel?: string;
  secretHint?: string;
  secretPlaceholder?: string;
  secretOptional?: boolean;
  defaultHeaders?: Array<{ key: string; value: string }>;
  autoHeaders?: string[];
  fields?: ProviderFieldSchema[];
}

interface SsoProviderView {
  type: string;
  label: string;
  fields?: ProviderFieldSchema[];
}

interface ConnSsoView {
  type: string;
  [key: string]: unknown;
}

interface Draft {
  code: string;
  name: string;
  kind?: string;
  baseUrl: string;
  description?: string;
  auth: { type: 'none' | 'bearer' | 'header' | 'basic' | 'query'; name?: string };
  sso?: ConnSsoView;
  headers?: Record<string, string>;
  timeoutMs?: number;
  [key: string]: unknown;
}

interface ConnView extends Draft {
  hasSecret: boolean;
  lastCall?: { at: number; method: string; path: string; status: number; ms: number; ok: boolean };
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const AUTH_LABEL: Record<string, string> = {
  none: '无需认证',
  bearer: 'Bearer Token',
  header: '自定义请求头',
  basic: 'Basic Auth',
  query: '查询参数',
};

const COMMON_HEADERS = [
  'Accept-Language',
  'Content-Type',
  'X-App-Id',
  'X-Request-Id',
];

interface ProbeResult {
  ok: boolean;
  reachable: boolean;
  status: number;
  ms: number;
  message: string;
  path: string;
  method: string;
  snippet?: string;
}

interface HeaderRow { key: string; value: string }

const emptyDraft = (): Draft => ({
  code: '', name: '', kind: 'http', baseUrl: '', description: '',
  auth: { type: 'none' }, timeoutMs: 30000,
});

const headersToRows = (h?: Record<string, string>): HeaderRow[] =>
  h ? Object.entries(h).map(([key, value]) => ({ key, value })) : [];

function rowsToHeaders(rows: HeaderRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.value.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function getRecordField(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function HeaderEditor({ rows, onChange }: { rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void }) {
  const setRow = (i: number, patch: Partial<HeaderRow>) =>
    onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="hdr-list">
      {rows.map((r, i) => (
        <div className="hdr-row" key={i}>
          <input
            className="hdr-key"
            list="paw-common-headers"
            value={r.key}
            placeholder="X-Custom-Header"
            onChange={(e) => setRow(i, { key: e.target.value })} />
          <input
            className="hdr-val"
            value={r.value}
            placeholder="值"
            onChange={(e) => setRow(i, { value: e.target.value })} />
          <button className="hdr-del" onClick={() => onChange(rows.filter((_, k) => k !== i))} title="删除这一行">
            <X size={13} />
          </button>
        </div>
      ))}
      <button className="hdr-add" onClick={() => onChange([...rows, { key: '', value: '' }])}>
        <Plus size={13} /> 添加请求头
      </button>
      <datalist id="paw-common-headers">
        {COMMON_HEADERS.map((h) => <option key={h} value={h} />)}
      </datalist>
    </div>
  );
}

function ProbeDialog({ conn, onClose }: { conn: ConnView; onClose: () => void }) {
  const [pathInput, setPathInput] = useState('');
  const [method, setMethod] = useState('GET');
  const [body, setBody] = useState('');
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch(`/api/connections/${encodeURIComponent(conn.code)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: pathInput.trim(),
          method,
          body: method === 'GET' ? undefined : (body.trim() || undefined),
        }),
      });
      setResult(await r.json() as ProbeResult);
    } catch (e) {
      setResult({ ok: false, reachable: false, status: 0, ms: 0, message: (e as Error).message, path: pathInput, method });
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal probe-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span><Zap size={15} /> 连接检测 · {conn.name}</span>
          <button onClick={onClose}><X size={15} /></button>
        </div>

        <div className="modal-body probe-body">
          <div className="probe-target">
            <Cloud size={13} /> {conn.baseUrl}
            <span className="probe-target-hint">只填路径，域名自动拼在后面</span>
          </div>

          <div className="probe-row">
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <input
              ref={inputRef}
              value={pathInput}
              placeholder="/api/v1/health（留空则请求连接地址本身）"
              onChange={(e) => setPathInput(e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text').trim();
                const base = conn.baseUrl.trim().replace(/\/+$/, '');
                if (base && text.startsWith(base)) {
                  e.preventDefault();
                  setPathInput(text.slice(base.length) || '/');
                }
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} />
            <button className="probe-send" disabled={busy} onClick={() => void send()}>
              {busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />} 发送
            </button>
          </div>

          {method !== 'GET' && (
            <textarea
              className="probe-input-body"
              rows={3}
              value={body}
              placeholder='请求体（可选），如 {"id":"xxx"}'
              onChange={(e) => setBody(e.target.value)} />
          )}

          {result ? (
            <div className={'probe-result ' + (result.ok ? 'ok' : result.reachable ? 'warn' : 'fail')}>
              <div className="probe-result-line">
                {result.ok ? <Check size={14} /> : <AlertCircle size={14} />}
                <code>{result.method} {result.path}</code>
                <span className="probe-result-status">{result.message}</span>
              </div>
              {result.snippet && <pre className="probe-result-body">{result.snippet}</pre>}
            </div>
          ) : (
            <div className="probe-empty">发送后这里显示状态码和响应体（JSON 会自动格式化）。</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ConnectionsPage() {
  const [list, setList] = useState<ConnView[]>([]);
  const [authProviders, setAuthProviders] = useState<AuthProviderView[]>([]);
  const [ssoProviders, setSsoProviders] = useState<SsoProviderView[]>([]);
  const [loading, setLoading] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [probeTarget, setProbeTarget] = useState<ConnView | null>(null);
  const [askDelete, setAskDelete] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/connections');
      const d = await r.json() as {
        connections?: ConnView[];
        authProviders?: AuthProviderView[];
        ssoProviders?: SsoProviderView[];
      };
      setList(d.connections || []);
      setAuthProviders(d.authProviders || []);
      setSsoProviders(d.ssoProviders || []);
    } catch {
      setList([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const findAuthProvider = (kind?: string) =>
    kind && kind !== 'http' ? authProviders.find((p) => p.kind === kind) : undefined;
  const findSsoProvider = (type?: string) =>
    type ? ssoProviders.find((p) => p.type === type) : undefined;

  const editingExisting = !!draft && list.some((c) => c.code === draft.code);
  const savedHasSecret = !!draft && list.find((c) => c.code === draft.code)?.hasSecret === true;
  const activeAuthProvider = draft ? findAuthProvider(draft.kind) : undefined;
  const activeSsoProvider = draft?.sso?.type ? findSsoProvider(draft.sso.type) : undefined;

  const autoHeaders = ['authorization', ...(activeAuthProvider?.autoHeaders || [])];
  const headerClash = headerRows
    .map((r) => r.key.trim().toLowerCase())
    .filter((k) => autoHeaders.includes(k));

  const openNew = () => {
    setDraft(emptyDraft());
    setHeaderRows([]);
    setSecret('');
    setError('');
  };

  const openEdit = (c: ConnView) => {
    const { hasSecret: _hs, lastCall: _lc, ...rest } = c;
    setDraft({
      ...rest,
      code: c.code,
      name: c.name,
      kind: c.kind || 'http',
      baseUrl: c.baseUrl,
      description: c.description || '',
      auth: { ...c.auth },
      sso: c.sso ? { ...c.sso } : undefined,
      timeoutMs: c.timeoutMs || 30000,
    });
    setHeaderRows(headersToRows(c.headers));
    setSecret('');
    setError('');
  };

  const save = async () => {
    if (!draft) return;
    setError('');
    const code = draft.code.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(code)) { setError('编码：小写字母开头，只能含字母/数字/下划线/短横线'); return; }
    if (!draft.name.trim()) { setError('名称不能为空'); return; }
    if (!/^https?:\/\/[^/\s]+/i.test(draft.baseUrl.trim())) { setError('地址要以 http:// 或 https:// 开头'); return; }

    if (activeAuthProvider) {
      const cfg = getRecordField(draft, activeAuthProvider.configKey);
      for (const f of activeAuthProvider.fields || []) {
        if (f.required && !String(cfg[f.key] ?? '').trim()) {
          setError(`${activeAuthProvider.label} 必须填 ${f.label}`);
          return;
        }
      }
    } else if ((draft.auth.type === 'header' || draft.auth.type === 'query') && !draft.auth.name?.trim()) {
      setError('这种认证方式必须填字段名');
      return;
    }

    if (activeSsoProvider && draft.sso) {
      for (const f of activeSsoProvider.fields || []) {
        if (f.required && !String(draft.sso[f.key] ?? '').trim()) {
          setError(`${activeSsoProvider.label} 必须填 ${f.label}`);
          return;
        }
      }
    }

    setSaving(true);
    try {
      const payload: Draft = {
        ...draft, code,
        baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
        headers: rowsToHeaders(headerRows),
      };
      const next = editingExisting
        ? list.map((c) => (c.code === code ? { ...payload, hasSecret: c.hasSecret } : c))
        : [...list, { ...payload, hasSecret: false }];
      const r = await fetch('/api/connections', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connections: next }),
      });
      const d = await r.json() as { error?: string; connections?: ConnView[] };
      if (!r.ok) { setError(d.error || '保存失败'); return; }
      if (secret.trim()) {
        const sr = await fetch(`/api/connections/${encodeURIComponent(code)}/secret`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: secret.trim() }),
        });
        const sd = await sr.json() as { error?: string; hasSecret?: boolean };
        if (!sr.ok || sd.hasSecret === false) { setError(sd.error || '密钥写入失败'); return; }
      }
      setDraft(null);
      setSecret('');
      if (d.connections) setList(d.connections); else await load();
    } finally { setSaving(false); }
  };

  const clearSecret = async () => {
    if (!draft) return;
    const r = await fetch(`/api/connections/${encodeURIComponent(draft.code)}/secret`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: '' }),
    });
    if (r.ok) await load();
  };

  const remove = async (code: string) => {
    await fetch(`/api/connections/${encodeURIComponent(code)}`, { method: 'DELETE' });
    if (probeTarget?.code === code) setProbeTarget(null);
    await load();
  };

  return (
    <div className="manage-page">
      <header className="topbar">
        <span className="top-title"><Link2 size={16} /> 系统连接</span>
        <span className="top-sub">
          {list.length ? `${list.length} 个连接 · Agent 用 call_api 调用` : '让 Agent 直接调外部系统的 HTTP 接口'}
        </span>
        <button className="conn-new" onClick={openNew}><Plus size={14} /> 新增连接</button>
      </header>

      <div className="manage-body">
        {list.length === 0 && !loading ? (
          <div className="conn-empty">
            <div className="conn-empty-mark"><Link2 size={22} /></div>
            <h3>还没有连接</h3>
            <p>
              登记一个系统（地址 + 认证），Agent 就能用 <code>call_api</code> 调它的接口，
              不用再靠 <code>run_command</code> 拼 curl，密钥也不会进对话上下文。
            </p>
            <button className="conn-new" onClick={openNew}><Plus size={14} /> 登记第一个系统</button>
          </div>
        ) : (
          <div className="mcp-grid">
            {list.map((c) => {
              const provider = findAuthProvider(c.kind);
              const isCustomKind = Boolean(c.kind && c.kind !== 'http');
              return (
                <div className="mcp-card conn-card" key={c.code} role="button" tabIndex={0}
                  onClick={() => openEdit(c)}
                  onKeyDown={(e) => { if (e.key === 'Enter') openEdit(c); }}>
                  <div className="mcp-card-top">
                    <span className="mcp-card-icon">{isCustomKind ? <Cloud size={15} /> : <Link2 size={15} />}</span>
                    <span className="mcp-card-title">{c.name}</span>
                    {provider
                      ? <span className="mcp-card-badge">{c.hasSecret ? (provider.badgeSigned || '已授权') : (provider.badgeUnsigned || '未设密钥')}</span>
                      : c.hasSecret && <span className="mcp-card-badge">已授权</span>}
                    {c.sso && findSsoProvider(c.sso.type) && <span className="mcp-card-badge">可开页面</span>}
                  </div>
                  <div className="mcp-card-url">{c.baseUrl}</div>
                  {c.description && <div className="conn-desc">{c.description}</div>}
                  <div className="mcp-card-foot">
                    <span className="conn-tag">
                      {provider
                        ? (c.hasSecret ? (provider.tagSigned || provider.label) : (provider.tagUnsigned || provider.label))
                        : isCustomKind
                          ? `${c.kind}（需插件）`
                          : (AUTH_LABEL[c.auth.type] || c.auth.type)}
                    </span>
                    {c.lastCall && (
                      <span className={'conn-lastcall' + (c.lastCall.ok ? '' : ' fail')} title={c.lastCall.path}>
                        {c.lastCall.ok ? '✓' : '✗'} {c.lastCall.status}
                      </span>
                    )}
                  </div>
                  <div className="conn-card-actions" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => setProbeTarget(c)} title="连接检测"><Zap size={14} /></button>
                    <button onClick={() => openEdit(c)} title="编辑"><Pencil size={14} /></button>
                    <button className="danger" onClick={() => setAskDelete(c.code)} title="删除"><Trash2 size={14} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {draft && (
        <div className="modal-backdrop" onClick={() => setDraft(null)}>
          <div className="modal conn-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span><Link2 size={15} /> {editingExisting ? `编辑 ${draft.name || draft.code}` : '新增系统连接'}</span>
              <button onClick={() => setDraft(null)}><X size={15} /></button>
            </div>

            <div className="modal-body conn-form">
              <section className="conn-section">
                <h4 className="conn-section-title">基本信息</h4>
                <div className="conn-row">
                  <label className="conn-field">
                    <span>编码 <em>Agent 用它指定连接</em></span>
                    <input value={draft.code} disabled={editingExisting} placeholder="crm"
                      onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
                  </label>
                  <label className="conn-field">
                    <span>名称</span>
                    <input value={draft.name} placeholder="CRM 测试环境"
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </label>
                </div>

                <label className="conn-field">
                  <span>地址 <em>接口路径不能跳出这个域名</em></span>
                  <input value={draft.baseUrl} placeholder="https://crm.internal.example.com"
                    onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
                </label>

                <div className="conn-row">
                  <label className="conn-field">
                    <span>类型</span>
                    <select
                      value={draft.kind || 'http'}
                      onChange={(e) => {
                        const kind = e.target.value;
                        const provider = findAuthProvider(kind);
                        const nextDraft: Draft = { ...draft, kind };
                        if (provider) {
                          const existing = getRecordField(draft, provider.configKey);
                          const initCfg: Record<string, unknown> = { ...existing };
                          for (const f of provider.fields || []) {
                            if (initCfg[f.key] === undefined && f.defaultValue !== undefined) {
                              initCfg[f.key] = f.defaultValue;
                            }
                          }
                          nextDraft[provider.configKey] = initCfg;
                          if (provider.defaultHeaders?.length) {
                            const missing = provider.defaultHeaders.filter(
                              (d) => !headerRows.some((r) => r.key.trim().toLowerCase() === d.key.toLowerCase()),
                            );
                            if (missing.length) setHeaderRows([...headerRows, ...missing]);
                          }
                        }
                        setDraft(nextDraft);
                      }}>
                      <option value="http">自定义 HTTP</option>
                      {authProviders.map((p) => (
                        <option key={p.kind} value={p.kind}>{p.label}</option>
                      ))}
                      {draft.kind && draft.kind !== 'http' && !findAuthProvider(draft.kind) && (
                        <option value={draft.kind}>{draft.kind}（外部插件未启用）</option>
                      )}
                    </select>
                  </label>
                  <label className="conn-field">
                    <span>说明 <em>Agent 靠这句话判断什么时候用它</em></span>
                    <input value={draft.description || ''} placeholder="查询客户、订单、合同"
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                  </label>
                </div>
              </section>

              <section className="conn-section">
                <h4 className="conn-section-title">认证</h4>
                {activeAuthProvider ? (
                  <div className="conn-row">
                    {(activeAuthProvider.fields || []).map((f) => {
                      const cfg = getRecordField(draft, activeAuthProvider.configKey);
                      return (
                        <label className="conn-field" key={f.key}>
                          <span>{f.label}{f.hint && <> <em>{f.hint}</em></>}</span>
                          <input
                            value={String(cfg[f.key] ?? '')}
                            placeholder={f.placeholder || ''}
                            onChange={(e) => setDraft({
                              ...draft,
                              [activeAuthProvider.configKey]: { ...cfg, [f.key]: e.target.value },
                            })} />
                        </label>
                      );
                    })}
                    <label className="conn-field">
                      <span>
                        <KeyRound size={12} /> {activeAuthProvider.secretLabel || '密钥'}
                        {activeAuthProvider.secretHint && <> <em>{activeAuthProvider.secretHint}</em></>}
                      </span>
                      <div className="conn-secret">
                        <input type="password" value={secret}
                          placeholder={savedHasSecret ? '已保存，留空不改' : (activeAuthProvider.secretPlaceholder || '粘贴密钥')}
                          onChange={(e) => setSecret(e.target.value)} />
                        {savedHasSecret && (
                          <button className="conn-clear-secret" onClick={() => void clearSecret()} title="清除密钥">
                            <Trash2 size={13} /> 清除
                          </button>
                        )}
                      </div>
                    </label>
                  </div>
                ) : (
                  <>
                    <div className="conn-row">
                      <label className="conn-field">
                        <span>认证方式</span>
                        <select value={draft.auth.type}
                          onChange={(e) => setDraft({ ...draft, auth: { type: e.target.value as ConnView['auth']['type'], name: draft.auth.name } })}>
                          {Object.entries(AUTH_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </label>
                      {(draft.auth.type === 'header' || draft.auth.type === 'query') && (
                        <label className="conn-field">
                          <span>{draft.auth.type === 'header' ? '请求头名' : '参数名'}</span>
                          <input value={draft.auth.name || ''} placeholder={draft.auth.type === 'header' ? 'X-API-Key' : 'api_key'}
                            onChange={(e) => setDraft({ ...draft, auth: { ...draft.auth, name: e.target.value } })} />
                        </label>
                      )}
                    </div>
                    {draft.auth.type !== 'none' && (
                      <label className="conn-field">
                        <span><KeyRound size={12} /> 密钥 <em>{savedHasSecret ? '已存在，留空不改' : '存 ~/.paw/secrets.json（仅本机 600）'}</em></span>
                        <div className="conn-secret">
                          <input type="password" value={secret}
                            placeholder={draft.auth.type === 'basic' ? '用户名:密码' : '粘贴密钥'}
                            onChange={(e) => setSecret(e.target.value)} />
                          {savedHasSecret && (
                            <button className="conn-clear-secret" onClick={() => void clearSecret()} title="清除密钥">
                              <Trash2 size={13} /> 清除
                            </button>
                          )}
                        </div>
                      </label>
                    )}
                  </>
                )}
              </section>

              {(ssoProviders.length > 0 || draft.sso) && (
                <section className="conn-section">
                  <h4 className="conn-section-title">页面 SSO <span>打开业务页面时自动换票</span></h4>
                  <label className="conn-field">
                    <span>类型 <em>只影响内置浏览器打开业务页面</em></span>
                    <select value={draft.sso?.type || ''}
                      onChange={(e) => {
                        const t = e.target.value;
                        if (!t) { setDraft({ ...draft, sso: undefined }); return; }
                        const sp = findSsoProvider(t);
                        const nextSso: ConnSsoView = { type: t };
                        for (const f of sp?.fields || []) {
                          nextSso[f.key] = draft.sso?.[f.key] ?? f.defaultValue ?? '';
                        }
                        setDraft({ ...draft, sso: nextSso });
                      }}>
                      <option value="">关闭</option>
                      {ssoProviders.map((p) => (
                        <option key={p.type} value={p.type}>{p.label}</option>
                      ))}
                      {draft.sso?.type && !findSsoProvider(draft.sso.type) && (
                        <option value={draft.sso.type}>{draft.sso.type}（外部插件未启用）</option>
                      )}
                    </select>
                  </label>
                  {activeSsoProvider && draft.sso && (
                    <div className="conn-row" style={{ flexWrap: 'wrap' }}>
                      {(activeSsoProvider.fields || []).map((f) => (
                        <label className="conn-field" key={f.key} style={{ minWidth: '45%' }}>
                          <span>{f.label}{f.hint && <> <em>{f.hint}</em></>}</span>
                          <input
                            value={String(draft.sso?.[f.key] ?? '')}
                            placeholder={f.placeholder || ''}
                            onChange={(e) => setDraft({
                              ...draft,
                              sso: { ...draft.sso!, [f.key]: e.target.value },
                            })} />
                        </label>
                      ))}
                    </div>
                  )}
                </section>
              )}

              <section className="conn-section">
                <h4 className="conn-section-title">扩展信息 <span>附加请求头</span></h4>
                <HeaderEditor rows={headerRows} onChange={setHeaderRows} />
                {headerClash.length > 0 && (
                  <div className="conn-note">
                    {headerClash.join(' / ')} 由连接自动生成，这里写的会被覆盖。
                  </div>
                )}
              </section>

              {error && <div className="conn-error"><AlertCircle size={13} /> {error}</div>}
            </div>

            <div className="conn-actions">
              <span className="conn-actions-gap" />
              <button className="btn-ghost" onClick={() => setDraft(null)}>取消</button>
              <button className="btn-solid" onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />} 保存
              </button>
            </div>
          </div>
        </div>
      )}

      {probeTarget && <ProbeDialog conn={probeTarget} onClose={() => setProbeTarget(null)} />}

      {askDelete && (
        <ConfirmDialog
          title="删除这个连接？"
          body="连接和它的密钥都会被删除。已产生的对话不受影响，但 Agent 之后不能再调这个系统。"
          confirmText="删除"
          onCancel={() => setAskDelete(null)}
          onConfirm={() => {
            const code = askDelete;
            setAskDelete(null);
            setDraft(null);
            void remove(code);
          }}
        />
      )}
    </div>
  );
}
