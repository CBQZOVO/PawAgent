import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRightLeft, BarChart3, Box, Brain, Briefcase, Check, ChevronDown, Clock, Compass,
  Download, Eye, FileText, Folder, Globe, GripVertical, LayoutGrid, Link2, MessageSquare,
  MessageSquarePlus, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plug, Plus,
  Search, Shield, Sparkles, Trash2, Upload, X,
} from 'lucide-react';
import type { Session, SessionPermission, SessionSearchResult } from '@paw/shared';
import { getWorkspace, searchSessionsApi, setWorkspace, WORKSPACE_CHANGED, type PluginPageInfo, type SearchProvider, type WorkspaceInfo } from '../api/client';
import ProviderMenu from './ProviderMenu';
import WorkspacePicker from './WorkspacePicker';
import Tips from './Tips';
import { useColumnResize, storedWidth } from '../hooks/useColumnResize';

/** 侧栏宽度：Agent 默认 260px；IDE 模式固定 360px 起步，可拖到 440px */
const SIDE_DEFAULT_WIDTH = 260;
const SIDE_MIN_WIDTH = 220;
const SIDE_MAX_WIDTH = 560;
export const SIDE_IDE_WIDTH = 360;
const SIDE_IDE_MAX_WIDTH = 440;
const NAV_ORDER_KEY = 'paw-sidebar-nav-order';

