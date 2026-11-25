import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, Code2, Columns2, Copy, Eye, File, FileCode2, Folder, FolderOpen, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Search, SquareTerminal, X } from 'lucide-react';
import { getFsFile, getFsTree, type FsEntry, type FsFile } from '../api/client';
import { extOf, fileHue } from '../lib/highlight';
import { isRawPreviewable, MONACO_LANG } from '../lib/file-preview';
import { useColumnResize, storedWidth } from '../hooks/useColumnResize';
import MarkdownPreview from './MarkdownPreview';
import ContextMenu, { type CtxItem } from './ContextMenu';
import CodeEditor from './CodeEditor';
import TerminalPanel from './TerminalPanel';
import Tips from './Tips';

type EditorTheme = 'light' | 'dark';
const THEME_KEY = 'paw-editor-theme';
/** Markdown 视图模式：源码 / 预览 / 左右分栏（按文件记住） */
type MdView = 'code' | 'preview' | 'split';
const MD_VIEW_KEY = 'paw-md-view';
const TERM_H_KEY = 'paw-term-height';
const TERM_OPEN_KEY = 'paw-term-open';
const TERM_DEFAULT_H = 260;
const isMarkdown = (ext: string) => ext === 'md' || ext === 'markdown' || ext === 'mdx';
/** 图片/PDF 交给浏览器原生预览（跟后端 RAW_MIME 保持一致） */
const isRawPreview = isRawPreviewable;

/** 单个引用最多带这么多字符（和上传附件的 20 万上限保持一致） */
const REF_MAX_CHARS = 200_000;
/** 引用里的 mime：模型靠它判断语言，不认识的按纯文本 */
const REF_MIME: Record<string, string> = {
  ts: 'text/typescript', tsx: 'text/typescript', js: 'text/javascript', jsx: 'text/javascript',
  mjs: 'text/javascript', cjs: 'text/javascript', json: 'application/json',
  css: 'text/css', scss: 'text/css', less: 'text/css', html: 'text/html', vue: 'text/html',
  md: 'text/markdown', py: 'text/x-python', java: 'text/x-java', kt: 'text/x-kotlin',
  go: 'text/x-go', rs: 'text/x-rust', yml: 'text/yaml', yaml: 'text/yaml',
  sh: 'text/x-sh', sql: 'text/x-sql', xml: 'text/xml',
};

function applyEditorTheme(t: EditorTheme) {
  document.documentElement.setAttribute('data-editor-theme', t);
  localStorage.setItem(THEME_KEY, t);
}

interface TreeNodeProps {
  entry: FsEntry;
  root: string;
  depth: number;
  activePath: string | null;
  changedPaths: Set<string>;
  onOpen: (path: string) => void;
  /** 右键：把条目抛给面板统一弹菜单（文件/文件夹都能引用到对话） */
  onContext: (e: React.MouseEvent, entry: FsEntry) => void;
}

/**
 * 文件树节点：目录懒加载单层，文件点击开标签。
 * memo 很关键：终端每帧输出、拖分割线、滚动都会让 IdePanel 重渲染，
 * 不 memo 的话几百个树节点跟着全部重建（含 icon 组件），点文件时明显卡顿。
 */
