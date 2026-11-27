import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ArrowRightLeft, ArrowUp, Check, ChevronDown, Copy, CornerDownRight, FileText, HelpCircle, Image as ImageIcon, Link2, Paperclip, Pencil, Sparkles, Square, Trash2, X } from 'lucide-react';
import type { Attachment, ContextReading, HandoffContext, ViewMessage } from '@paw/shared';
import { getSkills, type ModelInfo } from '../api/client';
import { filesFromDataTransfer, hasDroppedFiles } from '../lib/dnd-files';
import ModelMenu from './ModelMenu';
import WorkspacePicker from './WorkspacePicker';
import ComposerEditor, { type ComposerFocus } from './composer/ComposerEditor';
import ContextMeter from './composer/ContextMeter';
import Markdown from './Markdown';

interface SkillItem { id: string; name: string; description: string }

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: Attachment[];
  skillIds: string[];
  connectionCode?: string;
  handoff?: HandoffContext;
  model: string;
  createdAt: number;
}

export interface BtwState {
  question: string;
  answer: string;
  streaming: boolean;
  error?: string;
}

/** 输入区：队列卡片 + /btw 旁路卡片 + textarea + 附件/技能 chip + 上传/技能/模型/发送 */
export default function Composer({
  input, attachments, readingFiles, busy, compacting, model, models, modelMenu, modelSearch, modelsRefreshing,
  contextSessionId, contextTurn, contextMessages, contextReading, selectedSkills, selectedConnection, onSelectConnection, focusRef,
  handoffDraft, onUpdateHandoffDraft, onClearHandoffDraft, onOpenHandoffSource, onCompact, onHandoff,
  btwMode = false, onToggleBtw, btwState = null, onStopBtw, onCloseBtw,
  queuedMessages = [], onSteerQueued, onEditQueued, onDeleteQueued,
  onInput, onAddFiles, onRemoveFile, onSkillPaste, onRestoreAttachment,
  onToggleSkill, onClearSkills,
  onToggleModel, onCloseModel, onModelSearch, onSelectModel, onSend, onStop,
}: {
  input: string;
  attachments: Attachment[];
  readingFiles: boolean;
  busy: boolean;
  compacting: boolean;
  model: string;
  models: ModelInfo[];
  modelMenu: boolean;
  modelSearch: string;
  modelsRefreshing: boolean;
  contextSessionId: string;
  contextTurn?: ViewMessage;
  contextMessages: ViewMessage[];
  contextReading?: ContextReading;
  selectedSkills: string[];
  /** 这条消息指定用哪个系统连接（null=不指定） */
  selectedConnection: string | null;
  onSelectConnection: (code: string | null) => void;
  /** 富文本输入区暴露的 focus（发送后自动聚焦） */
  focusRef: RefObject<ComposerFocus | null>;
  /** 待随首条消息发出的会话交接草稿（方案 A：独立可展开/可编辑卡片） */
  handoffDraft?: HandoffContext | null;
  onUpdateHandoffDraft?: (summary: string) => void;
  onClearHandoffDraft?: () => void;
  onOpenHandoffSource?: (sessionId: string) => void;
  onCompact?: () => void;
  onHandoff?: () => void;
  btwMode?: boolean;
  onToggleBtw?: () => void;
  btwState?: BtwState | null;
  onStopBtw?: () => void;
  onCloseBtw?: () => void;
  queuedMessages?: QueuedMessage[];
  onSteerQueued?: (id: string) => void;
  onEditQueued?: (id: string) => void;
  onDeleteQueued?: (id: string) => void;
  onInput: (v: string) => void;
  onAddFiles: (files: FileList | File[] | null) => void;
  onRemoveFile: (i: number) => void;
  /** 粘贴里带了 @skill:xxx —— 转成已选技能 */
  onSkillPaste: (skillIds: string[]) => void;
  /** undo 把删掉的 chip 还原时，把附件也还回来 */
  onRestoreAttachment: (a: Attachment) => void;
  onToggleSkill: (id: string) => void;
  onClearSkills: () => void;
  onToggleModel: () => void;
  onCloseModel: () => void;
  onModelSearch: (s: string) => void;
  onSelectModel: (id: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const skillWrapRef = useRef<HTMLDivElement>(null);
  const connWrapRef = useRef<HTMLDivElement>(null);
  const [skillMenu, setSkillMenu] = useState(false);
  const [connMenu, setConnMenu] = useState(false);
  const [conns, setConns] = useState<{ code: string; name: string; kind?: string }[]>([]);
  const [skillSearch, setSkillSearch] = useState('');
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const isImageModel = /^gpt-image-/i.test(model);

  useEffect(() => {
    if (skillMenu) void getSkills().then(setSkills);
  }, [skillMenu]);

  // 连接列表按需拉（和技能一样，打开菜单才请求）
  useEffect(() => {
    if (!connMenu) return;
    fetch('/api/connections').then((r) => r.json())
      .then((d: { connections?: { code: string; name: string; kind?: string }[] }) => setConns(d.connections || []))
      .catch(() => setConns([]));
  }, [connMenu]);

  useEffect(() => {
    if (!connMenu) return;
    const onDown = (e: MouseEvent) => {
      if (connWrapRef.current && !connWrapRef.current.contains(e.target as Node)) setConnMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [connMenu]);

  // 点击弹窗外关闭（用 mousedown：点按钮本身时 toggle 照常，点别处才关）
  useEffect(() => {
    if (!skillMenu) return;
    const onDown = (e: MouseEvent) => {
      if (skillWrapRef.current && !skillWrapRef.current.contains(e.target as Node)) setSkillMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [skillMenu]);
  const filteredSkills = skills.filter((s) =>
    (s.name + s.description).toLowerCase().includes(skillSearch.toLowerCase()));
  // 拖文件进输入框：之前这块没有 drop handler，文件冒泡到页面默认行为，
  // Electron 直接把窗口导航到那个文件（看起来就是「自动打开了」）。
  const [dragging, setDragging] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(true);
  const [btwCopied, setBtwCopied] = useState(false);
  const isBtwSend = !attachments.length && (btwMode || input.trim().startsWith('/btw '));
  const canSend = !compacting && !readingFiles && (btwMode ? !!input.trim() && !attachments.length : !!(input.trim() || attachments.length || handoffDraft));

  return (
    <div className="composer-wrap">
      {btwState && (
        <div className="btw-card">
          <div className="btw-head">
            <HelpCircle size={13} className="btw-icon" />
            <span className="btw-badge">/btw 只读旁路</span>
            <span className="btw-q" title={btwState.question}>{btwState.question}</span>
            <div className="btw-actions">
              {btwState.answer && !btwState.streaming && (
                <button
                  type="button"
                  className="btw-act-btn"
                  title={btwCopied ? '已复制' : '复制回答'}
                  onClick={() => {
                    navigator.clipboard.writeText(btwState.answer).then(() => {
                      setBtwCopied(true);
                      setTimeout(() => setBtwCopied(false), 1500);
                    }).catch(() => {});
                  }}
                >
                  {btwCopied ? <Check size={12} /> : <Copy size={12} />}
                </button>
              )}
              {btwState.streaming && onStopBtw && (
                <button type="button" className="btw-act-btn danger" title="停止旁路回答" onClick={onStopBtw}>
                  <Square size={11} fill="currentColor" />
                </button>
              )}
              {onCloseBtw && (
                <button type="button" className="btw-act-btn" title="关闭（不进入主对话）" onClick={onCloseBtw}>
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="btw-body">
            {btwState.error ? (
              <div className="btw-error">⚠️ {btwState.error}</div>
            ) : btwState.answer ? (
              <Markdown>{btwState.answer}</Markdown>
            ) : (
              <div className="btw-thinking">正在基于当前上下文只读思考…</div>
            )}
          </div>
        </div>
      )}
      {queuedMessages.length > 0 && (
        <div className="queue-card">
          <button type="button" className="queue-head" onClick={() => setQueueOpen((v) => !v)}>
            <ChevronDown size={13} className={queueOpen ? '' : 'collapsed'} />
            <span>队列 ({queuedMessages.length})</span>
            <span className="queue-hint">{busy ? '本轮完成后按顺序发送，点 ↑ 可强行提醒模型' : '等待发送'}</span>
          </button>
          {queueOpen && (
            <div className="queue-list">
              {queuedMessages.map((item) => (
                <div className="queue-item" key={item.id}>
                  <CornerDownRight size={13} className="queue-item-icon" />
                  <div className="queue-item-body">
                    {item.text && <span className="queue-item-text">{item.text}</span>}
                    {item.attachments.map((a, idx) => (
                      <span className="queue-chip" key={`${item.id}-a-${idx}`}>
                        {a.kind === 'image' ? <ImageIcon size={11} /> : <FileText size={11} />}
                        {a.name}
                      </span>
                    ))}
                    {item.skillIds.map((s) => (
                      <span className="queue-chip skill" key={`${item.id}-s-${s}`}>
                        <Sparkles size={11} />
                        {s}
                      </span>
                    ))}
                  </div>
                  <div className="queue-item-actions">
                    {onSteerQueued && (
                      <button
                        type="button"
                        className="queue-act-btn steer"
                        title={busy ? '强行提醒模型（立即插入当前轮次）' : '立即发送'}
                        onClick={() => onSteerQueued(item.id)}
                      >
                        <ArrowUp size={13} />
                      </button>
                    )}
                    {onEditQueued && (
                      <button
                        type="button"
                        className="queue-act-btn"
                        title="回到对话框编辑（编辑完排到队尾）"
                        onClick={() => onEditQueued(item.id)}
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                    {onDeleteQueued && (
                      <button
                        type="button"
                        className="queue-act-btn danger"
                        title="从队列中删除"
                        onClick={() => onDeleteQueued(item.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {handoffDraft && (
        <div className={'handoff-draft-card' + (handoffOpen ? ' open' : '')}>
          <div className="handoff-draft-head">
            <ArrowRightLeft size={13} className="handoff-icon" />
            <span className="handoff-draft-title">
              承接自
              {onOpenHandoffSource ? (
                <button type="button" className="handoff-source-link" onClick={() => onOpenHandoffSource(handoffDraft.fromSessionId)}>
                  「{handoffDraft.fromTitle}」
                </button>
              ) : `「${handoffDraft.fromTitle}」`}
            </span>
            <div className="handoff-draft-meta">
              {handoffDraft.changedFiles?.length ? <span>改动 {handoffDraft.changedFiles.length} 文件</span> : null}
              {handoffDraft.pendingTodos?.length ? <span>{handoffDraft.pendingTodos.length} 项待办</span> : null}
              {handoffDraft.activeDaemons?.length ? <span>{handoffDraft.activeDaemons.length} 个常驻服务</span> : null}
            </div>
            <button type="button" className="handoff-draft-toggle" onClick={() => setHandoffOpen((v) => !v)}>
              {handoffOpen ? '收起' : '查看 / 编辑'}
              <ChevronDown size={12} className={handoffOpen ? 'rot' : ''} />
            </button>
            {onClearHandoffDraft && (
              <button type="button" className="handoff-draft-close" title="移除交接单" onClick={onClearHandoffDraft}>
                <X size={13} />
              </button>
            )}
          </div>
          {handoffOpen && (
            <div className="handoff-draft-body">
              <textarea
                className="handoff-editor"
                value={handoffDraft.summary}
                onChange={(e) => onUpdateHandoffDraft?.(e.target.value)}
                rows={8}
                placeholder="编辑交接单内容，发送首条消息时将作为上下文交给新会话…"
              />
              <div className="handoff-draft-tip">提示：发送首条消息时将自动注入交接单；Agent 也可按需用 search_parent_session 回查原会话细节。</div>
            </div>
          )}
        </div>
      )}
      <div
        className={'composer' + (dragging ? ' dragging' : '')}
        onDragOver={(e) => {
          if (!hasDroppedFiles(e.dataTransfer)) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          // 拖进内部子元素也会触发 dragleave，不判断的话边框会闪
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(e) => {
          setDragging(false);
          // 内层（编辑器）已经处理过了，这里只管重置拖拽态
          if (e.defaultPrevented) return;
          if (!hasDroppedFiles(e.dataTransfer)) return;
          e.preventDefault();
          void filesFromDataTransfer(e.dataTransfer).then((files) => { if (files.length) onAddFiles(files); });
        }}
      >
        <ComposerEditor
          value={input}
          attachments={attachments}
          onChange={onInput}
          onSend={onSend}
          onRemoveAttachment={onRemoveFile}
          onRestoreAttachment={onRestoreAttachment}
          onSkillPaste={onSkillPaste}
          onDropFiles={(files) => {
            setDragging(false);
            if (files.length) onAddFiles(files);
          }}
          placeholder={
            btwMode
              ? '只读旁路提问（不调工具、不写入主对话）…  Enter 立即提问'
              : busy
                ? '会话进行中，输入内容将排队发送（输入 /btw 可并行只读提问）…  Enter 加入队列'
                : isImageModel
                  ? '描述你想画的图…  Enter 生成（可附图片做图生图）'
                  : '给 Paw 发消息…  Enter 发送，Shift+Enter 换行'
          }
          compactCompletion={!readingFiles && !attachments.length}
          disabled={compacting}
          focusRef={focusRef}
        />
        {/* 技能 chips 仍在框内上方（它不是正文的一部分，只是本条消息的开关） */}
        {selectedSkills.length > 0 && (
          <div className="attach-list">
            {selectedSkills.map((id) => (
              <span className="attach-chip skill-chip" key={`s-${id}`} title="已选技能，发送时注入完整指令">
                <Sparkles size={12} /> {id}
                <button onClick={() => onToggleSkill(id)} title="移除技能"><X size={11} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-bar">
          <input ref={fileRef} type="file" multiple hidden
            onChange={(e) => { onAddFiles(e.target.files); e.target.value = ''; focusRef.current?.focus(); }} />
          <button type="button" className="attach-btn" disabled={compacting} onClick={() => fileRef.current?.click()} title="上传文件">
            <Paperclip size={15} />
          </button>
          {/* 技能选择按钮 + 下拉 */}
          <div className="skill-wrap" ref={skillWrapRef}>
            <button className={'attach-btn' + (selectedSkills.length ? ' active' : '')}
              onClick={() => setSkillMenu((v) => !v)} title="选择技能">
              <Sparkles size={15} />
            </button>
            {skillMenu && (
              <div className="skill-menu popup-up">
                <input autoFocus value={skillSearch} onChange={(e) => setSkillSearch(e.target.value)} placeholder="搜索技能…" />
                <div className="skill-list">
                  {filteredSkills.map((s) => (
                    <button key={s.id} className={'skill-opt' + (selectedSkills.includes(s.id) ? ' selected' : '')}
                      onClick={() => onToggleSkill(s.id)}>
                      <span><strong>{s.name}</strong><small>{s.description.slice(0, 50)}</small></span>
                      {selectedSkills.includes(s.id) && <Check size={13} />}
                    </button>
                  ))}
                  {filteredSkills.length === 0 && <div className="popup-hint">没有匹配的技能</div>}
                </div>
                {selectedSkills.length > 0 && <button className="skill-clear" onClick={() => { onClearSkills(); setSkillMenu(false); }}>清除已选</button>}
              </div>
            )}
          </div>
          {/* 系统连接选择：这条消息要不要指定一个连接 */}
          <div className="skill-wrap conn-wrap" ref={connWrapRef}>
            <button className={'attach-btn' + (selectedConnection ? ' active' : '')}
              onClick={() => setConnMenu((v) => !v)} title="选择系统连接">
              <Link2 size={15} />
            </button>
            {selectedConnection && (
              <span className="conn-picked" onClick={() => setConnMenu(true)} title="点击更换">
                {conns.find((c) => c.code === selectedConnection)?.name || selectedConnection}
              </span>
            )}
            {connMenu && (
              <div className="skill-menu popup-up conn-menu">
                <div className="skill-list">
                  {conns.map((c) => (
                    <button key={c.code} className={'skill-opt' + (selectedConnection === c.code ? ' selected' : '')}
                      onClick={() => { onSelectConnection(c.code); setConnMenu(false); }}>
                      <span>
                        <strong>{c.name}</strong>
                        <small>{c.code} · {c.kind && c.kind !== 'http' ? c.kind.toUpperCase() : 'HTTP'}</small>
                      </span>
                      {selectedConnection === c.code && <Check size={13} />}
                    </button>
                  ))}
                  {conns.length === 0 && <div className="popup-hint">还没有配置系统连接</div>}
                </div>
                {selectedConnection && (
                  <button className="skill-clear" onClick={() => { onSelectConnection(null); setConnMenu(false); }}>
                    不使用连接
                  </button>
                )}
              </div>
            )}
          </div>
          <WorkspacePicker variant="chip" />
          {onToggleBtw && (
            <button
              type="button"
              className={'btw-toggle-chip' + (btwMode ? ' active' : '')}
              onClick={onToggleBtw}
              title="切换 /btw 只读旁路问答（不调工具、不写入主对话，主任务运行中也可随时问）"
            >
              /btw
            </button>
          )}
          <div className="composer-actions">
            <ContextMeter key={`${contextSessionId}/${contextTurn?.id ?? ''}`} sessionId={contextSessionId}
              turn={contextTurn} messages={contextMessages} live={contextReading}
              disabled={busy || compacting} onCompact={onCompact} onHandoff={onHandoff} />
            <ModelMenu
              model={model} models={models} open={modelMenu} search={modelSearch} refreshing={modelsRefreshing}
              onToggle={onToggleModel} onClose={onCloseModel} onSearch={onModelSearch} onSelect={onSelectModel}
            />
            {busy ? (
              <>
                {canSend && (
                  <button
                    className={'send-btn' + (isBtwSend ? '' : ' enqueue')}
                    onClick={() => onSend(input)}
                    title={isBtwSend ? '立即发起 /btw 只读提问 (Enter)' : '加入待发送队列 (Enter)'}
                  >
                    <ArrowUp size={15} />
                  </button>
                )}
                <button className="send-btn stop" onClick={onStop} title="停止">
                  <Square size={13} fill="currentColor" />
                </button>
              </>
            ) : (
              <button className="send-btn" onClick={() => onSend(input)} disabled={!canSend} title={readingFiles ? '正在读取附件…' : '发送'}>
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="footnote">内容由 AI 生成，重要信息请核对 Sources 链接</div>
    </div>
  );
}
