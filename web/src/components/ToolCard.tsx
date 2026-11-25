import { useState } from 'react';
import { Bot, Check, ChevronDown, Circle, Copy, Eye, ExternalLink, FileDiff, FilePlus2, FileText, Globe2, GitBranch, GitCommit, History, ListChecks, Brain, Sparkles, Terminal, Trash2 } from 'lucide-react';
import { toolStepSummary, type ToolCallBlock, type ToolView } from '@paw/shared';
import { parseSearchOutput } from '../lib/search-results';
import { computeLineDiff, computeWriteDiff, type DiffLine } from '../lib/diff';
import Favicon from './Favicon';

/** 工具调用卡片：生图 / 搜索 / 子代理 / 文件变更 / 通用（read_file、run_command） */
export default function ToolCard({ tool, members, busy, stopped, onOpenSession, onPreviewFile }: {
  tool: ToolView;
  /** 这条消息还在流式输出吗：结束了就把"进行中"的状态停下来（别让清单看着还在跑） */
  busy?: boolean;
  /** 本轮被用户停止：没拿到 tool_done 的卡片按已停止渲染，不能永远转圈 */
  stopped?: boolean;
  /** 连续改同一个文件的调用（≥2 时才传）：合并成一张卡片，标题只占一行 */
  members?: ToolCallBlock[];
  onOpenSession?: (id: string) => void;
  /** 点文件名 → 右侧文件预览面板打开它 */
  onPreviewFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(() => SHELL_TOOLS.has(tool.name));
  const [searchOpen, setSearchOpen] = useState(false); // 搜索结果默认折叠
  const [todoOpen, setTodoOpen] = useState(true);      // 任务清单默认展开
  const [cmdCopied, setCmdCopied] = useState(false);
  const done = tool.ok !== undefined;
  const running = !done && !stopped && busy !== false;
  const interrupted = !done && !running;
  const dot = done ? (tool.ok ? <Check size={11} /> : '!') : running ? <LoadingDots light /> : '!';

  // subagent：子代理卡片（运行中实时步骤，完成后折叠成摘要）
  if (tool.name === 'subagent' && tool.subagent) {
    const sub = tool.subagent;
    const running = sub.status === 'running' && !stopped;
    const statusText: Record<string, string> = {
      running: '运行中', completed: '完成', error: '失败', aborted: '被停止', timeout: '超时', limit: '轮次上限',
    };
    return (
      <div className={'tool-card subagent-card' + (open || running ? ' open' : '')}>
        <button className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className={'tool-dot' + (sub.status === 'completed' ? ' ok' : running ? ' running' : ' fail')}>
            {stopped ? '!' : running ? <LoadingDots light /> : sub.status === 'completed' ? <Check size={11} /> : '!'}
          </span>
          <Bot size={13} className="search-globe" />
          <span className="tool-title">{sub.name}</span>
          <span className="tool-name">{sub.agentName}</span>
          {!running && sub.seconds !== undefined && (
            <span className="subagent-meta">
              {statusText[sub.status]} · {sub.seconds.toFixed(0)}s
              {sub.tokens ? ` · ${(sub.tokens.prompt + sub.tokens.completion).toLocaleString()} tok` : ''}
            </span>
          )}
          <ChevronDown size={12} className={open || running ? 'rot' : ''} />
        </button>
        {(open || running) && (
          <div className="subagent-body">
            {sub.steps.map((st, i) => (
              st.kind === 'tool' ? (
                <div key={i} className="subagent-step tool">
                  <span className={'subagent-step-dot' + (st.ok === false ? ' fail' : st.ok ? ' ok' : '')} />
                  <code>{st.tool}</code>
                  <span>{toolStepSummary(st.tool || '', {}, st.text !== st.tool ? st.text : undefined)}</span>
                </div>
              ) : st.kind === 'error' ? (
                <div key={i} className="subagent-step error">{st.text}</div>
              ) : null
            ))}
            {running && <div className="subagent-running"><LoadingDots /> 子代理正在工作…</div>}
            {stopped && sub.status === 'running' && <div className="subagent-running stopped-hint">已停止</div>}
            {!running && tool.output && <pre className="tool-output subagent-output">{tool.output}</pre>}
            {!running && onOpenSession && (
              <button className="subagent-open-session" onClick={() => onOpenSession(sub.id)}>
                <ExternalLink size={11} /> 打开子会话（完整过程）
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
  const parsed = tool.name === 'web_search' && tool.output ? parseSearchOutput(tool.output) : null;

  // bash / shell / run_command：摘要常驻卡片头，命令和结果都放在卡片体。
  if (SHELL_TOOLS.has(tool.name)) {
    const command = shellCommand(tool);
    const preview = shellPreview(tool);
    return (
      <div className={'tool-card shell-card' + (open ? ' open' : '')}>
        <div className="shell-head">
          <span className={'tool-dot' + (tool.ok === false || interrupted ? ' fail' : done ? ' ok' : ' running')}>
            {dot}
          </span>
          <Terminal size={14} className="search-globe" />
          <span className="tool-title" title={preview}>{preview}</span>
          {command && (
            <button className="shell-copy" title={cmdCopied ? '已复制' : '复制命令'}
              onClick={() => void navigator.clipboard.writeText(command)
                .then(() => { setCmdCopied(true); window.setTimeout(() => setCmdCopied(false), 1200); })
                .catch(() => {})}>
              {cmdCopied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          )}
          <button className="shell-toggle" title={open ? '收起详情' : '查看详情'}
            onClick={() => setOpen((v) => !v)}>
            <ChevronDown size={13} className={open ? 'rot' : ''} />
          </button>
        </div>
        {open && (
          <div className="shell-body">
            {command && <pre className="shell-command-block">{command}</pre>}
            {running
              ? <div className="shell-loading"><LoadingDots /> 执行中…</div>
              : interrupted
                ? <div className="shell-loading stopped-hint">已停止（未收到执行结果）</div>
                : <pre className={'tool-output shell-output' + (tool.ok === false ? ' shell-error' : '')}>
                  {tool.output || '（无输出）'}
                </pre>}
          </div>
        )}
      </div>
    );
  }

  // generate_image：工具结果里含 ![生成图片](data:...) → 渲染图片卡片
  const imgMatch = tool.name === 'generate_image' && tool.output?.match(/!\[生成图片\]\((data:image\/[^)]+)\)/);
  if (imgMatch) {
    const modelTag = tool.output?.match(/_模型：([^_]+)_/)?.[1];
    return (
      <div className="image-tool">
        <div className="tool-head-static">
          <span className="tool-dot ok"><Check size={11} /></span>
          <span className="tool-title">生成图片</span>
          {modelTag && <span className="tool-name">{modelTag}</span>}
        </div>
        <img className="gen-image" src={imgMatch[1]} alt="生成的图片" />
        <a className="gen-image-download" href={imgMatch[1]} download="paw-generated.png">下载图片</a>
      </div>
    );
  }

  // load_skill：加载技能指令（注入 SKILL.md 全文）
  if (tool.name === 'load_skill') {
    return (
      <div className={'tool-card' + (open ? ' open' : '')}>
        <button className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className="tool-dot ok"><Check size={11} /></span>
          <Sparkles size={13} className="search-globe" />
          <span className="tool-title">{tool.summary || '加载技能'}</span>
          <span className="tool-name">技能</span>
          <ChevronDown size={12} className={open ? 'rot' : ''} />
        </button>
        {open && tool.output && <pre className="tool-output">{tool.output}</pre>}
      </div>
    );
  }

  // describe_image：图片转交识别（非读图模型借视觉模型看图）
  if (tool.name === 'describe_image') {
    return (
      <div className={'tool-card' + (open ? ' open' : '')}>
        <button className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className={'tool-dot' + (tool.ok === false ? ' fail' : done ? ' ok' : '')}>
            {dot}
          </span>
          <Eye size={13} className="search-globe" />
          <span className="tool-title">{tool.summary || '识别图片内容'}</span>
          <span className="tool-name">视觉转交</span>
          <ChevronDown size={12} className={open ? 'rot' : ''} />
        </button>
        {open && tool.output && <pre className="tool-output">{tool.output}</pre>}
      </div>
    );
  }

  // web_fetch：只展示页面标题那一行，抓取正文不进聊天区（明细没人看）
  if (tool.name === 'web_fetch') {
    const lines = (tool.output || '').split('\n');
    const url = (lines.find((l) => l.startsWith('URL: ')) || '').slice(5).trim();
    const title = (lines.find((l) => l.startsWith('标题: ')) || '').slice(4).trim();
    return (
      <div className="tool-card fetch-card">
        <div className="tool-head-static">
          <span className={'tool-dot' + (tool.ok === false ? ' fail' : done ? ' ok' : '')}>
            {dot}
          </span>
          <Globe2 size={13} className="search-globe" />
          <span className="tool-title">{toolStepSummary(tool.name, tool.args, tool.summary)}</span>
          <span className="tool-name">web_fetch</span>
        </div>
        {url ? (
          <div className="fetch-page">
            <Favicon url={url} />
            <a className="fetch-page-title" href={url} target="_blank" rel="noreferrer" title={url}>
              {title || url}
            </a>
            {title && <span className="search-hit-host">{resultHost(url)}</span>}
          </div>
        ) : tool.output ? (
          <div className="fetch-error">{tool.output}</div>
        ) : null}
      </div>
    );
  }

  // web_search：favicon + 标题列表；点击头部只折叠列表，原始文本不展示
  if (parsed) {
    return (
      <div className="search-tool">
        <button className="tool-head" onClick={() => setSearchOpen((v) => !v)}>
          <span className="tool-dot ok"><Check size={11} /></span>
          <Globe2 size={13} className="search-globe" />
          <span className="tool-title">{tool.summary || `网页搜索 ${parsed.query}`}</span>
          <span className="tool-name">{parsed.results.length} 条</span>
          <ChevronDown size={12} className={searchOpen ? 'rot' : ''} />
        </button>
        {searchOpen && (
          <div className="search-card">
            {parsed.results.map((r, i) => (
              <div key={i} className="search-hit">
                <Favicon url={r.url} />
                <a href={r.url} target="_blank" rel="noreferrer" title={r.snippet || r.url}>
                  <span className="search-hit-title">{r.title || r.url}</span>
                  {r.title && <span className="search-hit-host">{resultHost(r.url)}</span>}
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // todo_write：任务清单卡片（进度条 + 勾选列表，实时更新；默认展开）
  if (tool.name === 'todo_write') {
    const todos = (Array.isArray(tool.args?.todos) ? tool.args!.todos : []) as { content?: string; status?: string }[];
    const doneCount = todos.filter((t) => t.status === 'completed').length;
    const pct = todos.length ? Math.round((doneCount / todos.length) * 100) : 0;
    return (
      <div className={'tool-card todo-card' + (todoOpen ? ' open' : '')}>
        <button className="tool-head" onClick={() => setTodoOpen((v) => !v)}>
          <span className={'tool-dot' + (tool.ok === false ? ' fail' : done ? ' ok' : '')}>
            {dot}
          </span>
          <ListChecks size={13} className="search-globe" />
          <span className="tool-title">{tool.summary || '任务清单'}</span>
          {doneCount < todos.length && !busy ? (
            // 流已经结束了清单还有剩：明确写出来，别让人以为还在跑
            <span className="tool-name todo-gap">{doneCount}/{todos.length} · 差 {todos.length - doneCount} 项</span>
          ) : (
            <span className="tool-name">{doneCount}/{todos.length}</span>
          )}
          <ChevronDown size={12} className={todoOpen ? 'rot' : ''} />
        </button>
        {todoOpen && (
          <div className="todo-body">
            <div className="todo-progress"><div className="todo-progress-fill" style={{ width: `${pct}%` }} /></div>
            {todos.map((t, i) => (
              <div key={i} className={'todo-item ' + (t.status || 'pending')}>
                {t.status === 'completed' ? <Check size={13} className="todo-check" />
                  : t.status === 'in_progress'
                    ? (busy
                      ? <span className="todo-doing"><LoadingDots /></span>
                      : <span className="todo-stalled" title="这轮已经结束，这一项没有收尾"><Circle size={11} /></span>)
                    : <Circle size={11} className="todo-pending" />}
                <span>{t.content}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // edit_file / write_file：文件变更卡片（文件名可点 + 红绿 diff + +N −N）
  // members 有值时是「连续改同一个文件」合并成的组：标题只占一行，展开才看每次的明细，
  // 否则同一个文件被改 4 次就堆 4 张一模一样的卡片（CodeBuddy 的 tool-group-summary 同理）。
  if (tool.name === 'edit_file' || tool.name === 'write_file') {
    const parts = (members?.length ? members : [tool]).map((t) => {
      const isEdit = t.name === 'edit_file';
      const oldStr = isEdit ? String(t.args?.old_string ?? '') : '';
      const newStr = isEdit ? String(t.args?.new_string ?? '') : String(t.args?.content ?? '');
      return { tool: t, isEdit, diff: isEdit ? computeLineDiff(oldStr, newStr) : computeWriteDiff(newStr) };
    });
    const isGroup = parts.length > 1;
    const rawPath = String(tool.args?.path ?? '');
    const name = rawPath.split('/').pop() || rawPath || '文件';
    const isEdit = tool.name === 'edit_file';
    const added = parts.reduce((n, p) => n + p.diff.added, 0);
    const removed = parts.reduce((n, p) => n + p.diff.removed, 0);
    const hasChange = added > 0 || removed > 0;
    const title = isGroup ? `改动 ${name}` : `${isEdit ? '编辑' : '写入'} ${name}`;
    return (
      <div className={'tool-card file-change-card' + (open ? ' open' : '')}>
        <div className="tool-head file-change-head">
          <span className={'tool-dot' + (tool.ok === false ? ' fail' : done ? ' ok' : '')}>
            {dot}
          </span>
          <FileDiff size={13} className="search-globe" />
          {rawPath && onPreviewFile ? (
            <button className="file-change-name" onClick={() => onPreviewFile(rawPath)} title={`打开 ${rawPath}`}>
              {title}
              {isGroup && <span className="fc-count">×{parts.length}</span>}
            </button>
          ) : (
            <span className="tool-title">
              {title}
              {isGroup && <span className="fc-count">×{parts.length}</span>}
            </span>
          )}
          {hasChange && (
            <span className="file-change-stat">
              <span className="fc-add">+{added}</span>
              {removed > 0 && <span className="fc-del">−{removed}</span>}
            </span>
          )}
          <button className="file-change-toggle" onClick={() => setOpen((v) => !v)} title={open ? '收起' : '查看变更'}>
            {open ? '收起' : '查看变更'} <ChevronDown size={12} className={open ? 'rot' : ''} />
          </button>
        </div>
        {open && (
          <div className="file-change-diff">
            {parts.map((p, idx) => (
              <div className="diff-part" key={p.tool.id}>
                {isGroup && (
                  <div className="diff-part-head">
                    <span>第 {idx + 1} 次{p.isEdit ? '编辑' : '写入'}</span>
                    <span className="file-change-stat">
                      <span className="fc-add">+{p.diff.added}</span>
                      {p.diff.removed > 0 && <span className="fc-del">−{p.diff.removed}</span>}
                    </span>
                  </div>
                )}
                {showDiffLines(p.diff.lines).map((l, i) => (
                  <div key={i} className={'diff-line diff-' + l.type}>
                    <span className="diff-mark">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                    <span className="diff-text">{l.text || ' '}</span>
                  </div>
                ))}
                {p.diff.added === 0 && p.diff.removed === 0 && <div className="diff-empty">（无实际改动）</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const Icon = TOOL_ICONS[tool.name];
  return (
    <div className={'tool-card' + (open ? ' open' : '')}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className={'tool-dot' + (tool.ok === false ? ' fail' : done ? ' ok' : '')}>
          {dot}
        </span>
        {Icon && <Icon size={13} className="search-globe" />}
        <span className="tool-title">{toolStepSummary(tool.name, tool.args, tool.summary)}</span>
        <span className="tool-name">{tool.name}</span>
        <ChevronDown size={12} className={open ? 'rot' : ''} />
      </button>
      {tool.progress && (
        <div className="tool-progress-wrap">
          <div className="tool-progress-label">
            <span>{tool.progress.label}</span>
            <span>{tool.progress.current}/{tool.progress.total}</span>
          </div>
          <div className="todo-progress"><div className="todo-progress-fill" style={{ width: `${tool.progress.total ? Math.round(tool.progress.current / tool.progress.total * 100) : 0}%` }} /></div>
        </div>
      )}
      {open && tool.output && (tool.name === 'read_file'
        ? <NumberedOutput text={tool.output} />
        : <pre className="tool-output">{tool.output}</pre>)}
    </div>
  );
}

function LoadingDots({ light }: { light?: boolean }) {
  return <span className={'loading-dots' + (light ? ' loading-dots-light' : '')} aria-label="执行中"><i /><i /><i /></span>;
}

/**
 * read_file 的输出是「行号\t代码」。以前直接塞进 <pre>，浏览器 tab 默认 8 字符宽，
 * 行号和代码之间空出一大片（2026-11-21 用户报的"行号和代码离这么远"）。
 * 拆成两列：行号右对齐淡色、固定最小宽度，代码紧跟；行号位数再多也自动对齐。
 */
function NumberedOutput({ text }: { text: string }) {
  return (
    <pre className="tool-output code-lines">
      {text.split('\n').map((line, i) => {
        const m = /^(\d+)\t([\s\S]*)$/.exec(line);
        return (
          <div className="code-line" key={i}>
            <span className="code-ln">{m ? m[1] : ''}</span>
            <span className="code-text">{m ? m[2] : line}</span>
          </div>
        );
      })}
    </pre>
  );
}

/** 搜索结果右侧的站点名：完整 URL 太长，解析失败就留空 */
function resultHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** 按用户所说「bash/Shell 执行」：命令在卡片头、结果在卡片体 */
const SHELL_TOOLS = new Set(['run_command', 'bash', 'shell', 'execute_command', 'run_shell']);

function shellCommand(tool: ToolView): string {
  for (const key of ['cmd', 'command', 'script']) {
    const v = tool.args?.[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** 卡片头只显示一行摘要：优先用模型给的 purpose，否则从命令首行提取 */
function shellPreview(tool: ToolView): string {
  const summary = tool.summary?.trim().replace(/\s+/g, ' ');
  if (summary && summary !== tool.name) return summary;
  const firstLine = shellCommand(tool).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return firstLine ? `执行命令：${firstLine}` : tool.name;
}

/** 工具名 → 图标（一眼分清读/写/跑/查） */
const TOOL_ICONS: Record<string, typeof FileText> = {
  read_file: FileText,
  write_file: FilePlus2,
  edit_file: FileDiff,
  delete_file: Trash2,
  run_command: Terminal,
  get_terminal_output: Terminal,
  kill_job: Terminal,
  list_jobs: Terminal,
  web_fetch: Globe2,
  memory_save: Brain,
  memory_search: Brain,
  memory_delete: Brain,
  git_status: GitBranch,
  git_diff: GitBranch,
  git_log: GitBranch,
  git_commit: GitCommit,
  git_branch: GitBranch,
  git_stash: GitBranch,
  list_dir: FileText,
  search_file: FileText,
  search_content: FileText,
  search_parent_session: History,
};

/** diff 行数太多时截断，避免一张卡片撑爆聊天区（保留头尾各若干行） */
function showDiffLines(lines: DiffLine[]): DiffLine[] {
  const MAX_LINES = 30;
  if (lines.length <= MAX_LINES) return lines;
  return [
    ...lines.slice(0, 15),
    { type: 'same', text: `… 省略 ${lines.length - MAX_LINES} 行 …` },
    ...lines.slice(-15),
  ];
}
