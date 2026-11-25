import { useEffect, useRef, useState } from 'react';
import { Check, FolderPlus, FolderOpen, Pencil, Plus, Search, X } from 'lucide-react';
import { getWorkspace, setWorkspace, removeWorkspace as removeWorkspaceApi, pickWorkspaceFolder, WORKSPACE_CHANGED, type WorkspaceInfo } from '../api/client';
import Tips from './Tips';
import { useImeGuard } from '../lib/ime';

/**
 * 工作区切换器。两种触发样式：
 * - plus：侧栏"工作区"分组标题旁的 + 按钮
 * - chip：输入框旁的轻量指示（显示当前工作区名）
 * 弹窗只列「已添加的工作区」+「选择本地文件夹」（Finder 选完即添加并切换）。
 */
export default function WorkspacePicker({ variant = 'chip' }: { variant?: 'plus' | 'chip' }) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState('');
  const ime = useImeGuard(); // 手输路径时中文字符也要能按 Enter 选词
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = () => void getWorkspace().then(setInfo);
  useEffect(() => {
    load();
    window.addEventListener(WORKSPACE_CHANGED, load);
    return () => window.removeEventListener(WORKSPACE_CHANGED, load);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const choose = async (root: string | null) => {
    await setWorkspace(root);
    setOpen(false); setAdding(false);
    load();
  };
  // 弹 Finder 选一个本地文件夹：设为当前工作区（后端会自动把它加进工作区列表）
  const pickFolder = async (keepOpen = false) => {
    setPicking(true);
    try {
      const desktop = (window as unknown as { pawDesktop?: { pickFolder: () => Promise<string | null> } }).pawDesktop;
      const root = desktop ? await desktop.pickFolder() : await pickWorkspaceFolder();
      if (root) { await setWorkspace(root); setAdding(false); setQuery(''); load(); if (!keepOpen) setOpen(false); }
    } finally { setPicking(false); }
  };
  const basename = (p: string) => p.split('/').filter(Boolean).slice(-1)[0] || p;
  // 搜索过滤已添加的工作区
  const workspaces = (info?.workspaces || []).filter((p) => !query || p.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="ws-picker" ref={wrapRef}>
      {variant === 'plus' ? (
        <Tips label="添加工作区（打开文件夹选择器）">
          <button className="ws-add-btn" aria-label="添加工作区" onClick={() => void pickFolder()}><Plus size={16} strokeWidth={2.2} /></button>
        </Tips>
      ) : (
        <button className={'ws-chip' + (info?.root ? ' set' : '')} onClick={() => setOpen((v) => !v)} title={info?.root || '切换工作区'}>
          <FolderOpen size={13} />
          <span>{info?.root ? basename(info.root) : '工作区'}</span>
        </button>
      )}
      {open && (
        <div className="ws-menu popup-up">
          {/* 搜索已添加的工作区 */}
          <div className="ws-search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索工作区" autoFocus />
            <button onClick={() => setAdding((v) => !v)} title="手动输入路径"><Pencil size={12} /></button>
          </div>
          {adding && (
            <div className="ws-manual">
              <input autoFocus value={manual} onChange={(e) => setManual(e.target.value)} onCompositionStart={ime.handlers.onCompositionStart} onCompositionEnd={ime.handlers.onCompositionEnd} onKeyDown={(e) => { if (ime.isComposing(e)) return; if (e.key === 'Enter' && manual.trim()) void choose(manual.trim()); }} placeholder="输入绝对路径，回车添加" />
              <button onClick={() => { if (manual.trim()) void choose(manual.trim()); }}>添加</button>
            </div>
          )}
          {/* 已添加的工作区列表（点击切换当前） */}
          <div className="ws-list">
            {workspaces.map((p) => (
              <div key={p} className={'ws-row' + (p === info?.root ? ' selected' : '')}>
                <button className="ws-opt" onClick={() => void choose(p)} title={p}>
                  <FolderOpen size={13} />
                  <span>{basename(p)}</span>
                  {p === info?.root && <Check size={13} />}
                </button>
                <button className="ws-remove" onClick={() => void removeWorkspaceApi(p).then(load)} title="从列表移除（不删磁盘文件）"><X size={12} /></button>
              </div>
            ))}
            {workspaces.length === 0 && <div className="ws-empty">还没有工作区，选一个本地文件夹吧</div>}
          </div>
          {/* 底部：Finder 选文件夹 */}
          <button className="ws-pick-local" onClick={() => void pickFolder(true)} disabled={picking}>
            <FolderPlus size={14} /> {picking ? '打开中…' : '选择本地文件夹'}
          </button>
        </div>
      )}
    </div>
  );
}
