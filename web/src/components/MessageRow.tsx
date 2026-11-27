import { memo, useEffect, useState } from 'react';
import { Activity, ArrowRightLeft, Brain, Check, ChevronDown, Copy, CornerUpLeft, Folder, Link2, Pencil, Play, Sparkles } from 'lucide-react';
import FileBadge from './FileBadge';
import { messageText, splitAttachmentPlaceholders, type ContentBlock, type PermissionDecision, type ToolCallBlock, type ViewMessage } from '@paw/shared';
import { extractSources } from '../lib/search-results';
import { extractSkillRefs } from '../lib/skill-refs';
import { attachmentKey } from '../lib/attachments';
import Markdown from './Markdown';
import AttachmentHoverArea from './AttachmentHoverArea';
import MessageEditor from './composer/MessageEditor';
import SourcesBlock from './SourcesBlock';
import ToolCard from './ToolCard';
import AskCard from './AskCard';
import PermissionCard, { type PermissionAskItem } from './PermissionCard';
import { WidgetCard, type WidgetHostApi } from './WidgetFrame';

/** 纯探查类工具：只读、无副作用，连续多个折成一行（见 items 构造处的说明） */
const PROBE_TOOLS = new Set(['read_file', 'list_dir', 'search_file', 'search_content', 'git_status', 'git_diff', 'git_log', 'memory_search', 'search_parent_session']);
/** 连续几个以上才折叠：两张卡片折起来反而多一次点击 */
const FOLD_MIN = 3;

