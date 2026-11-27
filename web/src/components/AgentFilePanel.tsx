import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Copy, ExternalLink, FileText, Folder, RefreshCw, X } from 'lucide-react';
import { messageTools, type Attachment, type ViewMessage } from '@paw/shared';
import { getFsFile, getFsTree, getOfficePreview, type FsEntry, type FsFile } from '../api/client';
import { inlineMediaSrc } from '../lib/attachments';
import { extOf, fileBadgeStyle, isRawPreviewable, MONACO_LANG } from '../lib/file-preview';
import MarkdownPreview from './MarkdownPreview';
import CodeEditor from './CodeEditor';

/**
 * Agent 模式右侧文件预览面板：把本次会话里出现过的文件汇总成列表，
 * 点开在右侧 tab 预览。覆盖三种来源：
 *  1. Agent 工具读写的工作区文件（read_file / write_file / edit_file / generate_image 的 args.path）
 *  2. 用户挂上的附件（消息里的 attachments，内联 content）
 *  3. 右键「添加到对话」的引用（也在 attachments 里，content 带片段）
 *
 * 工作区文件从磁盘读全文（可编辑/保存），内联附件直接用 content 渲染。
 */
export interface PreviewFile {
  /** 唯一 key（同名文件去重） */
  key: string;
  name: string;
  /** 工作区相对/绝对路径；有它就能从磁盘读全文 */
  path?: string;
  /** 内联内容（附件）：文本原文 / 图片 data URL / PDF data URL */
  inline?: Attachment;
  /** 目录预览条目（点击文件夹内子目录打开的 tab） */
  isDir?: boolean;
  source: 'tool' | 'attachment';
}

/** CodeBuddy 同款文件类型徽章：彩色圆角方块 + 缩写（浅底配深字，size 传了按像素缩放） */
function FileBadge({ name, size }: { name: string; size?: number }) {
  const b = fileBadgeStyle(extOf(name));
  const scaled = size ? { fontSize: Math.round(size * 0.58), minWidth: Math.round(size * 1.7), height: Math.round(size * 1.15) } : undefined;
  return <span className="afp-badge" style={{ backgroundColor: b.color, color: b.fg, ...scaled }}>{b.label}</span>;
}

/** 腾讯文档引擎可预览的 Office 扩展（含 PDF；引擎不可用时 PDF 回退浏览器原生 iframe） */
const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'pdf', 'xmind']);
function isOfficeExt(ext: string): boolean {
  return OFFICE_EXT.has(ext.toLowerCase());
}

/** Office/PDF 只读预览：统一走腾讯文档引擎，没有路径或失败时明确报错 */
function OfficePreview({ file }: { file: PreviewFile }) {
  const path = file.path || '';
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!path) { setLoading(false); return; }
    let cancelled = false;
    setUrl(''); setError(''); setLoading(true);
    void getOfficePreview(path).then((d) => {
      if (!cancelled) setUrl(d.url);
    }).catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : '预览加载失败');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);

  const copyPath = () => {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = path;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    };
    if (navigator.clipboard) void navigator.clipboard.writeText(path).catch(fallback);
    else fallback();
  };

  const reveal = (window as unknown as { pawDesktop?: { reveal?: (p: string) => void } }).pawDesktop?.reveal;

  if (!path) return <div className="afp-office-fallback"><div className="afp-office-msg">原始文件不存在或已被移动</div></div>;
  if (error) return <div className="afp-office-fallback">
    <div className="afp-office-msg">无法启动 Office 预览服务</div>
    <div className="afp-office-path">{error}</div>
    {reveal && <button className="afp-office-open" onClick={() => reveal(path)}><ExternalLink size={12} /> 在访达中显示</button>}
    <button className="afp-office-copy" onClick={copyPath}><Copy size={12} /> 复制路径</button>
    <div className="afp-office-path">{path}</div>
  </div>;
  if (loading || !url) return <div className="afp-office-fallback"><div className="afp-office-msg">正在加载 Office 预览…</div></div>;
  return <iframe className="afp-office-frame" src={url} title={file.name}
    allow="clipboard-read; clipboard-write; fullscreen"
    onError={() => setError('预览页面加载失败')} />;
}

