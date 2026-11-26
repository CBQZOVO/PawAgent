import { useEffect, useMemo, useState } from 'react';
import { Brain, Calendar, Folder, Hash, NotebookPen, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';

/**
 * 记忆 · 工作日志 页面：顶部双 tab（外壳仿 TasksPage）。
 * 数据都在 ~/.paw/paw.db，按项目（workspace）区分；API：/api/memories、/api/worklogs。
 */

interface MemoryItem { id: string; title: string; content: string; tags: string; workspace: string; updatedAt: number }
interface WorkLogItem { id: string; workspace: string; day: string; title: string; content: string; createdAt: number }

const projName = (ws: string) => {
  if (!ws) return '通用';
  const segs = ws.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] || ws;
};

const fmtTime = (ts: number) => new Date(ts).toTimeString().slice(0, 5);

const fmtShortDate = (ts: number) => {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd} ${fmtTime(ts)}`;
};

const splitTags = (raw: string): string[] =>
  raw.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);

const dayTag = (day: string): string => {
  const now = new Date();
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (day === fmt(now)) return '今天';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (day === fmt(y)) return '昨天';
  return '';
};

const DAY_RANGES = [
  { value: 1, label: '今天' },
  { value: 3, label: '近 3 天' },
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
] as const;

export default function MemoryPage() {
  const [tab, setTab] = useState<'memory' | 'worklog'>('memory');
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [logs, setLogs] = useState<WorkLogItem[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [wsFilter, setWsFilter] = useState('');            // ''=全部
  const [query, setQuery] = useState('');
  const [days, setDays] = useState(7);                      // 日志时间范围
  const [loading, setLoading] = useState(false);
  // 编辑弹窗：kind 区分两类；id 为空 = 新建（仅记忆支持新建，日志由对话自动产生）
  const [editing, setEditing] = useState<{
    kind: 'memory' | 'worklog';
    id?: string;
    title: string;
    content: string;
    tags?: string;
    workspace?: string;
  } | null>(null);

  const load = () => {
    setLoading(true);
    const qs = wsFilter ? `?workspace=${encodeURIComponent(wsFilter)}` : '';
    const logQs = `${qs ? qs + '&' : '?'}days=${days}`;
    Promise.all([
      fetch(`/api/memories${qs}`).then((r) => r.json()),
      fetch(`/api/worklogs${logQs}`).then((r) => r.json()),
      fetch('/api/workspace').then((r) => r.json()),
    ]).then(([m, l, w]) => {
      setMemories(m.items || []);
      setLogs(l.items || []);
      setWorkspaces(w.workspaces || []);
    }).catch(() => { setMemories([]); setLogs([]); }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [wsFilter, days]);

  // Esc 关编辑弹窗
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditing(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);

  const saveEditing = async () => {
    if (!editing) return;
    const body = editing.kind === 'memory'
      ? { id: editing.id, title: editing.title, content: editing.content, tags: editing.tags, workspace: editing.workspace ?? wsFilter ?? '' }
      : { id: editing.id, title: editing.title, content: editing.content };
    const res = await fetch(editing.kind === 'memory' ? '/api/memories' : '/api/worklogs', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(d.error || '保存失败');
      return;
    }
    setEditing(null);
    load();
  };

  const remove = async (kind: 'memory' | 'worklog', id: string) => {
    if (!confirm('确定删除这条记录吗？')) return;
    await fetch(kind === 'memory' ? `/api/memories/${encodeURIComponent(id)}` : `/api/worklogs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    load();
  };

  const q = query.trim().toLowerCase();
  const filteredMemories = useMemo(() => {
    if (!q) return memories;
    return memories.filter((m) =>
      m.title.toLowerCase().includes(q)
      || m.content.toLowerCase().includes(q)
      || m.tags.toLowerCase().includes(q)
      || projName(m.workspace).toLowerCase().includes(q));
  }, [memories, q]);

  const filteredLogs = useMemo(() => {
    if (!q) return logs;
    return logs.filter((l) =>
      l.title.toLowerCase().includes(q)
      || l.content.toLowerCase().includes(q)
      || projName(l.workspace).toLowerCase().includes(q));
  }, [logs, q]);

  // 日志按天分组（接口已按时间倒序）
  const logsByDay = useMemo(() => {
    const map = new Map<string, WorkLogItem[]>();
    for (const l of filteredLogs) {
      const list = map.get(l.day) || [];
      list.push(l);
      map.set(l.day, list);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filteredLogs]);

  const wsOptions = useMemo(() => [...new Set(workspaces.filter(Boolean))], [workspaces]);

  const badge = (ws: string) => (
    <span className={'mem-badge' + (!ws ? ' global' : '')} title={ws || '跨项目通用'}>
      <Folder size={11} /> {projName(ws)}
    </span>
  );

  return (
    <div className="tools-page">
      <div className="tools-tabs">
        <button className={'tools-tab' + (tab === 'memory' ? ' active' : '')} onClick={() => setTab('memory')}>
          <Brain size={14} /> 记忆
          <span className="mem-tab-count">{memories.length}</span>
        </button>
        <button className={'tools-tab' + (tab === 'worklog' ? ' active' : '')} onClick={() => setTab('worklog')}>
          <NotebookPen size={14} /> 工作日志
          <span className="mem-tab-count">{logs.length}</span>
        </button>
      </div>
      <div className="tools-body">
        <div className="manage-page">
          <div className="mem-body">
            <div className="mem-container">
              <div className="mem-header">
                <div>
                  <h2 className="mem-heading">{tab === 'memory' ? '长期记忆' : '工作日志'}</h2>
                  <p className="mem-sub">
                    {tab === 'memory'
                      ? '跨会话沉淀的项目事实、架构决策与用户偏好，按工作区隔离并自动注入上下文索引。'
                      : '每轮对话结束后自动归纳的工程进展与变更摘要，方便回溯每日工作脉络。'}
                  </p>
                </div>
                <div className="mem-header-actions">
                  <button className="mem-icon-btn" onClick={load} disabled={loading} title="刷新">
                    <RefreshCw size={15} className={loading ? 'spin' : ''} />
                  </button>
                  {tab === 'memory' && (
                    <button
                      className="mem-btn-primary mem-new-btn"
                      onClick={() => setEditing({ kind: 'memory', title: '', content: '', tags: '', workspace: wsFilter || '' })}
                    >
                      <Plus size={15} /> 新建记忆
                    </button>
                  )}
                </div>
              </div>

              <div className="mem-toolbar">
                <div className="mem-search">
                  <Search size={14} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={tab === 'memory' ? '搜索标题、内容或标签…' : '搜索日志标题或内容…'}
                  />
                  {query && (
                    <button type="button" className="mem-search-clear" onClick={() => setQuery('')} title="清空搜索">
                      <X size={13} />
                    </button>
                  )}
                </div>
                <select className="mem-select" value={wsFilter} onChange={(e) => setWsFilter(e.target.value)} title="按项目筛选">
                  <option value="">全部项目</option>
                  {wsOptions.map((ws) => <option key={ws} value={ws}>{projName(ws)}</option>)}
                </select>
                {tab === 'worklog' && (
                  <div className="mem-seg" role="group" aria-label="时间范围">
                    {DAY_RANGES.map((r) => (
                      <button
                        key={r.value}
                        type="button"
                        className={'mem-seg-btn' + (days === r.value ? ' active' : '')}
                        onClick={() => setDays(r.value)}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                )}
                <span className="mem-count">
                  {tab === 'memory' ? `共 ${filteredMemories.length} 条记忆` : `共 ${filteredLogs.length} 条日志`}
                </span>
              </div>

              {tab === 'memory' ? (
                <div className="mem-list">
                  {filteredMemories.map((m) => {
                    const tags = splitTags(m.tags);
                    return (
                      <div
                        key={m.id}
                        className="mem-row"
                        onClick={() => setEditing({
                          kind: 'memory', id: m.id, title: m.title, content: m.content, tags: m.tags, workspace: m.workspace,
                        })}
                      >
                        <div className="mem-row-top">
                          <div className="mem-row-title">{m.title}</div>
                          <div className="mem-row-meta">
                            {badge(m.workspace)}
                            <span className="mem-time">{fmtShortDate(m.updatedAt)}</span>
                            <button
                              className="mem-del-btn"
                              title="删除"
                              onClick={(e) => { e.stopPropagation(); void remove('memory', m.id); }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                        <div className="mem-row-content">{m.content}</div>
                        {tags.length > 0 && (
                          <div className="mem-tag-list">
                            {tags.slice(0, 8).map((tag) => (
                              <span key={tag} className="mem-tag-pill"><Hash size={10} />{tag}</span>
                            ))}
                            {tags.length > 8 && <span className="mem-tag-more">+{tags.length - 8}</span>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!filteredMemories.length && (
                    <div className="mem-empty">
                      <Brain size={30} className="mem-empty-icon" />
                      <strong>{q ? '没有匹配的记忆' : '还没有长期记忆'}</strong>
                      <span>{q ? '试试换个关键词，或切换项目筛选范围。' : '对话里学到的项目事实与偏好会自动沉淀到这里，也可以点右上角手动新建。'}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="mem-timeline">
                  {logsByDay.map(([day, items]) => {
                    const rel = dayTag(day);
                    return (
                      <div key={day} className="mem-day">
                        <div className="mem-day-label">
                          <Calendar size={13} />
                          <span>{day}</span>
                          {rel && <span className="mem-day-rel">{rel}</span>}
                          <span className="mem-day-count">{items.length} 条</span>
                        </div>
                        <div className="mem-day-items">
                          {items.map((l) => (
                            <div
                              key={l.id}
                              className="mem-row mem-log-row"
                              onClick={() => setEditing({ kind: 'worklog', id: l.id, title: l.title, content: l.content })}
                            >
                              <div className="mem-row-top">
                                <span className="mem-log-time">{fmtTime(l.createdAt)}</span>
                                <div className="mem-row-title">{l.title}</div>
                                <div className="mem-row-meta">
                                  {badge(l.workspace)}
                                  <button
                                    className="mem-del-btn"
                                    title="删除"
                                    onClick={(e) => { e.stopPropagation(); void remove('worklog', l.id); }}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>
                              <div className="mem-row-content">{l.content}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {!filteredLogs.length && (
                    <div className="mem-empty">
                      <NotebookPen size={30} className="mem-empty-icon" />
                      <strong>{q ? '没有匹配的工作日志' : '当前时间范围暂无日志'}</strong>
                      <span>{q ? '试试换个关键词或放宽时间范围。' : '每轮对话结束后系统会自动归纳并记录工作日志。'}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal mem-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{editing.kind === 'memory' ? (editing.id ? '编辑记忆' : '新建记忆') : '编辑工作日志'}</span>
              <button className="skill-detail-close" onClick={() => setEditing(null)} title="关闭（Esc）"><X size={16} /></button>
            </div>
            <div className="mem-edit-body">
              <label className="mem-field">
                <span>标题</span>
                <input className="mem-input" placeholder="简明概括这条记忆或日志" value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
              </label>
              <label className="mem-field">
                <span>内容</span>
                <textarea className="mem-textarea" placeholder={editing.kind === 'memory' ? '记录具体事实、架构决策、环境约定或踩坑教训…' : '做了什么、结果如何…'}
                  value={editing.content} rows={8}
                  onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
              </label>
              {editing.kind === 'memory' && (
                <div className="mem-field-row">
                  <label className="mem-field">
                    <span>标签</span>
                    <input className="mem-input" placeholder="多个标签用逗号分隔，如 rag, qdrant, 部署" value={editing.tags}
                      onChange={(e) => setEditing({ ...editing, tags: e.target.value })} />
                  </label>
                  <label className="mem-field mem-field-ws">
                    <span>所属项目</span>
                    <select className="mem-select" value={editing.workspace ?? ''} onChange={(e) => setEditing({ ...editing, workspace: e.target.value })}>
                      <option value="">通用（跨项目）</option>
                      {wsOptions.map((ws) => <option key={ws} value={ws}>{projName(ws)}</option>)}
                    </select>
                  </label>
                </div>
              )}
              <div className="mem-edit-actions">
                <button type="button" className="mem-btn-ghost" onClick={() => setEditing(null)}>取消</button>
                <button type="button" className="mem-btn-primary" disabled={!editing.title.trim() || !editing.content.trim()} onClick={() => void saveEditing()}>保存</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