function loadSavedNavOrder(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(NAV_ORDER_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function renderPluginIcon(icon?: string): ReactNode {
  switch ((icon || '').toLowerCase()) {
    case 'briefcase': return <Briefcase size={14} />;
    case 'layout': case 'layout-grid': case 'grid': return <LayoutGrid size={14} />;
    case 'globe': return <Globe size={14} />;
    case 'sparkles': return <Sparkles size={14} />;
    case 'compass': return <Compass size={14} />;
    case 'file': case 'file-text': return <FileText size={14} />;
    case 'bar-chart': case 'chart': return <BarChart3 size={14} />;
    case 'folder': return <Folder size={14} />;
    case 'plug': return <Plug size={14} />;
    case 'box': case '': return <Box size={14} />;
    default: return <span className="side-emoji-icon">{icon}</span>;
  }
}

/** 左侧栏：品牌 + 新会话 + 可定制菜单 + 会话列表 + 搜索引擎切换 */
const RECENT_PREVIEW_COUNT = 5;
export default function Sidebar({
  sessions, activeId, provider, hasKey, providerMenu,
  onNew, onSelect, onDelete, onHandoffSession, onExportSession, onImportSessions, onSetPermissionMode,
  onProviderToggle, onProviderClose, onProviderSwitch, onTasks, onMemory, onRemoveWorkspace, onNewInWorkspace, page, onPage,
  collapsed, onToggleCollapse, ideMode, runningIds, toolsTab,
  pluginPages = [], activePluginPageKey = null, onOpenPluginPage,
}: {
  sessions: Session[];
  activeId: string;
  runningIds: Set<string>;
  provider: SearchProvider;
  hasKey: boolean;
  providerMenu: boolean;
  onNew: () => void;
  onNewInWorkspace: (root: string) => void;
  onSelect: (id: string, messageId?: string) => void;
  onDelete: (id: string) => void;
  onHandoffSession?: (id: string) => void;
  onExportSession?: (id: string) => void;
  onImportSessions?: (file: File) => void;
  onSetPermissionMode?: (id: string, mode: SessionPermission['mode']) => void;
  onRemoveWorkspace: (root: string) => void;
  onProviderToggle: () => void;
  onProviderClose: () => void;
  onProviderSwitch: (p: SearchProvider) => void;
  onTasks: () => void;
  onMemory: () => void;
  page: 'chat' | 'tools' | 'tasks' | 'memory' | 'plugin';
  toolsTab: 'mcp' | 'skills' | 'plugins' | 'connections' | 'permissions';
  onPage: (p: 'chat' | 'tools', tab?: 'mcp' | 'skills' | 'plugins' | 'connections' | 'permissions') => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  ideMode: boolean;
  pluginPages?: PluginPageInfo[];
  activePluginPageKey?: string | null;
  onOpenPluginPage?: (key: string) => void;
}) {
  const [navOrder, setNavOrder] = useState<string[]>(() => loadSavedNavOrder());
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [wsOpen, setWsOpen] = useState<Record<string, boolean>>({});
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [wsInfo, setWsInfo] = useState<WorkspaceInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<SessionSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState<{ key: string; left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const closeMenu = () => setMenu(null);
  const openMenu = (key: string) => (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (menu?.key === key) { setMenu(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const menuH = key.startsWith('session:') ? 240 : 56;
    const openUp = r.bottom + 4 + menuH > window.innerHeight - 8;
    setMenu({
      key,
      left: Math.max(8, Math.min(r.right - 180, window.innerWidth - 188)),
      top: openUp ? Math.max(8, r.top - menuH - 4) : r.bottom + 4,
    });
  };
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);
  const menuItem = (label: string, icon: ReactNode, onClick: () => void, danger = false, selected = false) => (
    <button
      className={'row-menu-item' + (danger ? ' danger' : '') + (selected ? ' selected' : '')}
      onClick={(e) => { e.stopPropagation(); closeMenu(); onClick(); }}
    >
      {icon}<span>{label}</span>
      {selected && <Check size={13} className="row-menu-check" />}
    </button>
  );
  const renderMenu = (key: string, children: ReactNode) => {
    if (menu?.key !== key) return null;
    return createPortal(
      <div ref={menuRef} className="row-menu" style={{ left: menu.left, top: menu.top }}>{children}</div>,
      document.body,
    );
  };
  const [peekOpen, setPeekOpen] = useState(false);
  useEffect(() => { if (!collapsed) setPeekOpen(false); }, [collapsed]);
  const [agentWidth, setAgentWidth] = useState(() => storedWidth('paw-side-width', SIDE_DEFAULT_WIDTH, SIDE_MIN_WIDTH, SIDE_MAX_WIDTH));
  const [ideWidth, setIdeWidth] = useState(() => storedWidth('paw-side-width-ide', SIDE_IDE_WIDTH, SIDE_IDE_WIDTH, SIDE_MAX_WIDTH));
  const sideWidth = ideMode ? ideWidth : agentWidth;
  const setSideWidth = ideMode ? setIdeWidth : setAgentWidth;
  const sideMax = ideMode ? SIDE_IDE_MAX_WIDTH : SIDE_MAX_WIDTH;
  const effWidth = Math.min(sideWidth, sideMax);
  const resize = useColumnResize(effWidth, setSideWidth, {
    min: ideMode ? SIDE_IDE_WIDTH : SIDE_MIN_WIDTH,
    max: sideMax,
    storeKey: ideMode ? 'paw-side-width-ide' : 'paw-side-width',
    defaultWidth: ideMode ? SIDE_IDE_WIDTH : SIDE_DEFAULT_WIDTH,
  });
  useEffect(() => {
    const load = () => void getWorkspace().then(setWsInfo);
    load();
    window.addEventListener(WORKSPACE_CHANGED, load);
    return () => window.removeEventListener(WORKSPACE_CHANGED, load);
  }, []);
  useEffect(() => {
    const root = wsInfo?.root;
    if (!root) return;
    setWsOpen((p) => (p[root] ? p : { ...p, [root]: true }));
  }, [wsInfo?.root]);

  const trimmedQuery = searchQuery.trim();
  useEffect(() => {
    if (!trimmedQuery) {
      setSearchHits([]);
      setSearching(false);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      searchSessionsApi(trimmedQuery, { limit: 50, signal: ctrl.signal })
        .then((res) => { if (!ctrl.signal.aborted) { setSearchHits(res); setSearching(false); } })
        .catch(() => { if (!ctrl.signal.aborted) { setSearchHits([]); setSearching(false); } });
    }, 200);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [trimmedQuery]);

  const navItems = useMemo(() => {
    const all: Array<{
      key: string;
      label: string;
      icon: ReactNode;
      order: number;
      active: boolean;
      onClick: () => void;
    }> = [
      {
        key: 'builtin:tools',
        label: 'MCP · SKILL · 插件',
        icon: <Plug size={14} />,
        order: 10,
        active: page === 'tools' && toolsTab !== 'connections',
        onClick: () => onPage(page === 'tools' && toolsTab === 'mcp' ? 'chat' : 'tools', 'mcp'),
      },
      {
        key: 'builtin:connections',
        label: '系统连接',
        icon: <Link2 size={14} />,
        order: 20,
        active: page === 'tools' && toolsTab === 'connections',
        onClick: () => onPage(page === 'tools' && toolsTab === 'connections' ? 'chat' : 'tools', 'connections'),
      },
      {
        key: 'builtin:tasks',
        label: '定时任务',
        icon: <Clock size={14} />,
        order: 30,
        active: page === 'tasks',
        onClick: onTasks,
      },
      {
        key: 'builtin:memory',
        label: '记忆 · 日志',
        icon: <Brain size={14} />,
        order: 40,
        active: page === 'memory',
        onClick: onMemory,
      },
      ...pluginPages.map((p) => ({
        key: p.key,
        label: p.label,
        icon: renderPluginIcon(p.icon),
        order: p.order,
        active: page === 'plugin' && activePluginPageKey === p.key,
        onClick: () => onOpenPluginPage?.(p.key),
      })),
    ];

    if (!navOrder.length) {
      return [...all].sort((a, b) => a.order - b.order);
    }
    const byKey = new Map(all.map((item) => [item.key, item]));
    const placed: typeof all = [];
    const used = new Set<string>();
    for (const k of navOrder) {
      const item = byKey.get(k);
      if (item) { placed.push(item); used.add(k); }
    }
    const fresh = all.filter((item) => !used.has(item.key)).sort((a, b) => a.order - b.order);
    const merged = [...placed];
    for (const item of fresh) {
      const idx = merged.findIndex((existing) => existing.order > item.order);
      if (idx < 0) merged.push(item);
      else merged.splice(idx, 0, item);
    }
    return merged;
  }, [page, toolsTab, onPage, onTasks, onMemory, pluginPages, activePluginPageKey, onOpenPluginPage, navOrder]);

  const handleNavDrop = (targetKey: string) => {
    if (!dragKey || dragKey === targetKey) {
      setDragKey(null);
      setDragOverKey(null);
      return;
    }
    const keys = navItems.map((i) => i.key);
    const from = keys.indexOf(dragKey);
    const to = keys.indexOf(targetKey);
    if (from >= 0 && to >= 0) {
      const next = [...keys];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setNavOrder(next);
      try { localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    }
    setDragKey(null);
    setDragOverKey(null);
  };

  const chatSessions = sessions.filter((s) => s.source !== 'task' && s.source !== 'subagent');
  const titleHits = useMemo(() => {
    if (!trimmedQuery) return [];
    const q = trimmedQuery.toLowerCase();
    return chatSessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [chatSessions, trimmedQuery]);
  const renderHighlighted = (text: string) => {
    if (!trimmedQuery) return text;
    const lower = text.toLowerCase();
    const q = trimmedQuery.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="side-search-mark">{text.slice(idx, idx + trimmedQuery.length)}</mark>
        {text.slice(idx + trimmedQuery.length)}
      </>
    );
  };
  const byWorkspace: Record<string, Session[]> = {};
  const recentSessions: Session[] = [];
  for (const s of chatSessions) {
    if (s.workspace) (byWorkspace[s.workspace] ||= []).push(s);
    else recentSessions.push(s);
  }
  const workspaceRoots = [...new Set([...(wsInfo?.workspaces || []), ...Object.keys(byWorkspace)])];
  const switchWorkspace = (ws: string) => {
    void setWorkspace(ws);
    setWsOpen((p) => ({ ...p, [ws]: !p[ws] }));
  };
  const wsShort = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-1)[0] || p;
  const renderSession = (s: Session, nested = false) => {
    const busy = runningIds.has(s.id);
    const mode: SessionPermission['mode'] = s.permission?.mode ?? 'default';
    const key = `session:${s.id}`;
    return (
      <div
        key={s.id}
        className={'session-item' + (nested ? ' nested' : '') + (s.id === activeId ? ' active' : '')}
        onClick={() => onSelect(s.id)}
      >
        {!nested && <MessageSquare size={14} className="session-icon" />}
        <span className="session-title">{s.title}</span>
        {mode !== 'default' && (
          <span className="session-strict-badge" title={mode === 'plan' ? '只读计划模式：禁止修改操作' : '严格确认模式：工具调用逐次确认'}>
            {mode === 'plan' ? <Eye size={11} /> : <Shield size={11} />}
          </span>
        )}
        {busy ? (
          <span className="session-spin" title="正在生成" aria-label="正在生成" />
        ) : (
          <span className="session-actions">
            <button className="row-icon-btn" aria-label="更多操作" onClick={openMenu(key)}>
              <MoreHorizontal size={18} strokeWidth={2.2} />
            </button>
          </span>
        )}
        {renderMenu(key, <>
          {onSetPermissionMode && (
            <>
              {menuItem('默认模式', <Shield size={15} />, () => onSetPermissionMode(s.id, 'default'), false, mode === 'default')}
              {menuItem('严格确认', <Shield size={15} />, () => onSetPermissionMode(s.id, 'strict'), false, mode === 'strict')}
              {menuItem('只读计划', <Eye size={15} />, () => onSetPermissionMode(s.id, 'plan'), false, mode === 'plan')}
            </>
          )}
          {onExportSession && menuItem('导出会话 JSON', <Download size={15} />, () => onExportSession(s.id))}
          {onHandoffSession && menuItem('交接到新会话', <ArrowRightLeft size={15} />, () => onHandoffSession(s.id))}
          {menuItem('删除会话', <Trash2 size={15} />, () => onDelete(s.id), true)}
        </>)}
      </div>
    );
  };

  return (
    <aside className={'sidebar' + (collapsed ? ' collapsed' : '')}
      style={{ width: collapsed ? 0 : effWidth, flexBasis: collapsed ? 0 : effWidth }}>
      {!collapsed && <div className="col-resizer" title="拖动调整侧栏宽度（双击还原）" {...resize} />}
      {collapsed && !ideMode && <div className="side-peek-zone"
        onMouseEnter={() => setPeekOpen(true)} onMouseLeave={() => setPeekOpen(false)} />}
      <div className={'side-body' + (peekOpen ? ' peeking' : '')}
        onMouseEnter={() => { if (collapsed) setPeekOpen(true); }}
        onMouseLeave={() => { if (collapsed) setPeekOpen(false); }}>
      <div className="side-head">
        <div className="side-top">
          <div className="brand">
            <span className="brand-mark">🐾</span>
            <span>Paw</span>
          </div>
          <button className="side-collapse-btn" aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            title={collapsed ? '展开侧栏' : '收起侧栏'} onClick={onToggleCollapse}>
            {collapsed ? <PanelLeftOpen size={16} strokeWidth={2.1} /> : <PanelLeftClose size={16} strokeWidth={2.1} />}
          </button>
        </div>
        <div className="side-new-row">
          <button className="new-btn" onClick={onNew}>
            <Plus size={15} /> 新会话
          </button>
          {onImportSessions && (
            <>
              <input
                ref={importInputRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) onImportSessions(file);
                }}
              />
              <Tips label="导入会话 JSON（工具输出可能含敏感信息，请确认后再分享）">
                <button
                  type="button"
                  className="side-import-btn"
                  aria-label="导入会话"
                  onClick={() => importInputRef.current?.click()}
                >
                  <Upload size={15} />
                </button>
              </Tips>
            </>
          )}
        </div>
        <div className="side-search">
          <Search size={13} className="side-search-icon" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && searchQuery) setSearchQuery(''); }}
            placeholder="搜索会话与消息…"
            aria-label="搜索会话与历史消息"
          />
          {searchQuery && (
            <button type="button" className="side-search-clear" aria-label="清空搜索" onClick={() => setSearchQuery('')}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      {!trimmedQuery && (
        <div className="side-fixed-nav">
          <div className="side-label">工具与自动化</div>
          {navItems.map((item) => (
            <button
              key={item.key}
              draggable
              onDragStart={(e) => {
                setDragKey(item.key);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', item.key);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dragOverKey !== item.key) setDragOverKey(item.key);
              }}
              onDragLeave={() => { if (dragOverKey === item.key) setDragOverKey(null); }}
              onDrop={(e) => { e.preventDefault(); handleNavDrop(item.key); }}
              onDragEnd={() => { setDragKey(null); setDragOverKey(null); }}
              className={
                'side-automation'
                + (item.active ? ' active' : '')
                + (dragKey === item.key ? ' dragging' : '')
                + (dragOverKey === item.key && dragKey !== item.key ? ' drag-over' : '')
              }
              onClick={item.onClick}
              title="拖动可调整菜单顺序"
            >
              {item.icon}
              <span className="side-nav-label">{item.label}</span>
              <GripVertical size={12} className="side-drag-handle" />
            </button>
          ))}
        </div>
      )}
      <div className="side-scroll-area">
        {trimmedQuery ? (
          <div className="side-search-results">
            {titleHits.length > 0 && (
              <>
                <div className="side-label">会话标题 ({titleHits.length})</div>
                <div className="session-list">
                  {titleHits.map((s) => renderSession(s))}
                </div>
              </>
            )}
            <div className="side-label">
              历史消息 {searching ? '· 搜索中…' : `(${searchHits.length})`}
            </div>
            {searchHits.length > 0 ? (
              <div className="session-list">
                {searchHits.map((hit) => (
                  <button
                    key={`${hit.sessionId}:${hit.messageId}`}
                    type="button"
                    className={'side-search-hit' + (hit.sessionId === activeId ? ' active' : '')}
                    onClick={() => onSelect(hit.sessionId, hit.messageId)}
                  >
                    <div className="side-search-hit-head">
                      <span className="side-search-hit-title">{hit.title}</span>
                      <span className="side-search-hit-role">{hit.role === 'user' ? '你' : '助手'}</span>
                    </div>
                    <div className="side-search-hit-snippet">{renderHighlighted(hit.snippet)}</div>
                  </button>
                ))}
              </div>
            ) : !searching ? (
              <div className="side-empty">{titleHits.length ? '无更多正文匹配' : '没有找到匹配的会话或消息'}</div>
            ) : null}
          </div>
        ) : (
          <>
        <div className="side-label ws-label-row">
          <span>工作区</span>
          <WorkspacePicker variant="plus" />
        </div>
        {workspaceRoots.map((ws) => {
          const list = byWorkspace[ws] || [];
          const current = wsInfo?.root === ws;
          const key = `ws:${ws}`;
          return (
            <div key={ws}>
              <div className={'side-ws-row' + (current ? ' current' : '')}>
                <button
                  className="side-group-head"
                  onClick={() => switchWorkspace(ws)}
                  title={current ? `${ws}（当前工作区）` : `${ws}\n点击切换工作区`}
                >
                  <ChevronDown size={13} className={wsOpen[ws] ? '' : 'collapsed'} />
                  <Folder size={13} /> <span className="ws-folder-name">{wsShort(ws)}</span>
                </button>
                <div className="ws-actions">
                  <Tips label="在此工作区新建会话">
                    <button className="row-icon-btn" aria-label="在此工作区新建会话" onClick={() => onNewInWorkspace(ws)}>
                      <MessageSquarePlus size={18} strokeWidth={2} />
                    </button>
                  </Tips>
                  <button className="row-icon-btn" aria-label="更多操作" onClick={openMenu(key)}>
                    <MoreHorizontal size={18} strokeWidth={2.2} />
                  </button>
                </div>
                {renderMenu(key, <>
                  {menuItem('移除工作区', <Trash2 size={15} />, () => onRemoveWorkspace(ws), true)}
                </>)}
              </div>
              {wsOpen[ws] && <div className="session-list task-sessions">{list.map((s) => renderSession(s, true))}</div>}
            </div>
          );
        })}
        {workspaceRoots.length === 0 && <div className="side-ws-empty">点 + 选一个工作区开始</div>}

        <div className="side-label">最近任务</div>
        <div className="session-list">
          {recentSessions.length === 0 && <div className="side-empty">还没有对话</div>}
          {(recentExpanded ? recentSessions : recentSessions.slice(0, RECENT_PREVIEW_COUNT)).map((s) => renderSession(s))}
          {recentSessions.length > RECENT_PREVIEW_COUNT && (
            <button
              type="button"
              className="side-recent-more"
              onClick={() => setRecentExpanded((v) => !v)}
            >
              {recentExpanded ? '收起' : <>查看更多 ({recentSessions.length}) <ChevronDown size={13} /></>}
            </button>
          )}
        </div>
          </>
        )}
      </div>
      <ProviderMenu
        provider={provider} hasKey={hasKey} open={providerMenu}
        onToggle={onProviderToggle} onClose={onProviderClose} onSwitch={onProviderSwitch}
      />
      </div>
    </aside>
  );
}