/** 文件夹预览：单层目录列表（复用 /api/fs/tree），点子文件/子文件夹在面板里继续打开 */
function FolderPreview({ file, onOpenPath }: { file: PreviewFile; onOpenPath: (p: string, dir?: boolean) => void }) {
  const path = file.path || '';
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState('');

  // 与 FilePreview 同一套绝对路径拆法：父目录当 root、文件夹名当子路径，必在 root 内
  const isAbs = path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path);
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const fsRoot = isAbs && lastSep >= 0 ? path.slice(0, lastSep || 1) : path;
  const fsSub = isAbs && lastSep >= 0 ? path.slice(lastSep + 1) || '.' : path;

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setEntries(null); setError('');
    void getFsTree(fsRoot, fsSub).then((d) => {
      if (cancelled) return;
      if (d.error) setError(d.error);
      else setEntries(d.entries);
    });
    return () => { cancelled = true; };
  }, [path, fsRoot, fsSub]);

  if (!path) return <div className="afp-office-fallback"><div className="afp-office-msg">原始文件夹不存在或已被移动</div></div>;
  if (error) return <div className="afp-office-fallback">
    <div className="afp-office-msg">文件夹读取失败</div>
    <div className="afp-office-path">{error}</div>
    <div className="afp-office-path">{path}</div>
  </div>;
  if (!entries) return <div className="afp-office-fallback"><div className="afp-office-msg">正在读取目录…</div></div>;
  if (!entries.length) return <div className="afp-office-fallback"><div className="afp-office-msg">空文件夹</div></div>;
  return (
    <div className="afp-dir-list">
      {entries.map((e) => (
        <button key={e.path} className="afp-dir-row" onClick={() => onOpenPath(e.path, e.dir)} title={e.path}>
          {e.dir ? <Folder size={14} /> : <FileBadge name={e.name} size={13} />}
          <span className="name">{e.name}</span>
          <span className="kind">{e.dir ? '文件夹' : '文件'}</span>
          <ChevronRight size={12} className="arrow" />
        </button>
      ))}
    </div>
  );
}

/** 从消息里汇总所有可预览文件（去重，工具文件优先——能读到最新全文） */
export function collectPreviewFiles(messages: ViewMessage[]): PreviewFile[] {
  const map = new Map<string, PreviewFile>();
  for (const m of messages) {
    for (const t of messageTools(m)) {
      const candidates: unknown[] = [];
      if (['read_file', 'write_file', 'edit_file', 'generate_image'].includes(t.name)) {
        candidates.push(t.args?.path);
      } else if (['document_parse', 'document_text', 'document_outline'].includes(t.name)) {
        candidates.push(t.args?.files);
      }
      for (const raw of candidates) {
        const paths = Array.isArray(raw) ? raw : [raw];
        for (const p of paths) {
          if (typeof p !== 'string' || !p) continue;
          const name = p.split(/[\\/]/).pop() || p;
          if (!map.has(name)) map.set(name, { key: name, name, path: p, source: 'tool' });
        }
      }
    }
    for (const a of m.attachments || []) {
      const existing = map.get(a.name);
      // 附件保留了 Electron 本机路径时，右侧面板可以直接交给 Office 引擎预览原件。
      if (existing) {
        if (!existing.path && a.localPath) existing.path = a.localPath;
        continue;
      }
      map.set(a.name, { key: a.name, name: a.name, inline: a, path: a.localPath, source: 'attachment' });
    }
  }
  return [...map.values()];
}