const TreeNode = memo(function TreeNode({ entry, root, depth, activePath, changedPaths, onOpen, onContext }: TreeNodeProps) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [total, setTotal] = useState(0);
  // 大目录搜索：6300+ 子目录的扁平模块目录按字母截断后，后面的永远点不到
  const [query, setQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  const load = useCallback(async (q?: string) => {
    setLoading(true);
    const r = await getFsTree(root, entry.path, q);
    setChildren(r.entries || []);
    setTruncated(!!r.truncated);
    setTotal(r.total ?? (r.entries?.length || 0));
    setLoading(false);
  }, [root, entry.path]);

  // 输入防抖：避免每敲一个字母就打一次接口
  useEffect(() => {
    if (!showSearch) return;
    const t = setTimeout(() => void load(query), 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, showSearch]);

  // 目录一律不自动展开：打开工作区就把几千个目录全铺开，既慢又没有意义。
  // 用户点哪个展哪个，状态与内容永远一致（不要只改 open 不拉 children）。

  const toggle = async () => {
    if (!entry.dir) { onOpen(entry.path); return; }
    const next = !open;
    setOpen(next);
    if (next && children === null && !loading) await load();
  };

  const ext = extOf(entry.name);
  const changed = changedPaths.has(entry.path);
  return (
    <div className="tree-node">
      <button
        className={'tree-row' + (activePath === entry.path ? ' active' : '') + (changed ? ' changed' : '')}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => void toggle()}
        onContextMenu={(e) => onContext(e, entry)}
        title={entry.path}
      >
        {entry.dir ? (
          <>
            {open ? <ChevronDown size={12} className="tree-arrow" /> : <ChevronRight size={12} className="tree-arrow" />}
            {open ? <FolderOpen size={13} className="tree-folder" /> : <Folder size={13} className="tree-folder" />}
          </>
        ) : (
          <>
            <span className="tree-arrow-spacer" />
            <FileCode2 size={13} style={{ color: fileHue(ext) }} />
          </>
        )}
        <span className="tree-name">{entry.name}</span>
        {changed && <span className="tree-changed-dot" title="Agent 本轮修改过" />}
      </button>
      {entry.dir && open && (
        <div className="tree-children">
          {/* 项数过多时给搜索入口：不搜索就只能看到字母序前 400 项 */}
          {(truncated || showSearch) && (
            <div className="tree-filter" style={{ paddingLeft: 20 + depth * 14 }}>
              <Search size={11} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`在 ${total} 项中筛选…`}
                aria-label={`在 ${entry.name} 中筛选`}
              />
              {query && <button className="tree-filter-clear" aria-label="清空筛选" onClick={() => setQuery('')}><X size={10} /></button>}
            </div>
          )}
          {loading && <div className="tree-loading" style={{ paddingLeft: 22 + depth * 14 }}>加载中…</div>}
          {children?.map((c) => (
            <TreeNode key={c.path} entry={c} root={root} depth={depth + 1}
              activePath={activePath} changedPaths={changedPaths} onOpen={onOpen} onContext={onContext} />
          ))}
          {children && children.length === 0 && !loading && (
            <div className="tree-loading" style={{ paddingLeft: 22 + depth * 14 }}>{query ? '无匹配' : '（空）'}</div>
          )}
          {truncated && (
            <div className="tree-loading" style={{ paddingLeft: 22 + depth * 14 }}>
              共 {total} 项，仅显示前 {children?.length} 项
              {!showSearch && <button className="tree-filter-more" onClick={() => setShowSearch(true)}>筛选</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export interface IdeTab { path: string; name: string }

const TREE_DEFAULT = 260;
const TREE_MIN = 180;
const TREE_MAX = 520;
/** 代码区保底宽度：文件树再宽也不能把代码挤没了 */
const CODE_MIN = 340;

/**
 * IDE 面板：左文件树 + 右代码查看器（标签页/行号/语法着色）。
 * Agent 改过的文件打变更点；正在看的文件被改时自动重载。
 */
export default function IdePanel({ root, changedPaths, reloadTick, chatHidden, onToggleChat, onAddRef }: {
  root: string;
  changedPaths: Set<string>;   // 本会话 Agent 写/改/删过的文件绝对路径
  reloadTick: number;          // 每次工具写文件后 +1，触发当前标签重载
  chatHidden: boolean;         // 右侧对话区是否收起（代码区铺满）
  onToggleChat: () => void;
  /** 把文件 / 文件夹 / 代码片段作为引用塞进对话框（右键菜单用） */
  onAddRef: (a: import('@paw/shared').Attachment) => void;
}) {
  const [tree, setTree] = useState<FsEntry[]>([]);
  const [treeErr, setTreeErr] = useState('');
  const [tabs, setTabs] = useState<IdeTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [file, setFile] = useState<FsFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  /** 本地编辑未保存的文件集合（跟 Agent 改动的 changedPaths 区分开） */
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [treeWidth, setTreeWidth] = useState(() => storedWidth('paw-ide-tree', TREE_DEFAULT, TREE_MIN, TREE_MAX));
  const [treeHidden, setTreeHidden] = useState(false);
  const [editorTheme, setEditorTheme] = useState<EditorTheme>(() =>
    (localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'));
  useEffect(() => { applyEditorTheme(editorTheme); }, [editorTheme]);
  // Markdown：默认预览（打开 .md 就是想读它），可切源码 / 分栏
  const [mdView, setMdView] = useState<MdView>(() => {
    const v = localStorage.getItem(MD_VIEW_KEY);
    return v === 'code' || v === 'split' ? v : 'preview';
  });
  const changeMdView = (v: MdView) => { setMdView(v); localStorage.setItem(MD_VIEW_KEY, v); };
  // 内置终端：开关 + 高度都持久化；收起只隐藏视图，shell 会话保留
  const [termOpen, setTermOpen] = useState(() => localStorage.getItem(TERM_OPEN_KEY) === '1');
  const [termHeight, setTermHeight] = useState(() => storedWidth(TERM_H_KEY, TERM_DEFAULT_H, 140, 1200));
  const toggleTerm = () => setTermOpen((v) => { localStorage.setItem(TERM_OPEN_KEY, v ? '0' : '1'); return !v; });
  const panelRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  // 右键菜单（文件树条目 / 代码选区）
  const [ctx, setCtx] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  // 代码区保底 340px：面板变窄时文件树自动让位（而不是把代码压成一条缝）
  const treeResize = useColumnResize(treeWidth, setTreeWidth, {
    min: TREE_MIN,
    startWidth: () => treeRef.current?.offsetWidth ?? treeWidth,
    max: () => Math.max(TREE_MIN, Math.min(TREE_MAX, (panelRef.current?.clientWidth ?? 0) - CODE_MIN - 9)),
    storeKey: 'paw-ide-tree', defaultWidth: TREE_DEFAULT,
  });

  const loadTree = useCallback(async () => {
    const r = await getFsTree(root, '.');
    if (r.error) { setTreeErr(r.error); setTree([]); }
    else { setTreeErr(''); setTree(r.entries || []); }
  }, [root]);

  useEffect(() => { void loadTree(); setTabs([]); setActivePath(null); setFile(null); }, [loadTree]);

  const openFile = useCallback(async (path: string) => {
    const name = path.split('/').pop() || path;
    setTabs((prev) => prev.some((t) => t.path === path) ? prev : [...prev, { path, name }]);
    setActivePath(path);
    setFileLoading(true);
    const f = await getFsFile(root, path);
    setFile(f);
    setFileLoading(false);
  }, [root]);

  /** 引用用的相对路径 */
  const relOf = useCallback((abs: string) =>
    abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs, [root]);

  /** 文件 / 文件夹 → 对话引用（内容用后端已有的 <file> 注入通道） */
  const addEntryRef = useCallback(async (entry: FsEntry) => {
    if (entry.dir) {
      const r = await getFsTree(root, entry.path);
      if (r.error) return;
      const list = (r.entries || []).map((e) => (e.dir ? `${e.name}/` : e.name)).join('\n');
      const total = r.total ?? r.entries.length;
      const tail = r.truncated ? `\n…（共 ${total} 项，仅列出前 ${r.entries.length} 项）` : '';
      onAddRef({
        name: `${relOf(entry.path)}/`,
        content: `（文件夹，共 ${total} 项）\n${list}${tail}`,
        size: list.length,
        mime: 'text/plain',
        kind: 'file',
      });
      return;
    }
    const f = await getFsFile(root, entry.path);
    if (f.error) return;
    onAddRef({
      name: relOf(entry.path),
      content: f.content.slice(0, REF_MAX_CHARS),
      size: f.size,
      mime: REF_MIME[extOf(entry.path)] || 'text/plain',
      kind: 'file',
    });
  }, [root, relOf, onAddRef]);

  /** 选中行 → 对话引用，名字带行号范围（`App.tsx:36-42`） */
  const addCodeRef = useCallback((start: number, end: number) => {
    if (!file || file.error || !activePath) return;
    const text = file.content.split('\n').slice(start - 1, end).join('\n');
    onAddRef({
      name: `${relOf(activePath)}:${start}-${end}`,
      content: text,
      size: text.length,
      mime: REF_MIME[extOf(activePath)] || 'text/plain',
      kind: 'file',
    });
  }, [file, activePath, relOf, onAddRef]);

  /** Monaco 右键「添加到 Paw 对话」：有选中行就带片段，没有就整个文件 */
  const addEditorToChat = useCallback((start: number | null, end: number | null) => {
    if (!activePath || !file) return;
    if (start !== null && end !== null) { addCodeRef(start, end); return; }
    void addEntryRef({ name: activePath.split('/').pop() || activePath, path: activePath, dir: false });
  }, [activePath, file, addCodeRef, addEntryRef]);

  const onTreeContext = useCallback((e: React.MouseEvent, entry: FsEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({
      x: e.clientX, y: e.clientY,
      items: [{
        label: '添加到 Paw 对话',
        icon: <Plus size={13} />,
        hint: entry.name,
        onClick: () => void addEntryRef(entry),
      }],
    });
  }, [addEntryRef]);

  /** 代码区右键：有选中就给片段，没选中就给整个文件 */
  // Agent 改了正在看的文件 → 自动重载内容
  useEffect(() => {
    if (activePath && changedPaths.has(activePath) && reloadTick > 0) {
      void getFsFile(root, activePath).then(setFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTick]);

  const closeTab = (path: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== path);
      if (activePath === path) {
        const fallback = next[next.length - 1]?.path ?? null;
        setActivePath(fallback);
        if (fallback) void getFsFile(root, fallback).then(setFile);
        else setFile(null);
      }
      return next;
    });
  };

  /** 切到某个 tab 并加载内容（关闭其他/全部关闭后重建当前态用） */
  const activateTab = useCallback((path: string | null) => {
    setActivePath(path);
    if (path) void getFsFile(root, path).then(setFile);
    else setFile(null);
  }, [root]);

  /** Tab 右键：关掉除它以外的；它自己变成唯一 tab，内容不变 */
  const closeOtherTabs = (path: string) => {
    setTabs([tabs.find((t) => t.path === path)!]);
    activateTab(path);
  };
  const closeAllTabs = () => {
    setTabs([]);
    activateTab(null);
  };
  const copyText = (text: string) => { void navigator.clipboard.writeText(text).catch(() => {}); };
  const reveal = (path: string) => {
    const desktop = (window as unknown as { pawDesktop?: { reveal?: (p: string) => void } }).pawDesktop;
    desktop?.reveal?.(path);
  };

  /** 标签页右键菜单：添加到 Paw 对话 / 关闭 / 复制路径 / Finder 中显示 */
  const onTabContext = (e: React.MouseEvent, tab: IdeTab) => {
    e.preventDefault();
    e.stopPropagation();
    setTabs((prev) => prev.some((t) => t.path === tab.path) ? prev : [...prev, tab]);
    activateTab(tab.path);
    setCtx({
      x: e.clientX, y: e.clientY,
      items: [
        { label: '添加到 Paw 对话', icon: <Plus size={13} />, hint: tab.name,
          onClick: () => void addEntryRef({ name: tab.name, path: tab.path, dir: false }) },
        { label: '关闭', hint: '⌘W', onClick: () => closeTab(tab.path) },
        { label: '关闭其他', hint: '⌥⌘T', disabled: tabs.length <= 1, onClick: () => closeOtherTabs(tab.path) },
        { separator: true, label: '', onClick: () => {} },
        { label: '全部关闭', hint: '⌘K W', onClick: closeAllTabs },
        { separator: true, label: '', onClick: () => {} },
        { label: '复制路径', icon: <Copy size={13} />, hint: '⌥⌘C', onClick: () => copyText(tab.path) },
        { label: '复制相对路径', icon: <Copy size={13} />, hint: '⌥⇧⌘C', onClick: () => copyText(relOf(tab.path)) },
        { separator: true, label: '', onClick: () => {} },
        { label: '在 Finder 中显示', hint: '⌥⌘R', onClick: () => reveal(tab.path) },
      ],
    });
  };

  const ext = activePath ? extOf(activePath) : '';
  const hasFile = !fileLoading && !!file && !file.error;
  const md = isMarkdown(ext) && hasFile;
  // Monaco 的语言 ID 跟扩展名大部分同名，几个特例显式映射
  const monacoLang = MONACO_LANG[ext] || ext;
  // 图片/PDF：浏览器原生渲染（/api/fs/raw 返回真实字节 + 正确 MIME），不显示「二进制无法预览」
  const rawPreview = hasFile && isRawPreview(ext) && !!activePath;
  const rawUrl = activePath
    ? `/api/fs/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(activePath)}`
    : '';
  // 编辑区太窄时不给分栏（两边都读不了），自动退回预览
  const [editorNarrow, setEditorNarrow] = useState(false);
  useEffect(() => {
    const el = editorRef.current;
    if (!md || !el) return;
    const observer = new ResizeObserver(([entry]) => setEditorNarrow(entry.contentRect.width < 720));
    observer.observe(el);
    return () => observer.disconnect();
  }, [md]);
  // 超大 Markdown 强制源码视图：react-markdown 解析几 MB 的表格/列表会把主线程钉住
  const mdHuge = md && (file?.content.length ?? 0) > 400_000;
  const view: MdView = md ? (mdHuge ? 'code' : mdView === 'split' && editorNarrow ? 'preview' : mdView) : 'code';
  const showPreview = view === 'preview' || view === 'split';

  const codePane = (
    <div className="ide-code-pane">
      {fileLoading && <div className="ide-code-empty">加载中…</div>}
      {!fileLoading && !file && (
        <div className="ide-code-empty">
          <File size={34} strokeWidth={1.3} />
          <p>点击左侧文件查看内容</p>
          <small>Agent 修改过的文件会标 <span className="ide-tab-dot inline" /> 并自动刷新</small>
        </div>
      )}
      {!fileLoading && file?.error && <div className="ide-code-empty">{file.error}</div>}
      {rawPreview && (ext === 'pdf'
        ? <iframe className="ide-raw-frame" src={rawUrl} title={activePath || ''} />
        : <div className="ide-raw-image-wrap"><img className="ide-raw-image" src={rawUrl} alt={activePath || ''} /></div>
      )}
      {hasFile && !rawPreview && (
        <CodeEditor
          root={root}
          path={activePath!}
          ext={ext}
          content={file.content}
          language={monacoLang}
          theme={editorTheme}
          onDirtyChange={(d) => setDirtyPaths((prev) => {
            const next = new Set(prev);
            if (d) next.add(activePath!); else next.delete(activePath!);
            return next;
          })}
          onSaved={(size) => setFile((f) => f ? { ...f, size } : f)}
          onAddToChat={addEditorToChat}
        />
      )}
    </div>
  );

  return (
    <div className={'ide-panel' + (treeHidden ? ' tree-hidden' : '')} ref={panelRef}
      style={{ '--ide-tree-width': `${treeWidth}px` } as CSSProperties}>
      {treeHidden && (
        <Tips label="显示文件树">
          <button className="ide-tree-reveal" aria-label="显示文件树" onClick={() => setTreeHidden(false)}>
            <PanelLeftOpen size={15} />
          </button>
        </Tips>
      )}
      <div className="ide-tree" ref={treeRef} style={treeHidden ? { display: 'none' } : undefined}>
        <div className="ide-tree-head">
          <Folder size={14} />
          <span className="ide-tree-root" title={root}>{root.split('/').filter(Boolean).pop()}</span>
          <Tips label="刷新文件树">
            <button className="ide-icon-btn" aria-label="刷新文件树" onClick={() => void loadTree()}><RefreshCw size={14} /></button>
          </Tips>
          <Tips label="隐藏文件树">
            <button className="ide-icon-btn" aria-label="隐藏文件树" onClick={() => setTreeHidden(true)}><PanelLeftClose size={14} /></button>
          </Tips>
        </div>
        <div className="ide-tree-body">
          {treeErr && <div className="tree-loading">{treeErr}</div>}
          {tree.map((e) => (
            <TreeNode key={e.path} entry={e} root={root} depth={0}
              activePath={activePath} changedPaths={changedPaths} onOpen={openFile} onContext={onTreeContext} />
          ))}
          {!treeErr && tree.length === 0 && <div className="tree-loading">（空目录）</div>}
        </div>
      </div>
      {!treeHidden && <div className="col-resizer in-ide" title="拖动调整文件树宽度（双击还原）" {...treeResize} />}
      <div className="ide-editor" ref={editorRef}>
        <div className="ide-tabs">
          {tabs.map((t) => (
            <div key={t.path} className={'ide-tab' + (t.path === activePath ? ' active' : '') + (changedPaths.has(t.path) || dirtyPaths.has(t.path) ? ' changed' : '')}
              onClick={() => { setActivePath(t.path); void getFsFile(root, t.path).then(setFile); }}
              onContextMenu={(e) => onTabContext(e, t)} title={t.path}>
              <FileCode2 size={12} style={{ color: fileHue(extOf(t.name)) }} />
              <span>{t.name}</span>
              {(changedPaths.has(t.path) || dirtyPaths.has(t.path)) && <span className="ide-tab-dot" />}
              <button className="ide-tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.path); }} title="关闭"><X size={11} /></button>
            </div>
          ))}
          {tabs.length === 0 && <span className="ide-tabs-hint">从左侧文件树点开文件</span>}
          {/* 右侧常驻操作：Markdown 视图（仅 .md）+ 对话区收起/展开 */}
          <div className="ide-tabs-actions">
            {md && (
              <div className="md-view-switch" role="group" aria-label="Markdown 视图">
                <Tips label={mdHuge ? '文件过大，预览已禁用（用源码视图翻）' : '渲染预览'}>
                  <button className={'md-view-btn' + (view === 'preview' ? ' active' : '')} disabled={mdHuge}
                    aria-label="渲染预览" onClick={() => changeMdView('preview')}><Eye size={14} /></button>
                </Tips>
                <Tips label={editorNarrow ? '分栏（编辑区太窄，暂不可用）' : mdHuge ? '文件过大，预览已禁用' : '源码 + 预览分栏'}>
                  <button className={'md-view-btn' + (view === 'split' ? ' active' : '')} disabled={editorNarrow || mdHuge}
                    aria-label="分栏预览" onClick={() => changeMdView('split')}><Columns2 size={14} /></button>
                </Tips>
                <Tips label="Markdown 源码">
                  <button className={'md-view-btn' + (view === 'code' ? ' active' : '')}
                    aria-label="Markdown 源码" onClick={() => changeMdView('code')}><Code2 size={14} /></button>
                </Tips>
              </div>
            )}
            <Tips label={chatHidden ? '展开对话区' : '收起对话区（代码区铺满）'}>
              <button className={'ide-icon-btn ide-panel-toggle' + (chatHidden ? ' active' : '')}
                aria-label={chatHidden ? '展开对话区' : '收起对话区'} onClick={onToggleChat}>
                {chatHidden ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
              </button>
            </Tips>
          </div>
        </div>
        {view === 'split' ? (
          <div className="ide-split">
            {codePane}
            <div className="ide-split-preview">
              <MarkdownPreview content={file!.content} root={root} filePath={activePath!} />
            </div>
          </div>
        ) : showPreview ? (
          <div className="ide-code ide-preview-pane">
            <MarkdownPreview content={file!.content} root={root} filePath={activePath!} />
            {(file?.notice || file?.truncated) && <div className="code-truncated">{file.notice || `… 已加载 ${file.lines} 行，超出部分未加载`}</div>}
          </div>
        ) : codePane}
        {/* 内置终端：真实 shell，命令全放开；占编辑区下方，高度可拖 */}
        {termOpen && (
          <TerminalPanel cwd={root} height={termHeight} onResize={setTermHeight} onClose={toggleTerm} />
        )}
        <div className="ide-statusbar">
          <span className="ide-status-path" title={activePath || root}>{activePath || root}</span>
          {file && !file.error && (
            <>
              {rawPreview ? <span>浏览器原生预览</span> : <span>{file.lines} 行</span>}
              <span>{(file.size / 1024).toFixed(1)} KB</span>
              <span>{ext.toUpperCase() || 'TEXT'}</span>
              {!rawPreview && <span>UTF-8</span>}
              {md && <span className="ide-status-view">{view === 'preview' ? '预览' : view === 'split' ? '分栏' : '源码'}</span>}
            </>
          )}
          <Tips label={termOpen ? '收起终端（会话保留）' : '打开内置终端'}>
            <button className={'ide-term-btn' + (termOpen ? ' active' : '')} aria-label="切换终端" onClick={toggleTerm}>
              <SquareTerminal size={13} /> 终端
            </button>
          </Tips>
          <Tips label={editorTheme === 'light' ? '切到 Farris Dark' : '切到 Farris Light'}>
            <button className="ide-theme-btn" onClick={() => setEditorTheme((t) => (t === 'light' ? 'dark' : 'light'))}>
              {editorTheme === 'light' ? 'Farris Light' : 'Farris Dark'}
            </button>
          </Tips>
        </div>
      </div>
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
    </div>
  );
}