/** 一条消息：用户气泡右对齐（带复制）；助手 = 思考折叠 + 工具卡片 + 正文 + 底部工具条 */
/** 耗时显示：45s / 2m3s / 1h2m（跟 CodeBuddy 一致，不显示毫秒） */
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h${rm}m` : `${h}h`;
}

/** 探查组的一行说明：全同类就说「读取 8 个文件」，混合就说「探查 12 步」 */
function foldLabel(group: ToolCallBlock[]): string {
  const kinds = new Set(group.map((t) => t.name));
  if (kinds.size > 1) return `探查 ${group.length} 步`;
  switch (group[0].name) {
    case 'read_file': return `读取 ${group.length} 个文件`;
    case 'search_content': return `搜索内容 ${group.length} 次`;
    case 'search_file': return `查找文件 ${group.length} 次`;
    case 'list_dir': return `列出 ${group.length} 个目录`;
    default: return `执行 ${group.length} 步`;
  }
}

function MessageRow({ m, fallbackModel, streaming, onOpenSession, onPreviewAttachment, onPreviewFile, onRewind, onRevert, onFork, onAnswerAsk, widgetHost, permissionAsks, onDecidePermission, onAllowGlobal, onOpenTrace, planApproval, onApprovePlan }: {  m: ViewMessage;
  fallbackModel?: string;
  streaming?: boolean;
  onOpenSession?: (id: string) => void;
  /** 点附件卡片 → 右侧文件预览面板打开它 */
  onPreviewAttachment?: (a: import('@paw/shared').Attachment) => void;
  /** 点工具卡片里的文件名 → 预览该文件 */
  onPreviewFile?: (path: string) => void;
  /** 编辑这条用户消息后重发：传新文本 */
  onRewind?: (newText: string, attachments: import('@paw/shared').Attachment[]) => Promise<boolean>;
  /** 回退：把对话和产物恢复到这条消息之前（会先弹确认框，由上层弹） */
  onRevert?: () => void;
  /** 从此消息分叉：保留原会话，工作区回退到分叉点 */
  onFork?: () => void;
  /** ask_user 卡片提交：答复文本作为下一条用户消息发出去 */
  onAnswerAsk?: (text: string) => void;
  /** 自定义部件的宿主能力（清单 + 桥接回调） */
  widgetHost?: WidgetHostApi;
  /** 本条助手消息关联的严格模式权限确认卡 */
  permissionAsks?: PermissionAskItem[];
  onDecidePermission?: (id: string, decision: PermissionDecision) => void;
  /** 把工具加入全局许可（只影响之后新建的会话） */
  onAllowGlobal?: (ask: PermissionAskItem) => void;
  /** 点击耗时徽标打开本轮执行轨迹 */
  onOpenTrace?: () => void;
  /** 只读计划模式下，最后一条已完成的助手消息可批准计划并开始执行 */
  planApproval?: boolean;
  onApprovePlan?: () => void;
}) {
  const [showReasoning, setShowReasoning] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  const [copied, setCopied] = useState(false);
  // 已展开的探查组：key 用组里第一个工具的 id（比下标稳，流式时 items 会重算）
  const [openFolds, setOpenFolds] = useState<Set<string>>(new Set());
  // 轮次折叠（整轮过程收起）是否展开
  const [turnOpen, setTurnOpen] = useState(false);
  // 流式期间的实时计时（每秒一次，结束后改用 m.durationMs）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [streaming]);
  // 用户消息原地编辑（气泡变输入框）
  const [editing, setEditing] = useState(false);

  const copy = () => {
    // 用户消息：把选中的技能和附件一起复制（WorkBuddy 风格引用）
    // 用解析后的正文+合并技能，避免 content 里已有 @skill 时重复
    const text = messageText(m);
    const parsed = m.role === 'user' ? extractSkillRefs(text) : null;
    const base = parsed?.text ?? text;
    const allSkills = [...new Set([...(parsed?.skillIds || []), ...(m.skillIds || [])])];
    const parts = [base];
    if (allSkills.length) parts.push(allSkills.map((id) => `@skill:${id}`).join(' '));
    // 正文里已经有 `@"名"` 占位符的附件不再重复追加
    const extraAtts = (m.attachments ?? []).filter((a) => !base.includes(`@"${a.name}"`));
    if (extraAtts.length) parts.push(extraAtts.map((a) => a.kind === 'image' ? `@image:${a.name}` : `@"${a.name}"`).join(' '));
    navigator.clipboard.writeText(parts.filter(Boolean).join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* 剪贴板被拒（非安全上下文/权限）时静默失败，别抛未处理 rejection */ });
  };
  // 存量消息：content 里可能带 @skill:xxx 纯文本（复制粘贴来的），渲染时提取成 chip
  const rawText = messageText(m);
  const parsedUser = m.role === 'user' ? extractSkillRefs(rawText) : null;
  const displayText = parsedUser?.text ?? rawText;
  const displaySkills = [...new Set([...(parsedUser?.skillIds || []), ...(m.skillIds || [])])];

  if (m.role === 'user') {
    const timeText = new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    // 附件全部做成 inline chip 放在气泡内（WorkBuddy 同款：图片也只是「图标 + 名字」，
    // 不是缩略图）。挂在气泡外会显得像「空消息 + 一张卡片」，也跟文字脱节。
    const bubbleAtts = m.attachments ?? [];
    const bubbleSegs = splitAttachmentPlaceholders(displayText, bubbleAtts) ?? [
      ...bubbleAtts.map((att) => ({ kind: 'chip' as const, att })),
      { kind: 'text' as const, text: displayText },
    ];
    const startEdit = () => setEditing(true);
    if (editing) {
      return (
        <div className="row user-row" data-message-id={m.id}>
          <MessageEditor text={displayText} attachments={bubbleAtts} onCancel={() => setEditing(false)} onSubmit={onRewind} />
        </div>
      );
    }
    return (
      <div className="row user-row" data-message-id={m.id}>
        <div className="user-bubble-wrap">
          {m.handoff && (
            <div className={'msg-handoff-card' + (showHandoff ? ' open' : '')}>
              <button type="button" className="msg-handoff-head" onClick={() => setShowHandoff((v) => !v)}>
                <ArrowRightLeft size={12} />
                <span>会话交接单 · 来自「{m.handoff.fromTitle}」</span>
                <ChevronDown size={12} className={showHandoff ? 'rot' : ''} />
              </button>
              {showHandoff && (
                <div className="msg-handoff-body">
                  <Markdown>{m.handoff.summary}</Markdown>
                  {onOpenSession && (
                    <button type="button" className="msg-handoff-jump" onClick={() => onOpenSession(m.handoff!.fromSessionId)}>
                      查看原会话 →
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <AttachmentHoverArea className="bubble" attachments={bubbleAtts}>
            {bubbleSegs.map((seg, i) => {
              if (seg.kind === 'text') return <span key={i}>{seg.text}</span>;
              const a = seg.att;
              return <span className="bubble-chip" key={i}
                data-preview-image={a.kind === 'image' ? attachmentKey(a.name, a.size) : undefined}
                onClick={onPreviewAttachment ? () => onPreviewAttachment(a) : undefined}
                style={onPreviewAttachment ? { cursor: 'pointer' } : undefined}
                title={a.kind === 'image' ? undefined : a.name}>
                {a.kind === 'image' ? <span className="attach-img-icon">▣</span> : a.mime === 'inode/directory' ? <Folder size={12} /> : <FileBadge name={a.name} size={12} />}
                <span className="bubble-chip-name">{a.name}</span>
              </span>;
            })}
          </AttachmentHoverArea>
          {/* 技能和附件放气泡外面（右对齐），气泡内只留文字更干净 */}
          {(displaySkills.length || m.connectionCode) ? (
            <div className="msg-extras">
              {displaySkills.map((id) => (
                <span className="msg-skill-chip" key={id} title={`本次使用了技能 ${id}`}>
                  <Sparkles size={12} /> {id}
                </span>
              ))}
              {m.connectionCode && (
                <span className="msg-skill-chip" title={`这条消息指定用系统连接 ${m.connectionCode}`}>
                  <Link2 size={12} /> {m.connectionCode}
                </span>
              )}
            </div>
          ) : null}
          {/* 时间 + 复制 / 重新生成 / 编辑：平时淡出，hover 气泡才亮 */}
          <div className="user-meta">
            <span className="user-time">{timeText}</span>
            <button className="user-act" onClick={copy} title={copied ? '已复制' : '复制'}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
            {onRevert && (
              <button className="user-act" onClick={onRevert} title="将对话及产物回退到此消息前">
                <CornerUpLeft size={12} />
              </button>
            )}
            {onFork && (
              <button className="user-act" onClick={onFork} title="从此消息分叉出新会话（原会话保留）">
                <ArrowRightLeft size={12} />
              </button>
            )}
            {onRewind && (
              <button className="user-act" onClick={startEdit} title="编辑">
                <Pencil size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  // 直接按 content 数组的顺序渲染：text 块是 markdown，tool-call 块是卡片。
  // 两家（CodeBuddy 的 timeline、dsh 的 ContentBlock[]）都是这么遍历的。
  const blocks = m.content;

  // ── 轮次折叠 ──────────────────────────────────────────────────────
  // 回复结束后，把中间所有过程（工具调用、中间稿、提问卡）收成一行，
  // 只留最后那段正文。CodeBuddy、Mano 都是这个形态（dsh 里叫 turn-process）。
  // 流式进行中不折——过程要实时可见，这时折叠等于把正在发生的事藏起来。
  let lastTextIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'text' && b.text.trim()) { lastTextIdx = i; break; }
  }
  const headRaw = lastTextIdx > 0 ? blocks.slice(0, lastTextIdx) : [];
  // widget 是成果块：即使工具在最后一段正文前发射，回复结束后也必须完整可见
  const head = headRaw.filter((b) => b.type !== 'widget');
  const turnFold = m.role === 'assistant' && !streaming && head.length > 0;
  /** 折叠区之外、按顺序正常渲染的块（部件从折叠区摘出，回到原顺序） */
  const bodyBlocks = turnFold ? blocks.filter((b, i) => i >= lastTextIdx || b.type === 'widget') : blocks;
  /** 折叠条上的步数：工具调用数（提问卡不算「步」） */
  const headSteps = head.filter((b) => b.type === 'tool-call').length;

  // 连续改同一个文件的调用合并成一组：同一个文件被改 4 次，不该堆 4 张一模一样的卡片。
  // 中间夹了正文/别的工具就断开（那说明不是同一段连续操作）。
  const isFileChange = (b: ContentBlock): b is ToolCallBlock =>
    b.type === 'tool-call' && (b.name === 'edit_file' || b.name === 'write_file');
  // 纯探查类工具：只读、无副作用，连续多个折成一行。
  // dsh 的 ChatGroupSeat、mano 的 ToolUseBatch 都是这么做的 —— 一个长任务里
  // read/search 能堆几十张卡片，折叠后 DOM 少一个数量级（长会话跑崩的主因之一）。
  const isProbe = (b: ContentBlock): b is ToolCallBlock =>
    b.type === 'tool-call' && PROBE_TOOLS.has(b.name);
  const items: { block: ContentBlock; group?: ToolCallBlock[]; fold?: ToolCallBlock[] }[] = [];
  for (let i = 0; i < bodyBlocks.length; i++) {
    const b = bodyBlocks[i];
    if (isFileChange(b)) {
      const path = String(b.args?.path ?? '');
      const group = [b];
      let j = i + 1;
      while (j < bodyBlocks.length) {
        const nb = bodyBlocks[j];
        if (!isFileChange(nb) || String(nb.args?.path ?? '') !== path) break;
        group.push(nb);
        j++;
      }
      if (group.length > 1) { items.push({ block: b, group }); i = j - 1; continue; }
    }
    // 连续探查：不足 FOLD_MIN 个就照原样展示（两张卡片折起来反而让人多一次点击）
    if (isProbe(b)) {
      const fold = [b];
      let j = i + 1;
      while (j < bodyBlocks.length) {
        const nb = bodyBlocks[j];
        if (!isProbe(nb)) break;
        fold.push(nb);
        j++;
      }
      if (fold.length >= FOLD_MIN) { items.push({ block: b, fold }); i = j - 1; continue; }
    }
    items.push({ block: b });
  }
  return (
    <div className="row assistant-row" data-message-id={m.id}>
      {m.reasoning && (
        <div className="reason-block">
          <button className="reason-head" onClick={() => setShowReasoning((v) => !v)}>
            <Brain size={13} />
            <span>{showReasoning ? '收起思考' : '深度思考'}</span>
            <ChevronDown size={12} className={showReasoning ? 'rot' : ''} />
          </button>
          {showReasoning && <div className="reason-body">{m.reasoning}</div>}
        </div>
      )}
      {turnFold && (
        <div className="turn-fold">
          <button className="turn-fold-head" onClick={() => setTurnOpen((v) => !v)}>
            <ChevronDown size={12} className={`fold-chev${turnOpen ? '' : ' closed'}`} />
            <span>{headSteps > 0 ? `已处理 ${headSteps} 步` : '处理过程'}</span>
            {m.durationMs ? <span className="turn-fold-time">{fmtDuration(m.durationMs)}</span> : null}
          </button>
          {turnOpen && (
            <div className="turn-fold-body">
              {head.map((b, i) => {
                if (b.type === 'ask') {
                  return <AskCard key={`hask-${i}`} questions={b.questions} answer={b.answer}
                    onSubmit={onAnswerAsk ?? (() => {})} />;
                }
                if (b.type === 'tool-call') {
                  return <ToolCard key={b.id} tool={b} busy={false} stopped={m.stopped}
                    onOpenSession={onOpenSession} onPreviewFile={onPreviewFile} />;
                }
                const src = extractSources(b.text);
                return (
                  <div className="answer" key={`htxt-${i}`}>
                    <Markdown>{src?.body ?? b.text}</Markdown>
                    <SourcesBlock items={src?.items || []} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {items.map((it, i) => {
        if (it.fold) {
          const key = it.fold[0].id;
          const open = openFolds.has(key);
          return (
            <div className="tool-fold" key={key}>
              <button
                className="tool-fold-head"
                onClick={() => setOpenFolds((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })}
              >
                <ChevronDown size={12} className={`fold-chev${open ? '' : ' closed'}`} />
                <span>{foldLabel(it.fold)}</span>
              </button>
              {open && (
                <div className="tool-fold-body">
                  {it.fold.map((t) => (
                    <ToolCard key={t.id} tool={t} busy={streaming && t.ok === undefined} stopped={m.stopped}
                      onOpenSession={onOpenSession} onPreviewFile={onPreviewFile} />
                  ))}
                </div>
              )}
            </div>
          );
        }
        if (it.block.type === 'ask') {
          return <AskCard key={`ask-${i}`} questions={it.block.questions} answer={it.block.answer}
            onSubmit={onAnswerAsk ?? (() => {})} />;
        }
        if (it.block.type === 'tool-call') {
          return <ToolCard key={it.block.id} tool={it.block} members={it.group} busy={streaming} stopped={m.stopped}
            onOpenSession={onOpenSession} onPreviewFile={onPreviewFile} />;
        }
        if (it.block.type === 'widget') {
          return widgetHost ? <WidgetCard key={it.block.id} block={it.block} host={widgetHost} messageId={m.id} /> : null;
        }
        const src = extractSources(it.block.text);
        return (
          <div className="answer" key={`txt-${i}`}>
            <Markdown>{src?.body ?? it.block.text}</Markdown>
            <SourcesBlock items={src?.items || []} />
          </div>
        );
      })}
      {permissionAsks && permissionAsks.length > 0 && onDecidePermission && (
        <div className="perm-list">
          {permissionAsks.map((ask) => (
            <PermissionCard key={ask.id} ask={ask} onDecide={onDecidePermission} onAllowGlobal={onAllowGlobal} />
          ))}
        </div>
      )}
      {m.error && <div className="msg-error">⚠️ {m.error}</div>}
      {blocks.length > 0 ? (
        // 底部工具条：生成中标识 + 耗时轨迹入口 + 复制 + 模型名（跟着最后一块走，不跟着正文走）
        <div className="msg-actions">
          {planApproval && !streaming && !m.stopped && !!messageText(m).trim() && onApprovePlan && (
            <button type="button" className="plan-approve-btn" onClick={onApprovePlan}
              title="退出只读计划模式，按上面的计划开始执行">
              <Play size={12} /> 批准计划并开始执行
            </button>
          )}
          {streaming && <span className="generating-hint"><LoadingDots /> 生成中… {fmtDuration(now - m.ts)}</span>}
          {m.stopped && <span className="generating-hint stopped-hint">已停止{m.durationMs ? ` · ${fmtDuration(m.durationMs)}` : ''}</span>}
          {!streaming && !m.stopped && m.durationMs && !turnFold ? (
            onOpenTrace ? (
              <button type="button" className="trace-trigger" onClick={onOpenTrace} title="查看本轮执行轨迹与耗时分解">
                <Activity size={12} /> 已完成 {fmtDuration(m.durationMs)}
              </button>
            ) : (
              <span className="generating-hint">已完成 {fmtDuration(m.durationMs)}</span>
            )
          ) : !streaming && !m.stopped && m.durationMs && turnFold && onOpenTrace ? (
            <button type="button" className="trace-trigger" onClick={onOpenTrace} title="查看本轮执行轨迹与耗时分解">
              <Activity size={12} /> 轨迹
            </button>
          ) : null}
          {!streaming && onFork && (
            <button className="action-btn" onClick={onFork} title="从此消息分叉出新会话（原会话保留）">
              <ArrowRightLeft size={13} />
            </button>
          )}
          <button className="action-btn" onClick={copy} title={copied ? '已复制' : '复制'}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          {(m.model || fallbackModel) && <span className="action-model">🐾 {m.model || fallbackModel}</span>}
        </div>
      ) : m.stopped ? (
        <div className="thinking stopped-hint">已停止生成</div>
      ) : streaming ? (
        <div className="thinking">
          <LoadingDots /> 深度思考中… {fmtDuration(now - m.ts)}
        </div>
      ) : null}
    </div>
  );
}

function LoadingDots() {
  return <span className="loading-dots" aria-label="生成中"><i /><i /><i /></span>;
}

/**
 * 只按「消息内容 + 是否在流式」判断要不要重渲染，忽略回调函数的引用变化。
 *
 * 为什么需要：一轮流式回复里每个 delta 都会 setSessions，父组件重渲染会把
 * 列表里所有消息一起 render（那个会话有 167 个工具卡片）。长任务跑到后面
 * 就是每帧上千个 VNode，把 Blink 的堆压爆（2026-11-22 白屏的直接诱因）。
 * 回调都是内联箭头，引用每次都变，默认的浅比较在这里等于没 memo，
 * 所以显式比较。回调里用的都是 setState / ref，忽略引用不会读到过期状态；
 * 而 m 变了（新消息、内容更新）一定会重新渲染，不会漏更新。
 */
export default memo(MessageRow, (a, b) =>
  a.m === b.m
  && a.streaming === b.streaming
  && a.fallbackModel === b.fallbackModel
  && a.widgetHost === b.widgetHost
  && a.permissionAsks === b.permissionAsks
  && a.planApproval === b.planApproval
  && Boolean(a.onFork) === Boolean(b.onFork)
  && Boolean(a.onRewind) === Boolean(b.onRewind));