export default function AgentFilePanel({ files, root, editorTheme, onAddToChat, previewRequest, width }: {
  files: PreviewFile[];
  root: string;
  editorTheme: 'light' | 'dark';
  onAddToChat?: (name: string, start: number | null, end: number | null) => void;
  /** 外部指定要预览的文件：附件卡片传 attachment，工具卡片的文件名传 path；id 变化触发打开 */
  previewRequest?: { id: number; attachment?: Attachment; path?: string } | null;
  /** 面板宽度（由 App 的可拖拽分隔线控制） */
  width?: number;
}) {
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  /** 从文件夹预览里点开的子文件/子目录（不在消息列表 files 里，单独登记供 tab 与预览查找） */
  const [extraFiles, setExtraFiles] = useState<PreviewFile[]>([]);
  /** '__newtab__' = WorkBuddy 那种「新标签页」首页；其余是文件 key */
  const [activeKey, setActiveKey] = useState<string | null>('__newtab__');
  const [loadTick, setLoadTick] = useState(0);
  const [diskCache, setDiskCache] = useState<Record<string, FsFile>>({});
  // 点卡片指定的附件优先于同名工具文件：看的就是消息里挂的那一份
  const allFiles = useMemo<PreviewFile[]>(() => {
    const base = previewRequest?.attachment
      ? [{ key: previewRequest.attachment.name, name: previewRequest.attachment.name, inline: previewRequest.attachment, path: previewRequest.attachment.localPath, source: 'attachment' as const },
        ...files.filter((f) => f.key !== previewRequest.attachment!.name)]
      : files;
    if (!extraFiles.length) return base;
    const seen = new Set(base.map((f) => f.key));
    return [...base, ...extraFiles.filter((f) => !seen.has(f.key))];
  }, [files, previewRequest, extraFiles]);

  // 外部请求打开文件：附件卡片 → 加附件 tab；工具卡片文件名 → 激活同名工具文件 tab
  useEffect(() => {
    if (!previewRequest) return;
    let key: string;
    if (previewRequest.attachment) {
      const a = previewRequest.attachment;
      key = a.name;
      setOpenKeys((prev) => prev.includes(key) ? prev : [...prev, key]);
    } else if (previewRequest.path) {
      const p = previewRequest.path;
      key = p.split(/[\\/]/).pop() || p;
      // 工具文件通常已在 files 里；万一没有（历史会话），补一个带 path 的条目
      const existing = allFiles.find((f) => f.key === key || f.path === p);
      if (existing) key = existing.key;
      setOpenKeys((prev) => prev.includes(key) ? prev : [...prev, key]);
    } else return;
    setActiveKey(key);
  }, [previewRequest?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFile = (f: PreviewFile) => {
    setOpenKeys((prev) => prev.includes(f.key) ? prev : [...prev, f.key]);
    setActiveKey(f.key);
  };
  /** 点文件夹预览里的子文件/子文件夹：以绝对路径为 key 登记并打开 tab */
  const openPath = (p: string, dir?: boolean) => {
    const existing = allFiles.find((f) => f.key === p || f.path === p);
    if (existing) { openFile(existing); return; }
    const entry: PreviewFile = {
      key: p, name: p.split(/[\\/]/).pop() || p, path: p, source: 'tool',
      ...(dir ? { isDir: true } : {}),
    };
    setExtraFiles((prev) => prev.some((f) => f.key === p) ? prev : [...prev, entry]);
    openFile(entry);
  };
  const closeFile = (key: string) => {
    setOpenKeys((prev) => {
      const next = prev.filter((k) => k !== key);
      if (activeKey === key) setActiveKey(next[next.length - 1] ?? '__newtab__');
      return next;
    });
    setExtraFiles((prev) => prev.filter((f) => f.key !== key));
  };

  const active = allFiles.find((f) => f.key === activeKey) ?? null;

  return (
    <aside className="agent-file-panel" style={width ? { flexBasis: width, width } : undefined}>
      <div className="afp-tabs">
        {/* 新标签页（WorkBuddy 同款首页）：点 + 或这个 tab 都回到文件总览 */}
        <div className={'afp-tab afp-newtab-tab' + (activeKey === '__newtab__' ? ' active' : '')}
          onClick={() => setActiveKey('__newtab__')} title="新标签页">
          <FileText size={12} /> <span>新标签页</span>
        </div>
        {openKeys.map((k) => {
          const f = allFiles.find((x) => x.key === k);
          if (!f) return null;
          const base = f.name.split(/[\\/]/).pop() || f.name;
          const isDir = f.isDir || f.inline?.mime === 'inode/directory';
          return (
            <div key={k} className={'afp-tab' + (k === activeKey ? ' active' : '')} onClick={() => setActiveKey(k)} title={f.path || f.name}>
              {isDir ? <Folder size={13} /> : <FileBadge name={f.name} />}
              <span className="afp-tab-name">{base}</span>
              <button className="afp-tab-close" onClick={(e) => { e.stopPropagation(); closeFile(k); }} title="关闭"><X size={12} /></button>
            </div>
          );
        })}
        <button className="afp-tab-add" onClick={() => setActiveKey('__newtab__')} title="新标签页">＋</button>
      </div>
      {activeKey === '__newtab__' || !active ? (
        <div className="afp-home">
          {allFiles.length === 0 ? (
            <div className="afp-home-empty">
              <div className="afp-home-empty-icon">📄</div>
              <div className="afp-home-empty-title">还没有文件</div>
              <div className="afp-home-empty-sub">让 Agent 读写文件，或在对话里挂上附件<br />就能在这里预览了</div>
            </div>
          ) : (
            <>
              <div className="afp-home-label">本次会话文件 <span className="afp-home-count">{allFiles.length}</span></div>
              {allFiles.map((f) => {
                const isDir = f.isDir || f.inline?.mime === 'inode/directory';
                return (
                <button key={f.key} className="afp-home-row" onClick={() => openFile(f)} title={f.path || f.name}>
                  {isDir ? <Folder size={13} /> : <FileBadge name={f.name} />}
                  <span className="afp-home-text">
                    <span className="afp-home-name">{f.name.split(/[\\/]/).pop() || f.name}</span>
                    {f.name.includes('/') && <span className="afp-home-path">{f.name}</span>}
                  </span>
                  <span className={'afp-home-src ' + f.source}>{f.source === 'tool' ? 'Agent' : '附件'}</span>
                </button>
                );
              })}
            </>
          )}
        </div>
      ) : (
        <div className="afp-preview">
          <FilePreview file={active} root={root} editorTheme={editorTheme}
            cache={diskCache[active.key]} loadTick={loadTick}
            onReload={() => setLoadTick((v) => v + 1)}
            onCache={(d) => setDiskCache((prev) => ({ ...prev, [active.key]: d }))}
            onAddToChat={onAddToChat}
            onOpenPath={openPath} />
        </div>
      )}
    </aside>
  );
}

/** 单个文件预览：工作区文件从磁盘读，内联附件直接用 content */
function FilePreview({ file, root, editorTheme, cache, loadTick, onReload, onCache, onAddToChat, onOpenPath }: {
  file: PreviewFile;
  root: string;
  editorTheme: 'light' | 'dark';
  cache?: FsFile;
  loadTick: number;
  onReload: () => void;
  onCache: (d: FsFile) => void;
  onAddToChat?: (name: string, start: number | null, end: number | null) => void;
  onOpenPath: (p: string, dir?: boolean) => void;
}) {
  const ext = extOf(file.name);
  const raw = isRawPreviewable(ext);
  const isOffice = isOfficeExt(ext);
  // 文件夹附件（拖入整个文件夹）或目录预览点开的子目录：走目录浏览，不走文件读取
  const isFolder = !!file.isDir || file.inline?.mime === 'inode/directory';
  const [loading, setLoading] = useState(false);

  // 磁盘文件：root 用「文件所在目录」——工具能读绝对路径，但 fs 接口强制 root 隔离；
  // 会话工作区可能是别的项目（工具跨工作区改文件），直接用 active.workspace 会「路径越界」→ 空白。
  // 文件所在目录当 root + 文件名当 path，一定在根内，语义就是读这个绝对路径文件。
  const isAbs = !!file.path && (file.path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(file.path));
  const lastSep = file.path ? Math.max(file.path.lastIndexOf('/'), file.path.lastIndexOf('\\')) : -1;
  const fsRoot = isAbs && lastSep >= 0 ? file.path!.slice(0, lastSep || 1) : root;
  const fsPath = isAbs ? (file.path!.split(/[\\/]/).pop() || file.path!) : file.path!;

  // 工作区文件：从磁盘读全文（第一次 / 手动刷新）
  useEffect(() => {
    if (!file.path || raw || isOffice || isFolder) return;
    let cancelled = false;
    setLoading(true);
    void getFsFile(fsRoot, fsPath).then((d) => {
      if (!cancelled) onCache(d.error ? { path: fsPath, content: `（读取失败：${d.error}）`, lines: 0, truncated: false, size: 0 } : d);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.key, fsRoot, fsPath, loadTick, raw, isOffice, isFolder]);

  const content = cache?.content ?? file.inline?.content ?? '';
  const isImage = file.inline?.kind === 'image' || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
  const isPdf = /\.pdf$/i.test(file.name);
  const isMd = /^(md|markdown)$/i.test(ext);

  const src = useMemo(() => {
    if (file.inline?.content && (isImage || isPdf)) {
      return inlineMediaSrc(file.inline.content, file.inline.mime || (isPdf ? 'application/pdf' : 'image/png'));
    }
    if (file.path && fsRoot) {
      return `/api/fs/raw?root=${encodeURIComponent(fsRoot)}&path=${encodeURIComponent(fsPath)}`;
    }
    return '';
  }, [file, fsRoot, fsPath, isImage, isPdf]);

  const toolbar = (
    <div className="afp-preview-bar">
      <span className="afp-preview-name">{file.name}</span>
      {file.source === 'tool' && <button onClick={onReload} title="重新读取磁盘"><RefreshCw size={12} className={loading ? 'spin' : ''} /></button>}
    </div>
  );

  if (isImage) return <>{toolbar}<div className="afp-img-wrap"><img src={src} alt={file.name} className="afp-img" /></div></>;
  // 文件夹：目录浏览（子项点击在面板里继续打开）
  if (isFolder) return <>{toolbar}<FolderPreview file={file} onOpenPath={onOpenPath} /></>;
  // PDF 与其它 Office 文件统一走腾讯文档引擎；没有本机路径时明确提示不存在。
  if (isOffice) return <>{toolbar}<OfficePreview file={file} /></>;
  if (isMd) return <>{toolbar}<div className="afp-md"><MarkdownPreview content={content} root={root} filePath={file.path || file.name} /></div></>;

  // 文本文件一律走 Monaco 只读预览：语法高亮 + 行号 + 选区，跟 VSCode 同款观感。
  // path 用文件名（内联附件没有真实路径），CodeEditor 的 readOnly 模式会加 preview: 前缀避免跟 IDE model 串。
  return <>
    {toolbar}
    <div className="afp-code">
      <CodeEditor root={root} path={file.path || file.name} ext={ext} content={content}
        language={MONACO_LANG[ext] || ext} theme={editorTheme} readOnly />
    </div>
  </>;
}
