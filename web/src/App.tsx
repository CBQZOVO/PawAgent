import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDown, ArrowLeft, ArrowRight, ArrowRightLeft, CheckCircle2, ChevronUp, Eye, Globe, HelpCircle, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, Sparkles, X } from 'lucide-react';
import { messageText, type AgentEvent, type Attachment, type ContextReading, type HandoffContext, type PermissionDecision, type ScheduledTask, type SessionPermission, type TurnTrace, type ViewMessage, type WidgetBlock } from '@paw/shared';
import {
  approvePermissionApi, compactContext, createHandoff, exportSessionUrl, forkSessionApi, generateTitleApi, getGlobalPermissions, getModels, getPlugins, getSearchConfig, getSession, getTurnTracesApi, getWorkspace, importSessionsApi, notifyTurnEnd, putGlobalPermissions, removeWorkspace as removeWorkspaceApi, resolveBusinessPage, rewindFiles, setSearchConfig, setWorkspace, steerChat, streamBtw, streamChat, updateSessionPermissionApi,
  PLUGINS_CHANGED, WORKSPACE_CHANGED, type ModelInfo, type PluginPageInfo, type SearchProvider, type WidgetInfo,
} from './api/client';
import { widgetBlockFromEvent } from './lib/session-sync';
import { clearAttachments } from './lib/attachments';
import { filesFromDataTransfer, hasDroppedFiles } from './lib/dnd-files';
import { extractSkillRefs } from './lib/skill-refs';
import { toChatMessages } from './lib/store';
import { useAttachments } from './hooks/useAttachments';
import { useSessions } from './hooks/useSessions';
import Composer, { type BtwState, type QueuedMessage } from './components/Composer';
import MessageRow from './components/MessageRow';
import type { PermissionAskItem } from './components/PermissionCard';
import TracePanel from './components/TracePanel';
import Sidebar, { type SessionFinishStatus } from './components/Sidebar';
import TaskPanel from './components/TaskPanel';
import ToolsPage from './components/ToolsPage';
import TasksPage from './components/TasksPage';
import MemoryPage from './components/MemoryPage';
import PluginPageView from './components/PluginPageView';
import AgentFilePanel, { collectPreviewFiles, type PreviewFile } from './components/AgentFilePanel';
import type { TaskRunWithName } from './api/client';
import IdePanel from './components/IdePanel';
import WorkspacePicker from './components/WorkspacePicker';
import ConfirmDialog from './components/ConfirmDialog';
import type { PawMode } from './components/ModeMenu';
import ModeMenu from './components/ModeMenu';
import BackgroundTasks from './components/BackgroundTasks';
import Tips from './components/Tips';
import BrowserPanel, { normalizeBrowserUrl } from './components/BrowserPanel';
import WidgetPanel from './components/WidgetPanel';
import type { WidgetHostApi } from './components/WidgetFrame';
import { useColumnResize, storedWidth } from './hooks/useColumnResize';
import { useElementWidth } from './hooks/useElementWidth';
import { useStickToBottom } from './hooks/useStickToBottom';
import type { ComposerFocus } from './components/composer/ComposerEditor';
import { debugLog } from './lib/debug';

const uid = () => Math.random().toString(36).slice(2, 10);

/** 会话标题：附件 chip 会被序列化成 @"文件名"，直接截原文会把这个符号漏进侧栏和顶栏。
 *  把引用还原成纯文件名（保留信息量），压掉多余空格再截 24 字。 */
const titleFromText = (text: string): string =>
  text.replace(/@"([^"]*)"/g, ' $1 ').replace(/\s+/g, ' ').trim().slice(0, 24) || '新会话';

/** IDE 聊天列：默认 560px，最小 460px（气泡不被压扁），可拖到几乎整屏 */
const CHAT_DEFAULT = 560;
const CHAT_MIN = 460;
/** 代码区至少留这么宽，文件树 + 编辑区才不会挤成竖排文字 */
const CODE_KEEP = 420;
/** 消息列表一次渲染多少条：长会话（上千个工具卡片）全量渲染 + 每帧流式更新
 *  会把 Blink 的堆压爆，默认只渲染最近的，往上翻再逐批补（见 MessageRow 的 memo 注释） */
const MSG_PAGE = 40;
/** 上次打开的工作区：刷新后 IDE 面板立刻可用，不必先选会话 */

export default function App() {
  // 会话（SQLite + localStorage）
  const {
    sessions, setSessions, activeId, setActiveId: setActiveIdRaw, ready, ensureLoaded,
    createSession, deleteSession, applyEvent, applyEvents, syncSessionPermission, applyImportedSessions,
  } = useSessions();

  // 输入/状态
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  // 全局许可：只作为之后新建会话的初始 allow，不追溯已有会话；ref 供同步的 createSession 读取
  const [globalAllow, setGlobalAllow] = useState<string[]>([]);
  const globalAllowRef = useRef<string[]>([]);
  globalAllowRef.current = globalAllow;
  // 新对话尚未落库，输入框里选的模式先记在草稿里，首条消息发送时带进新会话
  const [draftPermissionMode, setDraftPermissionMode] = useState<SessionPermission['mode']>('default');
  const draftPermissionModeRef = useRef(draftPermissionMode);
  draftPermissionModeRef.current = draftPermissionMode;
  const pendingCompactions = useRef(new Set<string>());
  const [compactingIds, setCompactingIds] = useState<Set<string>>(new Set());
  const [compactNotice, setCompactNotice] = useState<{ sid: string; text: string } | null>(null);
  const [handoffBusyIds, setHandoffBusyIds] = useState<Set<string>>(new Set());
  const [handoffDrafts, setHandoffDrafts] = useState<Map<string, HandoffContext>>(new Map());
  const [contextReadings, setContextReadings] = useState<Map<string, { turnId: string; reading: ContextReading }>>(new Map());
  const currentSession = useRef(activeId);
  currentSession.current = activeId;
  /** 顶部标题就地重命名：Enter 保存 / Esc 取消 / 失焦保存。
   *  cancel 标记是为了挡住 Esc 卸载 input 时可能带出的 blur 提交。 */
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleGenerating, setTitleGenerating] = useState(false);
  const titleCancelRef = useRef(false);
  // 「生成中」绑定到会话：切走会话后，旧会话的运行状态不会错画到当前会话上
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  // 后台会话运行结束后的未读标记（侧栏徽标，点进会话后自动清除）与右上角可点击浮层提示
  const [unreadFinished, setUnreadFinished] = useState<Map<string, SessionFinishStatus>>(new Map());
  const [bgToasts, setBgToasts] = useState<Array<{ id: string; sessionId: string; title: string; status: SessionFinishStatus; at: number }>>([]);
  const bgToastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // 按会话隔离的待发送消息队列（会话进行中发消息自动排队，本轮完成后自动出队）
  const [queues, setQueues] = useState<Map<string, QueuedMessage[]>>(new Map());
  const queuesRef = useRef<Map<string, QueuedMessage[]>>(queues);
  queuesRef.current = queues;
  const manualStopRef = useRef<Set<string>>(new Set());
  const autoDrainIdsRef = useRef<Set<string>>(new Set());
  // 已发往 /api/chat/steer 但尚未被内核确认消费的插话；若本轮提前结束未消费则自动回滚回队首
  const inFlightSteersRef = useRef<Map<string, { sid: string; item: QueuedMessage }>>(new Map());
  /** 空串 = 还没拿到可用模型列表。别硬编码模型名：没权限时按钮还挂着它，误导用户 */
  const [model, setModel] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const modelsRefreshingRef = useRef(false);
  const [modelSearch, setModelSearch] = useState('');
  const [jumpTarget, setJumpTarget] = useState<{ sessionId: string; messageId: string; seq: number } | null>(null);
  const [btwMode, setBtwMode] = useState(false);
  const [btwState, setBtwState] = useState<BtwState | null>(null);
  const btwAbortRef = useRef<AbortController | null>(null);
  const [permissionAsks, setPermissionAsks] = useState<Map<string, PermissionAskItem[]>>(new Map());
  const permissionAsksRef = useRef(permissionAsks);
  permissionAsksRef.current = permissionAsks;
  const pendingPermCountRef = useRef<Map<string, number>>(new Map());
  const [traceView, setTraceView] = useState<{ trace: TurnTrace | null; loading: boolean } | null>(null);
  // 按会话隔离的输入草稿与模型选择：切走时保存当前会话的，切回时恢复目标会话的，互不串扰
  const draftsRef = useRef<Map<string, string>>(new Map());
  const sessionModelsRef = useRef<Map<string, string>>(new Map());
  const inputRef = useRef(input);
  inputRef.current = input;
  const modelRef = useRef(model);
  modelRef.current = model;
  /** 切换会话：统一走这里，别直接调 setActiveIdRaw（否则草稿/模型选择会丢或串台） */
  const switchSession = (id: string) => {
    const cur = currentSession.current;
    if (cur !== id) {
      if (cur) {
        draftsRef.current.set(cur, inputRef.current);
        if (modelRef.current) sessionModelsRef.current.set(cur, modelRef.current);
      }
      const draft = id ? (draftsRef.current.get(id) ?? '') : '';
      if (id) draftsRef.current.delete(id);
      if (inputRef.current !== draft) { inputRef.current = draft; setInput(draft); }
      const savedModel = id ? sessionModelsRef.current.get(id) : undefined;
      if (savedModel && savedModel !== modelRef.current && models.some((m) => m.id === savedModel)) {
        modelRef.current = savedModel;
        setModel(savedModel);
      }
    }
    currentSession.current = id;
    setActiveIdRaw(id);
  };
  const [provider, setProvider] = useState<SearchProvider>('deepseek');
  const [hasKey, setHasKey] = useState(true);
  const [providerMenu, setProviderMenu] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const [taskPanel, setTaskPanel] = useState(false);
  /** Agent 模式右侧文件预览面板开关 */
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  /** 点消息里的附件卡片：请求预览某个附件（id 变化触发） */
  const [previewRequest, setPreviewRequest] = useState<{ id: number; attachment?: Attachment; path?: string } | null>(null);
  /** 内置浏览器：点回答链接自动打开；与文件预览共用右侧区域，不同时开 */
  const [browserOpen, setBrowserOpen] = useState(false);
  /** 部件 open_business_page(mode: 'modal') 时把浏览器面板抬成浮层 */
  const [browserModal, setBrowserModal] = useState(false);
  const [browserRequest, setBrowserRequest] = useState<{
    id: number; url: string; key?: string; title?: string; partition?: string;
  } | null>(null);
  const browserW = () => storedWidth('paw-browser-width', 560, 420, 1000);
  const [browserWidth, setBrowserWidth] = useState(browserW);
  const browserResize = useColumnResize(browserWidth, setBrowserWidth, {
    min: 420, max: 1000, storeKey: 'paw-browser-width', defaultWidth: 560, invert: true,
  });
  /** 自定义部件：清单跟随插件热重载，面板实例按消息块 id 绑定 */
  const [widgetSpecs, setWidgetSpecs] = useState<WidgetInfo[]>([]);
  const [widgetPanel, setWidgetPanel] = useState<{ block: WidgetBlock; messageId?: string } | null>(null);
  const [widgetFull, setWidgetFull] = useState(false);
  const widgetW = () => storedWidth('paw-widget-width', 560, 420, 1000);
  const [widgetWidth, setWidgetWidth] = useState(widgetW);
  const widgetSendRef = useRef<(text: string) => void>(() => {});
  const widgetResize = useColumnResize(widgetWidth, setWidgetWidth, {
    min: 420, max: 1000, storeKey: 'paw-widget-width', defaultWidth: 560, invert: true,
  });
  useEffect(() => { setWidgetPanel(null); }, [activeId]);
  const [page, setPage] = useState<'chat' | 'tools' | 'tasks' | 'memory' | 'plugin'>('chat');
  const pageRef = useRef(page);
  pageRef.current = page;

  const dismissBgToast = useCallback((sid: string) => {
    const timer = bgToastTimersRef.current.get(sid);
    if (timer) {
      clearTimeout(timer);
      bgToastTimersRef.current.delete(sid);
    }
    setBgToasts((prev) => prev.some((t) => t.sessionId === sid) ? prev.filter((t) => t.sessionId !== sid) : prev);
  }, []);

  const clearSessionUnread = useCallback((sid: string) => {
    dismissBgToast(sid);
    setUnreadFinished((prev) => {
      if (!prev.has(sid)) return prev;
      const next = new Map(prev);
      next.delete(sid);
      return next;
    });
  }, [dismissBgToast]);

  const notifyBackgroundFinish = useCallback((sid: string, status: SessionFinishStatus, fallbackTitle: string) => {
    // 只有当前未停在该会话的对话页时，才需要后台结束提示（前台正在看时不打扰）
    if (sid === currentSession.current && pageRef.current === 'chat') return;
    const title = sessionsRef.current.find((s) => s.id === sid)?.title || fallbackTitle || '新会话';
    setUnreadFinished((prev) => {
      if (prev.get(sid) === status) return prev;
      const next = new Map(prev);
      next.set(sid, status);
      return next;
    });
    const prevTimer = bgToastTimersRef.current.get(sid);
    if (prevTimer) clearTimeout(prevTimer);
    setBgToasts((prev) => [
      { id: `${sid}-${Date.now()}`, sessionId: sid, title, status, at: Date.now() },
      ...prev.filter((t) => t.sessionId !== sid),
    ].slice(0, 4));
    bgToastTimersRef.current.set(sid, setTimeout(() => {
      bgToastTimersRef.current.delete(sid);
      setBgToasts((prev) => prev.filter((t) => t.sessionId !== sid));
    }, 12_000));
  }, []);

  useEffect(() => {
    if (activeId && page === 'chat') clearSessionUnread(activeId);
  }, [activeId, page, clearSessionUnread]);

  useEffect(() => () => {
    for (const timer of bgToastTimersRef.current.values()) clearTimeout(timer);
    bgToastTimersRef.current.clear();
  }, []);
  const [pluginPages, setPluginPages] = useState<PluginPageInfo[]>([]);
  const [activePluginPageKey, setActivePluginPageKey] = useState<string | null>(null);
  useEffect(() => {
    const syncPlugins = () => {
      void getPlugins()
        .then((inv) => {
          const pages = inv.pages || [];
          setPluginPages(pages);
          setWidgetSpecs(inv.widgets || []);
          setWidgetPanel((prev) => (prev && !(inv.widgets || []).some((w) => w.key === prev.block.widgetId) ? null : prev));
          setActivePluginPageKey((prev) => (prev && !pages.some((p) => p.key === prev) ? null : prev));
        })
        .catch(() => undefined);
    };
    syncPlugins();
    window.addEventListener(PLUGINS_CHANGED, syncPlugins);
    return () => window.removeEventListener(PLUGINS_CHANGED, syncPlugins);
  }, []);
  const activePluginPage = useMemo(
    () => pluginPages.find((p) => p.key === activePluginPageKey) || null,
    [pluginPages, activePluginPageKey],
  );
  /** 回退确认框：等用户点「回退」才真删 */
  const [revertAsk, setRevertAsk] = useState<{ sid: string; msgId: string } | null>(null);
  const [forkAsk, setForkAsk] = useState<{ sid: string; msgId: string } | null>(null);
  const [globalAllowAsk, setGlobalAllowAsk] = useState<PermissionAskItem | null>(null);
  /** 工具页默认 tab（侧栏入口可指定；页面内切换由子页自己管） */
  const [toolsTab, setToolsTab] = useState<'mcp' | 'skills' | 'plugins' | 'connections' | 'permissions'>('mcp');
  const [tasksTab, setTasksTab] = useState<'tasks' | 'runs'>('tasks');
  // Agent / IDE 模式：不记忆，永远从 Agent 开始。
  // 编辑器（IDE）是「手动打开」的动作，不是默认界面 —— 跟 WorkBuddy 一致：
  // 打开应用先说话，要看代码再点开。所以这里连 sessionStorage 都不写，
  // 刷新页面也回到 Agent（避免「上次在 IDE，刷新后又莫名其妙进三栏」）。
  const [mode, setMode] = useState<PawMode>('agent');
  const changeMode = (m: PawMode) => {
    setMode(m);
    // 进 IDE 自动收起侧栏节约空间；回 Agent 自动展开（用户仍可手动切换）
    setSideCollapsed(m === 'ide');
    if (m !== 'ide') setChatMax(false);
  };
  // IDE：本会话 Agent 写/改/删过的文件（变更徽标 + 自动重载当前标签）
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set());
  const [ideReloadTick, setIdeReloadTick] = useState(0);
  // IDE 根目录只认「当前会话的工作区」或「用户显式选的目录」，不做持久化恢复：
  // 之前会从 localStorage 捡上次的目录，导致没选工作区切 IDE 也会被塞进某个项目里
  // （2026-11-22 用户报「为什么给我打开了第一个工作区」）。
  const [ideRoot, setIdeRoot] = useState<string | null>(null);
  // IDE：聊天列宽（可拖，最小 460 保证气泡不被压扁）、全屏覆盖态、侧栏折叠
  const [chatWidth, setChatWidth] = useState(() => storedWidth('paw-ide-chat', CHAT_DEFAULT, CHAT_MIN, 1600));
  const [chatMax, setChatMax] = useState(false);
  // IDE 里把右侧对话区收起来（代码区铺满）。跟模式一样不记忆，临时布局动作。
  const [chatHidden, setChatHidden] = useState(false);
  const toggleChat = () => setChatHidden((v) => { if (!v) setChatMax(false); return !v; });
  // 侧栏不记忆：每次进来都是展开态（Agent 默认全展开，进 IDE 时自动收成图标条）
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [layoutRef, layoutWidth] = useElementWidth<HTMLDivElement>(page === 'chat' && mode !== 'ide' && filePanelOpen);
  // Agent 文件预览面板宽度：存比例（默认 0.5 = 对话/预览各占一半），窗口变化自动按比例
  const [panelRatio, setPanelRatio] = useState(() => {
    const n = Number(localStorage.getItem('paw-agent-panel-ratio'));
    return Number.isFinite(n) && n >= 0.2 && n <= 0.8 ? n : 0.5;
  });
  const panelW = Math.round((layoutWidth || 1200) * panelRatio);
  const panelCap = Math.max(320, layoutWidth - 380); // 对话区至少留 380
  const panelResize = useColumnResize(panelW, (w) => {
    if (layoutWidth <= 0) return;
    const r = Math.min(0.8, Math.max(0.2, w / layoutWidth));
    setPanelRatio(r);
    localStorage.setItem('paw-agent-panel-ratio', String(r));
  }, {
    min: 320,
    max: () => panelCap,
    invert: true, // 把手在面板左侧：往右拖 → 面板变窄
  });
  // 双击分隔线还原各占一半
  const panelResizeHalf = {
    ...panelResize,
    onDoubleClick: () => {
      setPanelRatio(0.5);
      localStorage.setItem('paw-agent-panel-ratio', '0.5');
    },
  };
  const chatColRef = useRef<HTMLDivElement>(null);
  const chatResize = useColumnResize(chatWidth, setChatWidth, {
    min: CHAT_MIN,
    startWidth: () => chatColRef.current?.offsetWidth ?? chatWidth,
    max: () => Math.max(chatColRef.current?.offsetWidth ?? CHAT_MIN, (layoutRef.current?.clientWidth ?? 0) - CODE_KEEP),
    storeKey: 'paw-ide-chat', defaultWidth: CHAT_DEFAULT, invert: true,
  });
  const toggleSide = () => setSideCollapsed((v) => !v);
  // 弹窗打开时临时关掉 Electron 的窗口拖拽区：
  // -webkit-app-region:drag 在 macOS 上会穿透 z-index 吞掉弹窗按钮的 hover/点击
  // （Web 端没这属性所以正常）。用 MutationObserver 一处监听所有 .modal-backdrop。
  useEffect(() => {
    const sync = () => {
      document.body.classList.toggle('paw-modal-open', !!document.querySelector('.modal-backdrop'));
    };
    const obs = new MutationObserver(sync);
    obs.observe(document.body, { childList: true, subtree: true });
    sync();
    return () => obs.disconnect();
  }, []);
  // 服务端工作区被别处改动（切换/移除）时同步 IDE 根目录
  useEffect(() => {
    const sync = () => void getWorkspace().then((w) => { if (w.root) setIdeRoot(w.root); });
    sync();
    window.addEventListener(WORKSPACE_CHANGED, sync);
    return () => window.removeEventListener(WORKSPACE_CHANGED, sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 每个运行中的会话一个取消器：停止只停当前会话，不影响别的会话
  const abortMap = useRef<Map<string, AbortController>>(new Map());
  // 按会话维度的同步发送锁：挡住 getWorkspace/ensureLoaded 异步空档期内的双击重入，
  // 同时不阻塞用户切到新会话或另一会话并发提问（避免全局布尔锁吞掉其它会话消息）。
  const dispatchingIdsRef = useRef<Set<string>>(new Set());
  // activeId 的同步镜像：IDE 变更徽标只在该会话正是当前会话时应用，防止后台流串台
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  /** 打开内置浏览器：回答链接、Electron 拦下的 target=_blank、Agent 的 open_browser 事件都走这里 */
  const openBrowserUrl = useCallback((raw: string, key?: string, partition?: string, title?: string) => {
    const url = normalizeBrowserUrl(raw);
    if (!url) return;
    setBrowserRequest({ id: Date.now() + Math.random(), url, key, partition, title });
    setBrowserModal(false);
    setBrowserOpen(true);
    setFilePanelOpen(false);
    setWidgetPanel(null);
  }, []);

  // 一条捕获拦截覆盖所有外链（回答正文 / 搜索结果 / 工具卡片 / Markdown 预览）：
  // 维护单独的 a 组件只覆盖其中一部分，漏掉的链接仍会尝试导航或被系统浏览器打开。
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const a = el?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.closest('.browser-panel')) return;
      const url = normalizeBrowserUrl(a.getAttribute('href'));
      if (!url) return;
      e.preventDefault();
      openBrowserUrl(url, `link:${url}`);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [openBrowserUrl]);

  // Electron 主进程把 target=_blank/window.open 转到这里
  useEffect(() => {
    const bridge = (window as unknown as {
      pawDesktop?: { onOpenUrl?: (cb: (url: string) => void) => () => void };
    }).pawDesktop;
    return bridge?.onOpenUrl?.((url) => openBrowserUrl(url, `link:${url}`));
  }, [openBrowserUrl]);
  // 空会话的显式工作区：顶部新会话=null；工作区 + =该工作区；null=未指定（沿用当前工作区）
  const nextWorkspaceRef = useRef<{ value: string | null } | null>(null);
  const focusRef = useRef<ComposerFocus | null>(null);

  // 附件（文件读取/粘贴/拖拽/增删）
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  /** 这条消息指定用哪个系统连接（code）；null=不指定 */
  const [selectedConnection, setSelectedConnection] = useState<string | null>(null);
  const { attachments, readingFiles, addFiles, addRefs, setFiles, removeFile, clearFiles } = useAttachments(setError);
  const active = sessions.find((s) => s.id === activeId) || null;
  // 切会话：清掉上一个会话里点开的附件预览请求
  useEffect(() => { setPreviewRequest(null); }, [activeId]);
  /** 当前会话里所有可预览文件（仅在预览面板打开时扫描消息，避免流式期间每个增量遍历整段会话） */
  const previewFiles: PreviewFile[] = useMemo(
    () => (filePanelOpen ? collectPreviewFiles(active?.messages || []) : []),
    [filePanelOpen, active?.messages],
  );

  // 启动/切换会话时让当前工作区跟随会话，避免重开后上下文不一致
  const followedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;        // 会话列表还没合并完，别用摘要版把 ideRoot 抹掉
    if (!activeId) { followedRef.current = null; return; } // 空会话：ideRoot 由 startNewChat 设置
    if (followedRef.current === activeId) return;          // 同一会话只跟随一次（列表推送不该重置 IDE 目录）
    const s = sessions.find((x) => x.id === activeId);
    if (!s) return;
    followedRef.current = activeId;
    setChangedFiles(new Set()); // 变更徽标按会话隔离
    const ws = s.workspace ?? null;
    void setWorkspace(ws);
    // 会话没绑工作区 → ideRoot 置空，IDE 显示「先选工作区」，不要替用户猜一个目录
    setIdeRoot(ws);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, ready, sessions]);

  // 按需加载消息正文：等 ready（服务端摘要合并完成）再拉。
  // 若在合并前拉，服务端快照会被 mergeSessions 的摘要版覆盖 → 正文永远空。
  useEffect(() => {
    if (!ready || !activeId) return;
    void ensureLoaded(activeId);
  }, [ready, activeId]);

  /** 拉模型列表：失败时保留旧列表，别因为一次网关抖动把下拉清空 */
  const refreshModels = useCallback(async () => {
    if (modelsRefreshingRef.current) return;
    modelsRefreshingRef.current = true;
    setModelsRefreshing(true);
    try {
      const d = await getModels();
      if (d.models?.length) {
        setModels(d.models);
        // 只从网关实际返回的列表里选：default 可能是本地配置的旧模型（没权限网关不返回它）
        const fallback = d.models.some((m) => m.id === d.default) ? d.default! : d.models[0].id;
        setModel((prev) => d.models.some((m) => m.id === prev) ? prev : fallback);
      } else if (!d.error) {
        setModels([]);
      }
    } catch {
      /* 保留旧列表 */
    } finally {
      modelsRefreshingRef.current = false;
      setModelsRefreshing(false);
    }
  }, []);

  const toggleModelMenu = () => {
    if (!modelMenu) void refreshModels(); // 每次点开都实时刷新 /v1/models
    setModelMenu((v) => !v);
  };

  // 启动时拉模型列表 + 搜索配置
  useEffect(() => {
    void refreshModels();
    void getGlobalPermissions()
      .then((d) => setGlobalAllow(d.allow))
      .catch(() => setGlobalAllow([]));
    getSearchConfig()
      .then((c) => { setProvider(c.provider); setHasKey(c.hasDeepseekKey); })
      .catch(() => setHasKey(false));
  }, [refreshModels]);
  // 兜底：任何没挂 drop handler 的地方（侧栏、标题栏、留白）都把拖放的默认行为拦掉。
  // 否则 Electron 会把窗口导航到 file:// —— 表现就是「拖个文件进来，界面直接变成了它」。
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  // 消息流滚动：只在用户本来就在底部时跟随，上翻就停住（"回到底部"按钮）
  const bottom = useStickToBottom<HTMLDivElement>(active?.messages);
  // 已手动加载到的最早下标：null=没手动加载过，跟着「最近 MSG_PAGE 条」自动走。
  // 用锚点而不是「加载了几批」——流式输出时消息总数一直在涨，
  // 按批数算会让顶部不断裁掉消息，正在翻历史的视图被一条条顶走。
  const [loadedFrom, setLoadedFrom] = useState<number | null>(null);
  // 输入法组字守卫：Enter 确认候选词时不能当成发送
  // 切会话回到跟随态：上个会话翻在半路，别把这个状态带进新会话
  useEffect(() => { bottom.reset(); setLoadedFrom(null); }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 从任务/工具等页面回到聊天：消息区是重新挂载的，目标会话可能就是当前 activeId
  //（上面那个 effect 不会跑），统一在回到聊天页时强制回到底部跟随态
  useEffect(() => { if (page === 'chat') bottom.reset(); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 顶部“新会话”：普通会话，不挂任何工作区 */
  const startNewChat = (workspace: string | null) => {
    nextWorkspaceRef.current = { value: workspace };
    void setWorkspace(workspace);
    setIdeRoot(workspace); // IDE 面板立即可用（不必等第一条消息）
    switchSession('');
    if (inputRef.current) { inputRef.current = ''; setInput(''); }
    setPage('chat');
    clearFiles();
    setSelectedSkills([]);
    setError('');
    setTimeout(() => focusRef.current?.focus(), 50);
  };
  const onNew = () => startNewChat(null);
  const onNewInWorkspace = (workspace: string) => startNewChat(workspace);

  // 空白新对话上用户通过工作区选择器切换/添加工作区 → 这是显式意图，覆盖 startNewChat 预设的归属。
  // 不这么做：顶层「新会话」把 explicit 置空后，用户再在工作区 + 里选了文件夹，
  // 首条消息仍会按过期的 null 建到「最近任务」。
  useEffect(() => {
    let seq = 0;
    const sync = (e: Event) => {
      const cur = ++seq;
      if (activeIdRef.current) return; // 已有会话：工作区跟随会话，不动 explicit
      const detail = (e as CustomEvent<{ root?: string | null }>).detail;
      if (detail && 'root' in detail) {
        const nextRoot = detail.root ?? null;
        nextWorkspaceRef.current = { value: nextRoot };
        setIdeRoot(nextRoot);
        return;
      }
      void getWorkspace().then((w) => {
        if (cur !== seq || activeIdRef.current) return;
        nextWorkspaceRef.current = { value: w.root };
        setIdeRoot(w.root);
      });
    };
    window.addEventListener(WORKSPACE_CHANGED, sync);
    return () => window.removeEventListener(WORKSPACE_CHANGED, sync);
  }, []);

  const switchProvider = async (p: SearchProvider) => {
    setProviderMenu(false);
    try { await setSearchConfig(p); setProvider(p); }
    catch (e) { setError((e as Error).message); }
  };

  /** 标记某会话本轮为已停止（立刻清掉“思考中”，并随消息落库）。msgId 定位那一轮，缺省取最后一条 */
  const markStreamStopped = (sid: string, msgId?: string) => {
    setSessions((prev) => prev.map((s) => s.id === sid ? {
      ...s,
      messages: s.messages.map((m, i) => {
        const isTarget = msgId ? m.id === msgId : i === s.messages.length - 1;
        return isTarget && m.role === 'assistant' ? { ...m, stopped: true } : m;
      }),
    } : s));
  };

  /** 记录本轮耗时：写回 assistant 消息，折叠条上显示「已处理 5 步 · 2m3s」。
   *  存在消息上而不是组件 state，刷新/切会话后仍然在。 */
  const recordDuration = (sid: string, ms: number, msgId?: string) => {
    setSessions((prev) => prev.map((s) => s.id === sid ? {
      ...s,
      messages: s.messages.map((m, i) => {
        const isTarget = msgId ? m.id === msgId : i === s.messages.length - 1;
        return isTarget && m.role === 'assistant' ? { ...m, durationMs: ms } : m;
      }),
    } : s));
  };

  /** 移除工作区引用：磁盘目录不动，该工作区下的会话归回“最近任务” */
  const removeWorkspaceFromList = async (root: string) => {
    await removeWorkspaceApi(root);
    setSessions((prev) => prev.map((s) => s.workspace === root ? { ...s, workspace: undefined } : s));
  };

  /** 改标题只改会话元数据，不碰消息；useSessions 的防抖推送会把它写回 SQLite */
  const beginTitleEdit = () => {
    if (!active) return;
    titleCancelRef.current = false;
    setTitleDraft(active.title);
    setTitleEditing(true);
  };
  const commitTitle = () => {
    if (titleCancelRef.current) { titleCancelRef.current = false; setTitleEditing(false); return; }
    const t = titleDraft.trim().slice(0, 24);
    if (t && activeId) {
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, title: t, updatedAt: Date.now() } : s));
    }
    setTitleEditing(false);
  };
  const cancelTitleEdit = () => {
    titleCancelRef.current = true;
    setTitleEditing(false);
  };
  /** 从首条用户消息重新生成标题，只填进输入框，不直接保存——让人看一眼再定 */
  const regenerateTitle = async () => {
    const s = sessions.find((x) => x.id === activeId);
    if (!s || titleGenerating) return;
    // 列表里的会话是摘要态（messages 空），先按需拉正文，否则只能拿当前标题当输入
    const full = await ensureLoaded(s.id);
    const first = (full?.messages ?? s.messages).find((m) => m.role === 'user');
    const text = first ? messageText(first) : s.title;
    if (!text) return;
    setTitleGenerating(true);
    try {
      const t = await generateTitleApi(text, model);
      if (t) setTitleDraft(t);
    } finally {
      setTitleGenerating(false);
    }
  };

  /** 发送核心：往指定会话发一条消息（新对话时 sid 传空）。send 和定时任务"立即运行"共用 */
  const dispatch = async (
    text: string, mdl: string, atts: Attachment[], skills: string[], sid?: string,
    source?: 'task', taskId?: string,
    /** 显式指定历史基线：编辑/重发时用截断后的消息，别去读服务端还没更新的旧数据 */
    historyBase?: ViewMessage[],
    /** 这条消息指定用哪个系统连接（空=不指定） */
    connectionCode?: string,
    /** 首条消息附带的会话交接单 */
    handoff?: HandoffContext,
    /** 本轮显式权限（批准计划/新建会话尚未落库时，避免读到过期状态） */
    permissionOverride?: SessionPermission,
  ) => {
    if (!text && !atts.length && !handoff) return;
    const isExistingSession = !!sid && sessions.some((s) => s.id === sid);
    const lockKey = isExistingSession ? sid! : '__creating__';
    if (dispatchingIdsRef.current.has(lockKey) || (isExistingSession && runningIds.has(sid!))) return;
    dispatchingIdsRef.current.add(lockKey);

    let targetId = sid;
    let ws: string | null;
    // 新会话首轮：全局许可要同时落到本地会话和这一轮请求，避免 800ms 防抖落库前丢失
    let createdPermission: SessionPermission | undefined;
    // 首条消息才生成标题：后续轮次不改标题，避免每次发消息都白调一次模型
    const existingSession = isExistingSession ? sessions.find((s) => s.id === sid) : undefined;
    const isFirstMessage = !isExistingSession || (existingSession?.messages.length ?? 0) === 0;
    const parentSessionId = existingSession?.handoffFrom?.sessionId || handoff?.fromSessionId;
    try {
      if (!isExistingSession) {
        const explicit = nextWorkspaceRef.current;
        ws = explicit ? explicit.value : ((await getWorkspace()).root ?? null);
        nextWorkspaceRef.current = null;
        createdPermission = { mode: draftPermissionModeRef.current, allow: [...globalAllowRef.current], deny: [] };
        targetId = createSession({ title: titleFromText(text), source, taskId, workspace: ws || undefined, permission: createdPermission });
        dispatchingIdsRef.current.delete('__creating__');
        dispatchingIdsRef.current.add(targetId);
        if (mdl) sessionModelsRef.current.set(targetId, mdl);
        switchSession(targetId);
      } else {
        if (runningIds.has(sid!)) {
          dispatchingIdsRef.current.delete(sid!);
          return;
        }
        // 工作区以用户当前看到的为准（切换会话时已自动跟随会话工作区）
        ws = (await getWorkspace()).root ?? null;
      }
    } catch (err) {
      dispatchingIdsRef.current.delete(lockKey);
      if (targetId) dispatchingIdsRef.current.delete(targetId);
      throw err;
    }
    const effectiveText = text || (handoff ? '请基于交接单继续推进下一步工作。' : '');
    const userMsg: ViewMessage = {
      id: uid(), role: 'user', content: [{ type: 'text', text: effectiveText }], ts: Date.now(),
      attachments: atts.length ? atts : undefined,
      skillIds: skills.length ? skills : undefined,
      connectionCode: connectionCode || undefined,
      handoff: handoff || undefined,
    };
    const assistantMsg: ViewMessage = { id: uid(), role: 'assistant', content: [], ts: Date.now(), model: mdl };
    const runId = source === 'task' && taskId ? `run-${uid()}` : undefined;
    // 历史用完整消息（会话消息按需加载；拿不到详情就用内存里的）
    const base = historyBase ?? (await ensureLoaded(targetId!))?.messages ?? sessions.find((s) => s.id === targetId)?.messages ?? [];
    const history = toChatMessages([...base, userMsg]);
    setSessions((prev) => prev.map((s) => s.id === targetId ? {
      ...s,
      runId: runId ?? s.runId,
      title: s.messages.length === 0 && !s.handoffFrom ? titleFromText(effectiveText) : s.title,
      messages: [...s.messages, userMsg, assistantMsg],
      updatedAt: Date.now(),
    } : s));
    setError('');
    const ctrl = new AbortController();
    abortMap.current.set(targetId!, ctrl);
    setRunningIds((prev) => new Set(prev).add(targetId!));
    clearSessionUnread(targetId!);
    const m0tools = new Map<string, Record<string, unknown>>(); // tool id → args（IDE 变更追踪用）
    if (ws) setIdeRoot(ws);
    // 看门狗：半开连接（合盖唤醒、代理静默断开）时 reader.read() 永久挂起且不抛错，
    // 会话就永远“生成中”。超过 6 分钟没有任何事件 → 主动断开（前台命令最长 300s，留足余量）。
    let lastEventAt = Date.now();
    let watchdogFired = false;
    const watchdog = setInterval(() => {
      if ((pendingPermCountRef.current.get(targetId!) || 0) > 0) {
        lastEventAt = Date.now();
        return;
      }
      if (Date.now() - lastEventAt > 360_000) { watchdogFired = true; ctrl.abort(); }
    }, 30_000);
    let sawDone = false;
    let sawAsk = false;
    let sawError = false;
    let caughtError = false;
    // 正文与工具调用计数：模型“正常结束”但一个字没回时给出明确提示，别静默结束
    let textChars = 0;
    let toolCount = 0;
    // 高频流式增量（text / reasoning / tool_progress / 子代理 text）按 16ms 帧合并 setSessions，
    // 关键边界事件（tool_start / tool_done / ask / error / done）立即同步冲刷，兼顾零延迟卡片与低 CPU 渲染开销。
    let eventBuf: AgentEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushEvents = () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!eventBuf.length) return;
      const batch = eventBuf;
      eventBuf = [];
      applyEvents(targetId!, batch, assistantMsg.id);
    };
    try {
      for await (const ev of streamChat(history, {
        model: mdl, signal: ctrl.signal, attachments: atts, skillIds: skills,
        connectionCode: connectionCode || undefined,
        workspace: ws, taskRun: runId && taskId ? { taskId, runId } : undefined,
        sessionId: targetId, turnId: userMsg.id,
        handoff, parentSessionId,
        permission: permissionOverride ?? existingSession?.permission ?? createdPermission,
      })) {
        lastEventAt = Date.now();
        if (ev.type === 'text') textChars += (ev.delta || '').trim().length;
        if (ev.type === 'tool_start') toolCount++;
        if (ev.type === 'context_usage') {
          setContextReadings((prev) => {
            const next = new Map(prev);
            next.set(targetId!, { turnId: userMsg.id, reading: ev.reading });
            return next;
          });
          continue;
        }
        if (ev.type === 'permission_ask') {
          flushEvents();
          pendingPermCountRef.current.set(targetId!, (pendingPermCountRef.current.get(targetId!) || 0) + 1);
          const item: PermissionAskItem = {
            id: ev.id,
            sessionId: targetId!,
            messageId: assistantMsg.id,
            toolCallId: ev.toolCallId,
            tool: ev.tool,
            title: ev.title,
            detail: ev.detail,
            options: ev.options,
            status: 'pending',
          };
          setPermissionAsks((prev) => {
            const next = new Map(prev);
            const cur = next.get(assistantMsg.id) || [];
            next.set(assistantMsg.id, [...cur, item]);
            return next;
          });
          continue;
        }
        if (ev.type === 'permission_updated') {
          syncSessionPermission(targetId!, ev.permission);
          continue;
        }
        if (ev.type === 'permission_resolved') {
          flushEvents();
          const sidForCount = targetId;
          if (sidForCount) {
            const count = pendingPermCountRef.current.get(sidForCount) || 0;
            if (count <= 1) pendingPermCountRef.current.delete(sidForCount);
            else pendingPermCountRef.current.set(sidForCount, count - 1);
          }
          setPermissionAsks((prev) => {
            const next = new Map(prev);
            for (const [mid, list] of next) {
              if (!list.some((a) => a.id === ev.id && a.status === 'pending')) continue;
              next.set(mid, list.map((a) =>
                a.id === ev.id && a.status === 'pending' ? { ...a, status: ev.status } : a));
              break;
            }
            return next;
          });
          continue;
        }
        if ((ev.type === 'done' || ev.type === 'ask') && !sawDone && !sawAsk) {
          sawDone = ev.type === 'done';
          sawAsk = ev.type === 'ask';
          if (!ctrl.signal.aborted && !document.hasFocus()) void notifyTurnEnd(ev.type).catch(() => {});
        }
        if (ev.type === 'error') sawError = true;
        if (ev.type === 'tool_start' && ev.name === 'user_steer' && targetId) {
          for (const [sidKey, entry] of inFlightSteersRef.current) {
            if (entry.sid === targetId) inFlightSteersRef.current.delete(sidKey);
          }
        }
        if (ev.type === 'steer_unconsumed' && targetId) {
          const restored: QueuedMessage[] = [];
          for (const id of ev.ids) {
            const entry = inFlightSteersRef.current.get(id);
            if (entry && entry.sid === targetId) {
              inFlightSteersRef.current.delete(id);
              restored.push(entry.item);
            }
          }
          if (restored.length) {
            setQueues((prev) => {
              const next = new Map(prev);
              next.set(targetId!, [...restored, ...(next.get(targetId!) || [])]);
              return next;
            });
          }
          continue;
        }
        if (ev.type === 'open_browser') {
          openBrowserUrl(ev.url, ev.key, ev.partition, ev.title);
          continue;
        }
        if (ev.type === 'widget' && ev.autoOpen) {
          setWidgetPanel({ block: widgetBlockFromEvent(ev), messageId: assistantMsg.id });
          setWidgetFull(false);
          setBrowserOpen(false);
          setFilePanelOpen(false);
        }
        if (ev.type === 'done') {
          setWidgetPanel((prev) => prev && prev.messageId === assistantMsg.id && prev.block.status === 'streaming'
            ? { ...prev, block: { ...prev.block, status: 'ready' } } : prev);
        }
        if (ev.type === 'widget_update') {
          setWidgetPanel((prev) => prev && prev.block.id === ev.id ? {
            ...prev,
            block: {
              ...prev.block,
              ...(ev.data !== undefined ? { data: ev.data } : {}),
              ...(ev.options !== undefined ? { options: ev.options } : {}),
              ...(ev.status !== undefined ? { status: ev.status } : {}),
            },
          } : prev);
        }
        const isHighFreqDelta = ev.type === 'text'
          || ev.type === 'reasoning'
          || ev.type === 'tool_progress'
          || (ev.type === 'subagent_event' && ev.event.type === 'text');
        eventBuf.push(ev);
        if (isHighFreqDelta) {
          if (flushTimer === null) flushTimer = setTimeout(flushEvents, 16);
        } else {
          flushEvents();
        }
        // IDE 模式：Agent 写/改/删文件 → 记变更路径，触发文件树徽标与当前标签重载。
        // 只有「正在流的会话就是当前会话」才应用，后台流的变更不能污染当前会话的文件树。
        if (ev.type === 'tool_done' && ev.ok && ['write_file', 'edit_file', 'delete_file'].includes(ev.name)
          && activeIdRef.current === targetId) {
          const start = m0tools.get(ev.id);
          if (start) {
            const p = String(start.path || '');
            if (p) {
              const isAbs = p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
              const abs = isAbs ? p : (ws ? ws.replace(/[\\/]+$/, '') + '/' + p : p);
              setChangedFiles((prev) => new Set(prev).add(abs));
              setIdeReloadTick((t) => t + 1);
            }
          }
        }
        if (ev.type === 'tool_start') m0tools.set(ev.id, ev.args || {});
      }
      flushEvents();
      // 模型正常返回 done 但正文一个字没有、工具也没调用：如实提示，别让这轮静默结束
      if (sawDone && !sawAsk && !sawError && textChars === 0 && toolCount === 0) {
        sawError = true;
        applyEvent(targetId!, { type: 'error', message: '模型没有返回任何内容，本轮已结束。可点击重试，或换个模型再试' }, assistantMsg.id);
      }
      // 流结束了但既没有 done 也没有 error/ask：服务端在发事件前就挂了
      // （请求体被拒、进程被 kill）。如实标记，别让这轮看起来“成功但空”。
      if (!sawDone && !sawAsk && !sawError) {
        applyEvent(targetId!, { type: 'error', message: '连接中断，本轮没有正常结束' }, assistantMsg.id);
        markStreamStopped(targetId!, assistantMsg.id);
      }
      // 运行记录由服务端在流结束时统一写（客户端断开也能记全），这里不再重复写
    } catch (e) {
      flushEvents();
      if ((e as Error).name === 'AbortError') {
        if (watchdogFired) {
          caughtError = true;
          setError('连接中断：超过 6 分钟没有收到任何响应，已停止本轮');
        }
        markStreamStopped(targetId!, assistantMsg.id);
      } else {
        caughtError = true;
        setError((e as Error).message);
        markStreamStopped(targetId!, assistantMsg.id); // 网络/客户端异常也别永远停在“思考中”
      }
    } finally {
      flushEvents();
      clearInterval(watchdog);
      pendingPermCountRef.current.delete(targetId!);
      setPermissionAsks((prev) => {
        const cur = prev.get(assistantMsg.id);
        if (!cur?.some((a) => a.status === 'pending')) return prev;
        const next = new Map(prev);
        next.set(assistantMsg.id, cur.map((a) => a.status === 'pending' ? { ...a, status: 'cancelled' } : a));
        return next;
      });
      if (sawError && !sawDone && !sawAsk && !ctrl.signal.aborted && !document.hasFocus()) {
        void notifyTurnEnd('error').catch(() => {});
      }
      recordDuration(targetId!, Date.now() - assistantMsg.ts, assistantMsg.id);
      if (abortMap.current.get(targetId!) === ctrl) abortMap.current.delete(targetId!);
      // 若本轮因停止/断连提前结束，仍有未收到消费确认的强行提醒，回滚回队首，绝不静默丢失
      let restoredSteers = 0;
      if (targetId) {
        const leftover: QueuedMessage[] = [];
        for (const [id, entry] of inFlightSteersRef.current) {
          if (entry.sid === targetId) {
            inFlightSteersRef.current.delete(id);
            leftover.push(entry.item);
          }
        }
        if (leftover.length) {
          restoredSteers = leftover.length;
          setQueues((prev) => {
            const next = new Map(prev);
            next.set(targetId!, [...leftover, ...(next.get(targetId!) || [])]);
            return next;
          });
        }
      }
      const wasManualStop = targetId ? manualStopRef.current.delete(targetId) : false;
      const hasQueued = targetId ? ((queuesRef.current.get(targetId)?.length ?? 0) + restoredSteers) > 0 : false;
      if (targetId && (sawDone || sawError) && !sawAsk && !wasManualStop && !ctrl.signal.aborted && hasQueued) {
        autoDrainIdsRef.current.add(targetId);
      }
      // 后台会话运行结束提示：排除用户手动停止、删除中止、以及马上要自动出队续跑的情况
      const willAutoDrain = targetId ? autoDrainIdsRef.current.has(targetId) : false;
      if (targetId && !wasManualStop && !(ctrl.signal.aborted && !watchdogFired) && !willAutoDrain) {
        const outcome: SessionFinishStatus =
          sawAsk ? 'ask' : (sawError || caughtError || !sawDone) ? 'error' : 'done';
        notifyBackgroundFinish(targetId, outcome, titleFromText(effectiveText));
      }
      setRunningIds((prev) => { const n = new Set(prev); n.delete(targetId!); return n; });
      if (targetId) dispatchingIdsRef.current.delete(targetId);
      dispatchingIdsRef.current.delete('__creating__');
      // 第二次模型调用：主对话结束后异步跑，失败/超时就留着上面的字符串兜底标题。
      // 只覆盖「还是兜底标题」的会话——用户在这期间手动改过就不动。
      if (isFirstMessage && source !== 'task' && !existingSession?.handoffFrom) {
        const fallback = titleFromText(effectiveText);
        void generateTitleApi(effectiveText, mdl).then((t) => {
          if (!t) return;
          setSessions((prev) => prev.map((s) => s.id === targetId && s.title === fallback ? { ...s, title: t } : s));
          setBgToasts((prev) => prev.map((toast) => toast.sessionId === targetId && toast.title === fallback ? { ...toast, title: t } : toast));
        });
      }
    }
  };

  /**
   * 从某条用户消息处重开：回滚它之后 AI 改过的文件 → 截断后面的消息 → 用新文本（或原文）重发。
   * 「编辑消息」和「重新生成」共用这一条路径。
   */
  const rewindTo = async (sid: string, msgId: string, newText?: string, atts?: Attachment[]) => {
    const s = sessions.find((x) => x.id === sid);
    if (!s || runningIds.has(sid)) return false;
    const idx = s.messages.findIndex((m) => m.id === msgId);
    if (idx < 0 || s.messages[idx].role !== 'user') return false;
    const msg = s.messages[idx];
    const text = (newText ?? messageText(msg)).trim();
    // 附件跟着一起重发：编辑时没动附件，就不该把它丢掉（原来写死传 []，
    // 一编辑图片就没了，2026-11-22 用户报的）
    const useAtts = atts ?? msg.attachments ?? [];
    if (!text && !useAtts.length) return false;
    const kept = s.messages.slice(0, idx);
    // 先退文件：不然新一轮是在"上一轮已经改过"的代码上继续，状态会串
    const r = await rewindFiles(sid, msg.ts);
    if (r.restored.length || r.skipped.length) {
      console.info(`[rewind] 回退文件 ${r.restored.length} 个，跳过 ${r.skipped.length} 个（已被手动改过）`);
    }
    setSessions((prev) => prev.map((x) => x.id === sid ? {
      ...x,
      messages: kept,
      updatedAt: Date.now(),
      // 编辑的正好是本会话第一条用户消息时，标题跟着改
      title: kept.some((m) => m.role === 'user') ? x.title : titleFromText(text),
    } : x));
    await dispatch(text, msg.model || model, useAtts, msg.skillIds || [], sid, undefined, undefined, kept, msg.connectionCode);
    return true;
  };

  /**
   * 回退：把对话和产物恢复到这条用户消息**之前**，同时把这条消息的正文/附件/技能
   * 放回输入框——回滚不等于丢弃，用户改完可以直接重发。
   * （2026-11-26 用户反馈：暂停后点回滚，消息既没进编辑器也没了，全丢。）
   * 跟「编辑重发」的区别：那个会带新内容继续跑，这个纯粹往回退。
   */
  const revertTo = async (sid: string, msgId: string) => {
    const s = sessions.find((x) => x.id === sid);
    if (!s || runningIds.has(sid)) return;
    const idx = s.messages.findIndex((m) => m.id === msgId);
    if (idx < 0 || s.messages[idx].role !== 'user') return;
    const msg = s.messages[idx];
    const text = messageText(msg);
    const kept = s.messages.slice(0, idx);
    const r = await rewindFiles(sid, msg.ts);
    if (r.restored.length || r.skipped.length) {
      console.info(`[revert] 回退文件 ${r.restored.length} 个，跳过 ${r.skipped.length} 个（已被手动改过）`);
    }
    setSessions((prev) => prev.map((x) => x.id === sid ? {
      ...x,
      messages: kept,
      updatedAt: Date.now(),
      title: kept.some((m) => m.role === 'user') ? x.title : 'Paw',
    } : x));
    // 内容回到输入框：已有草稿就追加，不覆盖；附件/技能去重后放回
    setInput((prev) => (prev.trim() ? `${prev}\n${text}` : text));
    if (msg.attachments?.length) addRefs(msg.attachments);
    if (msg.skillIds?.length) setSelectedSkills(msg.skillIds);
    setTimeout(() => focusRef.current?.focus(), 20);
  };

  /** 非破坏性分叉：原会话不动，新会话截断到选中消息，工作区按基线回退 */
  const forkSession = async (sid: string, msgId: string) => {
    const s = sessions.find((x) => x.id === sid);
    if (!s || runningIds.has(sid)) return;
    setError('');
    try {
      const res = await forkSessionApi(sid, msgId);
      applyImportedSessions([res.session]);
      await ensureLoaded(res.session.id);
      switchSession(res.session.id);
      setPage('chat');
      const ws = res.session.workspace ?? null;
      await setWorkspace(ws);
      setIdeRoot(ws);
      const changed = res.restored.length + res.skipped.length;
      setCompactNotice({ sid: res.session.id, text: changed
        ? `已创建分叉，工作区回退 ${res.restored.length} 个文件、跳过 ${res.skipped.length} 个手改文件`
        : '已创建分叉，原会话保持不变' });
    } catch (e) {
      setError((e as Error).message || '分叉会话失败');
    }
  };

  /**
   * ask_user 卡片提交：把答复写回 ask 块（转只读，刷新后保持），再作为下一条用户消息发出。
   * 必须写回 answer —— 否则卡片一直可编辑、并能重复提交，同一问答会被发两遍。
   */
  const answerAsk = async (sid: string, text: string) => {
    if (runningIds.has(sid)) return;
    setSessions((prev) => prev.map((s) => {
      if (s.id !== sid) return s;
      let marked = false;
      const messages = s.messages.map((m) => {
        if (marked || m.role !== 'assistant') return m;
        let hit = false;
        const content = m.content.map((b) => {
          if (b.type === 'ask' && b.answer === undefined) {
            hit = true;
            return { ...b, answer: text };
          }
          return b;
        });
        if (!hit) return m;
        marked = true;
        return { ...m, content };
      });
      return marked ? { ...s, messages, updatedAt: Date.now() } : s;
    }));
    await dispatch(text, model, [], [], sid);
  };

  // 消息分页：只渲染从 msgStart 开始的部分。
  // 长会话（那个跑崩的有 167 个工具卡片）全量渲染时，每帧流式更新都要 diff 整棵树，
  // 是白屏（Blink 堆 Fatal）的主要压力来源。
  const msgTotal = active?.messages.length ?? 0;
  const contextTurn = active ? [...active.messages].reverse().find((m) => m.role === 'user') : undefined;
  const contextLive = activeId ? contextReadings.get(activeId) : undefined;
  const autoStart = Math.max(0, msgTotal - MSG_PAGE);
  const msgStart = loadedFrom === null ? autoStart : Math.min(loadedFrom, autoStart);
  /** 往上补一批：插入内容会把正在看的位置顶走，用 scrollHeight 差值补回 scrollTop */
  const loadEarlier = () => {
    const el = bottom.ref.current;
    const before = el?.scrollHeight ?? 0;
    setLoadedFrom(Math.max(0, msgStart - MSG_PAGE));
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - before;
    });
  };

  // 从侧栏历史消息搜索跳转：若目标消息在分页窗口之前先展开窗口，再滚动定位并短暂高亮
  useEffect(() => {
    if (!jumpTarget || activeId !== jumpTarget.sessionId || !active?.messages.length) return;
    const idx = active.messages.findIndex((m) => m.id === jumpTarget.messageId);
    if (idx < 0) return;
    if (idx < msgStart) {
      setLoadedFrom(Math.max(0, idx - 2));
      return;
    }
    const targetMsgId = jumpTarget.messageId;
    const raf = requestAnimationFrame(() => {
      const container = bottom.ref.current;
      const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(targetMsgId)
        : targetMsgId.replace(/"/g, '\\"');
      const node = container?.querySelector(`[data-message-id="${escaped}"]`) as HTMLElement | null;
      if (node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        node.classList.remove('msg-jump-highlight');
        void node.offsetWidth;
        node.classList.add('msg-jump-highlight');
        setTimeout(() => node.classList.remove('msg-jump-highlight'), 1800);
      }
      setJumpTarget(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [jumpTarget, activeId, active?.messages, msgStart]);

  const compact = async (sid: string) => {
    if (!sid) {
      setCompactNotice({ sid, text: '当前会话还没有可压缩的消息' });
      return;
    }
    pendingCompactions.current.add(sid);
    setCompactingIds(new Set(pendingCompactions.current));
    setCompactNotice(null);
    setError('');
    try {
      const session = await ensureLoaded(sid);
      if (!session?.messages.length) throw new Error('当前会话没有可压缩的消息');
      const lastUser = [...session.messages].reverse().find((m) => m.role === 'user');
      const result = await compactContext(sid, model, toChatMessages(session.messages), session.workspace ?? null, lastUser?.id);
      const reading = result.reading;
      if (reading && lastUser) setContextReadings((prev) => new Map(prev).set(sid, { turnId: lastUser.id, reading }));
      if (currentSession.current === sid) {
        setCompactNotice({ sid, text: result.message });
        setInput((draft) => draft === '/compact' ? '' : draft);
      }
    } catch (err) {
      if (currentSession.current === sid) setCompactNotice({ sid, text: err instanceof Error ? err.message : String(err) });
    } finally {
      pendingCompactions.current.delete(sid);
      setCompactingIds(new Set(pendingCompactions.current));
    }
  };

  /** 会话交接：提炼双层交接单（确定性工程状态 + LLM 目标导向摘要），新建干净会话并预挂可编辑交接卡片 */
  const handoff = async (sid: string, goal?: string) => {
    if (!sid) {
      setCompactNotice({ sid, text: '当前会话还没有可交接的消息' });
      return;
    }
    if (runningIds.has(sid) || pendingCompactions.current.has(sid)) return;
    pendingCompactions.current.add(sid);
    setHandoffBusyIds((prev) => new Set(prev).add(sid));
    setCompactNotice(null);
    setError('');
    try {
      const session = await ensureLoaded(sid);
      if (!session?.messages.length) throw new Error('当前会话没有可交接的消息');
      const res = await createHandoff({
        sessionId: sid,
        title: session.title,
        model,
        messages: toChatMessages(session.messages),
        viewMessages: session.messages,
        goal: goal?.trim() || undefined,
        workspace: session.workspace ?? null,
      });
      const ws = res.inherited.workspace ?? session.workspace ?? null;
      const newSid = createSession({
        title: res.suggestedTitle,
        workspace: ws || undefined,
        handoffFrom: { sessionId: sid, title: session.title },
        permission: { mode: draftPermissionModeRef.current, allow: [...globalAllowRef.current], deny: [] },
      });
      // 在源会话上写入前向跳转锚点，方便后续来回溯源
      setSessions((prev) => prev.map((s) => s.id === sid ? {
        ...s,
        handoffTo: { sessionId: newSid, title: res.suggestedTitle },
      } : s));
      setHandoffDrafts((prev) => new Map(prev).set(newSid, res.handoff));
      if (res.inherited.model && models.some((m) => m.id === res.inherited.model)) {
        setModel(res.inherited.model);
        sessionModelsRef.current.set(newSid, res.inherited.model);
      }
      setSelectedSkills(res.inherited.skillIds || []);
      setSelectedConnection(res.inherited.connectionCode || null);
      void setWorkspace(ws);
      setIdeRoot(ws);
      switchSession(newSid);
      setPage('chat');
      const nextDraft = goal?.trim() || '';
      inputRef.current = nextDraft;
      setInput(nextDraft);
      clearFiles();
      setCompactNotice({ sid: newSid, text: `已从「${session.title}」生成交接单，确认或修改后发送首条消息即可继续` });
      setTimeout(() => focusRef.current?.focus(), 60);
    } catch (err) {
      if (currentSession.current === sid) setCompactNotice({ sid, text: err instanceof Error ? err.message : String(err) });
    } finally {
      pendingCompactions.current.delete(sid);
      setHandoffBusyIds((prev) => { const n = new Set(prev); n.delete(sid); return n; });
    }
  };

  /** 跳转到关联会话（交接源 / 交接目标），内存没有时自动从 SQLite 按需拉取 */
  const openLinkedSession = async (targetSid: string) => {
    if (!targetSid) return;
    if (!sessions.some((s) => s.id === targetSid)) {
      const full = await getSession(targetSid).catch(() => null);
      if (!full) { setError('目标会话不存在或已被删除'); return; }
      setSessions((prev) => [full, ...prev]);
    }
    switchSession(targetSid);
    setPage('chat');
    void ensureLoaded(targetSid);
  };

  const runBtw = async (question: string) => {
    const q = question.trim();
    if (!q) return;
    btwAbortRef.current?.abort();
    const ctrl = new AbortController();
    btwAbortRef.current = ctrl;
    setBtwState({ question: q, answer: '', streaming: true });
    try {
      const rawMessages = active?.messages ?? [];
      // 若主会话正在流式执行，最后一条未完成的 assistant 消息可能带半截 tool-call，跳过它避免结构非法
      const completedMessages = activeId && runningIds.has(activeId) && rawMessages.at(-1)?.role === 'assistant'
        ? rawMessages.slice(0, -1)
        : rawMessages;
      const historyMsgs = toChatMessages(completedMessages.slice(-12));
      if (historyMsgs.at(-1)?.role === 'user') {
        historyMsgs.push({ role: 'assistant', content: '（当前主任务正在执行中）' });
      }
      const payload = [...historyMsgs, { role: 'user' as const, content: q }];
      for await (const ev of streamBtw(payload, {
        model: model || undefined,
        workspace: active?.workspace ?? null,
        signal: ctrl.signal,
      })) {
        if (ctrl.signal.aborted) break;
        if (ev.type === 'text') {
          setBtwState((prev) => prev ? { ...prev, answer: prev.answer + ev.delta } : prev);
        } else if (ev.type === 'error') {
          setBtwState((prev) => prev ? { ...prev, error: ev.message, streaming: false } : prev);
        }
      }
      setBtwState((prev) => prev ? { ...prev, streaming: false } : prev);
    } catch (e) {
      if (ctrl.signal.aborted) {
        setBtwState((prev) => prev ? { ...prev, streaming: false } : prev);
      } else {
        setBtwState((prev) => prev ? { ...prev, error: (e as Error).message, streaming: false } : prev);
      }
    } finally {
      if (btwAbortRef.current === ctrl) btwAbortRef.current = null;
    }
  };

  const handleExportSession = (sid: string) => {
    const a = document.createElement('a');
    a.href = exportSessionUrl(sid);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleImportSessions = async (file: File) => {
    setError('');
    try {
      const text = await file.text();
      const res = await importSessionsApi(text);
      applyImportedSessions(res.imported);
      if (res.imported.length) {
        setCompactNotice({ sid: currentSession.current, text: `已导入 ${res.imported.length} 个会话` });
      }
    } catch (e) {
      setError((e as Error).message || '导入会话失败');
    }
  };

  const handleSetPermissionMode = async (sid: string, mode: SessionPermission['mode']) => {
    const s = sessions.find((x) => x.id === sid);
    if (!s || s.permission?.mode === mode) return;
    const nextPerm: SessionPermission = {
      mode,
      allow: s.permission?.allow ?? [],
      deny: s.permission?.deny ?? [],
    };
    try {
      const r = await updateSessionPermissionApi(sid, nextPerm);
      if (r.ok && r.permission) {
        syncSessionPermission(sid, r.permission);
        return;
      }
      // 新建会话尚未经过 800ms 防抖落库时服务端尚无行：直接改本地状态，随首次防抖一并落库
      if (r.error === '会话不存在') {
        setSessions((prev) => prev.map((x) => x.id === sid ? { ...x, permission: nextPerm } : x));
        return;
      }
      throw new Error(r.error || '更新权限失败');
    } catch (e) {
      setError((e as Error).message || '更新权限失败');
    }
  };

  /** 批准只读计划：先切回默认权限，再用一句确认让模型接着上一条计划执行，不重复拷贝正文 */
  const handleApprovePlan = async (sid: string) => {
    const s = sessions.find((x) => x.id === sid);
    if (!s || runningIds.has(sid) || s.permission?.mode !== 'plan') return;
    const nextPerm: SessionPermission = {
      mode: 'default',
      allow: s.permission?.allow ?? [],
      deny: s.permission?.deny ?? [],
    };
    try {
      const r = await updateSessionPermissionApi(sid, nextPerm);
      if (!r.ok && r.error !== '会话不存在') throw new Error(r.error || '切换模式失败');
      const applied = r.permission ?? nextPerm;
      syncSessionPermission(sid, applied);
      void dispatch('已批准上述计划，请按计划开始执行', model, [], [], sid, undefined, undefined, undefined, undefined, undefined, applied);
    } catch (e) {
      setError((e as Error).message || '批准计划失败');
    }
  };

  const handleAllowGlobal = async () => {
    const ask = globalAllowAsk;
    if (!ask) return;
    setGlobalAllowAsk(null);
    setError('');
    try {
      const res = await putGlobalPermissions([...new Set([...globalAllowRef.current, ask.tool])]);
      if (!res.ok) throw new Error('保存全局许可失败');
      setGlobalAllow(res.allow);
      // 同步放行当前挂起的审批卡，既立刻唤醒服务端 authorizer，又把该工具加入本会话 allow 并更新卡片状态
      await handleDecidePermission(ask.id, 'allow_session');
    } catch (e) {
      setError((e as Error).message || '设置全局许可失败');
    }
  };

  const handleRemoveGlobal = async (tool: string) => {
    const res = await putGlobalPermissions(globalAllowRef.current.filter((t) => t !== tool));
    if (res.ok) setGlobalAllow(res.allow);
    else setError('移除全局许可失败');
  };

  const handleDecidePermission = async (askId: string, decision: PermissionDecision) => {
    let target: PermissionAskItem | undefined;
    for (const list of permissionAsksRef.current.values()) {
      const hit = list.find((a) => a.id === askId && a.status === 'pending');
      if (hit) { target = hit; break; }
    }
    if (!target) return;
    const status = decision === 'allow_once' || decision === 'allow_session' ? 'allowed' : 'denied';
    setPermissionAsks((prev) => {
      const cur = prev.get(target!.messageId);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(target!.messageId, cur.map((a) => a.id === askId ? { ...a, status, decision } : a));
      return next;
    });
    const curCount = pendingPermCountRef.current.get(target.sessionId) || 0;
    if (curCount <= 1) pendingPermCountRef.current.delete(target.sessionId);
    else pendingPermCountRef.current.set(target.sessionId, curCount - 1);
    await approvePermissionApi(target.sessionId, askId, decision).catch(() => {});
  };

  const handleOpenTrace = async (sid: string, turnId: string) => {
    setTraceView({ trace: null, loading: true });
    try {
      const traces = await getTurnTracesApi(sid);
      const hit = traces.find((t) => t.turnId === turnId) ?? null;
      setTraceView({ trace: hit, loading: false });
    } catch {
      setTraceView({ trace: null, loading: false });
    }
  };

  /** Enter 直接使用编辑器提交的最新文本。 */
  const send = (override?: string) => {
    const rawText = (override ?? input).trim();
    // /btw 只读旁路问答：主会话忙碌时也允许直接并行提问，绝不入队、不进主对话
    const isBtwCmd = !attachments.length && (rawText === '/btw' || rawText.startsWith('/btw '));
    if (isBtwCmd || (btwMode && !attachments.length && rawText)) {
      const q = isBtwCmd ? rawText.slice('/btw'.length).trim() : rawText;
      if (!q) {
        setBtwMode((v) => !v);
        setInput('');
        inputRef.current = '';
        return;
      }
      setInput('');
      inputRef.current = '';
      void runBtw(q);
      focusRef.current?.focus();
      return;
    }
    // 粘贴场景：文本里可能带 @skill:xxx（从 Paw 另一个对话复制来的），解析成真正技能
    const parsed = extractSkillRefs(rawText);
    const text = parsed.text;
    const skills = [...new Set([...selectedSkills, ...parsed.skillIds])];
    const activeDraft = activeId ? handoffDrafts.get(activeId) : undefined;
    if (readingFiles || (!text && !attachments.length && !activeDraft)) return;
    const isExisting = !!activeId && sessions.some((s) => s.id === activeId);
    const lockKey = isExisting ? activeId : '__creating__';
    if (pendingCompactions.current.has(activeId)) return;
    const isSlashCmd = !attachments.length && (rawText === '/compact' || rawText === '/handoff' || rawText.startsWith('/handoff '));
    // 会话正在进行中：普通消息排入队列（斜杠命令不入队，避免当普通文本发给模型）
    if (isExisting && (runningIds.has(activeId) || dispatchingIdsRef.current.has(activeId))) {
      if (isSlashCmd) return;
      const item: QueuedMessage = {
        id: uid(),
        text,
        attachments: attachments,
        skillIds: skills,
        connectionCode: selectedConnection || undefined,
        handoff: activeDraft,
        model,
        createdAt: Date.now(),
      };
      if (activeDraft) {
        setHandoffDrafts((prev) => { const n = new Map(prev); n.delete(activeId); return n; });
      }
      setQueues((prev) => {
        const next = new Map(prev);
        next.set(activeId, [...(next.get(activeId) || []), item]);
        return next;
      });
      setInput('');
      inputRef.current = ''; // 同 tick 内可能的 switchSession 依赖它，避免把已发送内容误存成草稿
      clearFiles();
      setSelectedSkills([]);
      focusRef.current?.focus();
      return;
    }
    if (dispatchingIdsRef.current.has(lockKey)) return; // 仅挡住新会话创建瞬间的双击重入
    if (rawText === '/compact' && !attachments.length) {
      void compact(activeId);
      return;
    }
    if ((rawText === '/handoff' || rawText.startsWith('/handoff ')) && !attachments.length) {
      const goal = rawText.slice('/handoff'.length).trim();
      void handoff(activeId, goal || undefined);
      return;
    }
    setCompactNotice(null);
    const sentAttachments = attachments;
    if (activeDraft && activeId) {
      setHandoffDrafts((prev) => { const n = new Map(prev); n.delete(activeId); return n; });
    }
    // 先同步清空输入框（否则要等模型整段生成完才清，草稿卡在框里）
    setInput('');
    inputRef.current = ''; // dispatch 里马上会 switchSession，必须同步清，否则已发送内容被误存成旧会话草稿
    clearFiles();
    setSelectedSkills([]);
    debugLog(`SEND content="${text.slice(0, 120)}" atts=[${sentAttachments.map((a) => a.name).join(', ')}]`);
    void dispatch(text, model, sentAttachments, skills, activeId, undefined, undefined, undefined, selectedConnection || undefined, activeDraft);
  };
  widgetSendRef.current = send;

  /** 队列操作：从当前会话队列中取出并删除指定项 */
  const popQueuedItem = (sid: string, id: string): QueuedMessage | undefined => {
    const list = queuesRef.current.get(sid);
    const target = list?.find((x) => x.id === id);
    if (!target) return undefined;
    setQueues((prev) => {
      const next = new Map(prev);
      const rest = (next.get(sid) || []).filter((x) => x.id !== id);
      if (rest.length) next.set(sid, rest);
      else next.delete(sid);
      return next;
    });
    return target;
  };

  /** 强行提醒模型：一律先请求服务端注入（避免前端 runningIds 闭包滞后导致并发写同一会话）；若服务端确认本轮已结束再直接发送 */
  const steerQueued = async (id: string) => {
    if (!activeId) return;
    const sid = activeId;
    const item = popQueuedItem(sid, id);
    if (!item) return;
    inFlightSteersRef.current.set(item.id, { sid, item });
    const res = await steerChat(sid, {
      id: item.id,
      text: item.text,
      attachments: item.attachments,
      skillIds: item.skillIds,
    }).catch(() => ({ ok: false, injected: false }));
    if (res.injected) return;
    inFlightSteersRef.current.delete(item.id);
    // 服务端确认当前无运行中轮次：直接正常发送
    void dispatch(item.text, item.model, item.attachments, item.skillIds, sid, undefined, undefined, undefined, item.connectionCode, item.handoff);
  };

  /** 从队列点编辑：移出队列并回填回输入框；编辑完再发送会自然排到队尾 */
  const editQueued = (id: string) => {
    if (!activeId) return;
    const item = popQueuedItem(activeId, id);
    if (!item) return;
    setInput(item.text);
    setFiles(item.attachments);
    setSelectedSkills(item.skillIds);
    setSelectedConnection(item.connectionCode ?? null);
    if (item.handoff) {
      setHandoffDrafts((prev) => new Map(prev).set(activeId, item.handoff!));
    }
    setTimeout(() => focusRef.current?.focus(), 0);
  };

  /** 从队列删除 */
  const deleteQueued = (id: string) => {
    if (!activeId) return;
    popQueuedItem(activeId, id);
  };

  // 本轮结束后，自动从该会话队列取出队首第一条继续发送（在 React 提交最新 sessions 后触发，避免陈旧闭包）
  useEffect(() => {
    if (autoDrainIdsRef.current.size === 0) return;
    for (const sid of [...autoDrainIdsRef.current]) {
      if (runningIds.has(sid) || dispatchingIdsRef.current.has(sid)) continue;
      autoDrainIdsRef.current.delete(sid);
      const list = queuesRef.current.get(sid);
      if (!list?.length) continue;
      const [head, ...rest] = list;
      setQueues((prev) => {
        const next = new Map(prev);
        if (rest.length) next.set(sid, rest);
        else next.delete(sid);
        return next;
      });
      void dispatch(head.text, head.model, head.attachments, head.skillIds, sid, undefined, undefined, undefined, head.connectionCode, head.handoff);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningIds, queues, sessions]);

  /** 定时任务"立即运行"：关面板、切回聊天、开新对话执行任务（能看到 MCP 等工具调用） */
  const runTaskInChat = (task: ScheduledTask) => {
    setTaskPanel(false);
    setPage('chat');
    nextWorkspaceRef.current = { value: null };
    void dispatch(task.prompt, task.model, [], task.skillIds || [], undefined, 'task', task.id); // 新建会话并标记来源
  };

  const stop = () => {
    if (!activeId) return;
    const ctrl = abortMap.current.get(activeId);
    if (!ctrl) return;
    manualStopRef.current.add(activeId);
    autoDrainIdsRef.current.delete(activeId);
    abortMap.current.delete(activeId);
    setRunningIds((prev) => { const n = new Set(prev); n.delete(activeId); return n; });
    markStreamStopped(activeId); // 立即解除“生成中”，不依赖流是否及时抛 AbortError
    ctrl.abort();
  };

  /** 部件 Bridge 的宿主侧实现：回调稳定，避免长会话里每次 render 都重渲染所有消息 */
  const widgetHost = useMemo<WidgetHostApi>(() => ({
    widgets: widgetSpecs,
    sessionId: activeId || undefined,
    onSendMessage: (text) => widgetSendRef.current(text),
    onSaveState: (blockId, state) => {
      setSessions((prev) => {
        let changed = false;
        const next = prev.map((s) => {
          let sChanged = false;
          const messages = s.messages.map((m) => {
            if (!m.content.some((b) => b.type === 'widget' && b.id === blockId)) return m;
            sChanged = true;
            return { ...m, content: m.content.map((b) => b.type === 'widget' && b.id === blockId ? { ...b, state } : b) };
          });
          if (!sChanged) return s;
          changed = true;
          return { ...s, messages };
        });
        return changed ? next : prev;
      });
      setWidgetPanel((prev) => prev && prev.block.id === blockId ? { ...prev, block: { ...prev.block, state } } : prev);
    },
    onOpenPanel: (block, messageId) => {
      setWidgetPanel({ block, messageId });
      setWidgetFull(false);
      setBrowserOpen(false);
      setFilePanelOpen(false);
    },
    onClosePanel: () => setWidgetPanel(null),
    onOpenBusinessPage: (block, payload) => {
      const code = block.connectionCode || widgetSpecs.find((w) => w.key === block.widgetId)?.defaultConnection;
      if (!code) { setError('该部件未绑定系统连接，无法打开业务页面'); return; }
      void resolveBusinessPage(code, { path: payload.path, query: payload.query, title: payload.title })
        .then((r) => {
          openBrowserUrl(r.url, `widget:${block.id}:${payload.path || ''}`, r.partition, r.title || payload.title);
          if (payload.mode === 'modal') setBrowserModal(true);
        })
        .catch((e) => setError((e as Error).message));
    },
  }), [widgetSpecs, activeId, openBrowserUrl, setSessions]);

  /** 打开子代理会话：记住来源页，返回时不用在左侧列表里翻 */
  const subagentReturnRef = useRef<Map<string, string>>(new Map());
  const openSubagentSession = async (id: string, parentId?: string) => {
    if (parentId) subagentReturnRef.current.set(id, parentId);
    if (!sessions.some((s) => s.id === id)) {
      const full = await getSession(id).catch(() => null);
      if (!full) { setError('子会话不存在或已被清理'); return; }
      setSessions((prev) => [full, ...prev]);
    }
    switchSession(id);
    setPage('chat');
    void ensureLoaded(id);
  };

  /** 从子代理会话返回来源主会话 */
  const returnFromSubagent = async () => {
    const id = active?.parentId || (active ? subagentReturnRef.current.get(active.id) : undefined);
    if (!id) return;
    if (!sessions.some((s) => s.id === id)) {
      const full = await getSession(id).catch(() => null);
      if (!full) { setError('主会话不存在或已被清理'); return; }
      setSessions((prev) => [full, ...prev]);
    }
    switchSession(id);
    setPage('chat');
    void ensureLoaded(id);
  };

  /** 粘贴里带了 @skill:xxx（从别的对话复制来的）→ 转成已选技能。
   *  文本本身由编辑器插入，这里只管技能开关。 */
  const onSkillPaste = (ids: string[]) => {
    setSelectedSkills((prev) => [...new Set([...prev, ...ids])]);
  };

  const selectSession = (id: string, messageId?: string) => {
    const s = sessionsRef.current.find((x) => x.id === id);
    nextWorkspaceRef.current = null;
    switchSession(id);
    setPage('chat');
    clearSessionUnread(id);
    if (s) void setWorkspace(s.workspace ?? null); // 续聊沿用会话自己的工作区
    if (messageId) {
      setJumpTarget({ sessionId: id, messageId, seq: Date.now() });
      void ensureLoaded(id);
    } else {
      setJumpTarget(null);
    }
  };

  return (
    <div className="app">
      <Sidebar
        sessions={sessions} activeId={activeId} runningIds={runningIds} unreadFinished={unreadFinished} provider={provider} hasKey={hasKey} providerMenu={providerMenu}
        onNew={onNew}
        onSelect={selectSession}
        onNewInWorkspace={onNewInWorkspace}
        onDelete={(id) => {
          // 删除正在流式的会话先掐掉流：否则模型在后台把整轮跑完，白烧 token
          const ctrl = abortMap.current.get(id);
          if (ctrl) { ctrl.abort(); abortMap.current.delete(id); }
          draftsRef.current.delete(id);
          sessionModelsRef.current.delete(id);
          clearSessionUnread(id);
          if (currentSession.current === id) {
            currentSession.current = '';
            if (inputRef.current) { inputRef.current = ''; setInput(''); }
          }
          deleteSession(id);
        }}
        onHandoffSession={(id) => void handoff(id)}
        onExportSession={handleExportSession}
        onImportSessions={(file) => void handleImportSessions(file)}
        onSetPermissionMode={(id, mode) => void handleSetPermissionMode(id, mode)}
        onProviderToggle={() => setProviderMenu((v) => !v)} onProviderClose={() => setProviderMenu(false)} onProviderSwitch={(p) => void switchProvider(p)}
        onTasks={() => { setTasksTab('tasks'); setPage('tasks'); }}
        onMemory={() => setPage('memory')}
        onRemoveWorkspace={(root) => void removeWorkspaceFromList(root)}
        page={page} onPage={(p, tab) => {
          if (p === 'tools' && tab) setToolsTab(tab);
          setPage(p);
        }}
        collapsed={sideCollapsed} onToggleCollapse={toggleSide} ideMode={mode === 'ide'}
        toolsTab={toolsTab}
        pluginPages={pluginPages}
        activePluginPageKey={activePluginPageKey}
        onOpenPluginPage={(key) => {
          if (page === 'plugin' && activePluginPageKey === key) {
            setPage('chat');
          } else {
            setActivePluginPageKey(key);
            setPage('plugin');
          }
        }}
      />
      <main className="main">
        {page === 'plugin' && activePluginPage ? <PluginPageView page={activePluginPage} /> :
         page === 'tools' ? <ToolsPage key={toolsTab} initialTab={toolsTab} globalAllow={globalAllow} onRemoveGlobal={(tool) => void handleRemoveGlobal(tool)} /> :
         page === 'tasks' ? <TasksPage key={tasksTab} initialTab={tasksTab} onRunInChat={runTaskInChat}
           onOpenSession={(r: TaskRunWithName) => {
             const s = sessions.find((x) => x.runId === r.id);
             if (s) { switchSession(s.id); setPage('chat'); }
           }} /> :
         page === 'memory' ? <MemoryPage /> : (
        <div className={'chat-layout' + (mode === 'ide' ? ' ide-mode' : (sideCollapsed ? ' side-collapsed' : '')) + (mode === 'ide' && chatMax ? ' chat-max' : '') + (mode === 'ide' && chatHidden ? ' chat-hidden' : '')} ref={layoutRef}>
        {mode === 'ide' && (
          ideRoot
            ? <IdePanel root={ideRoot} changedPaths={changedFiles} reloadTick={ideReloadTick}
                chatHidden={chatHidden} onToggleChat={toggleChat}
                onAddRef={(a) => { addRefs([a]); focusRef.current?.focus(); }} />
            : <div className="ide-no-ws">
                <p>IDE 模式需要先选一个工作区</p>
                <small>点下面的「工作区」选一个目录，左边会打开它的文件树</small>
                <WorkspacePicker variant="chip" />
              </div>
        )}
        {mode === 'ide' && !chatMax && (
          <div className="col-resizer chat-resizer" title="拖动调整对话区宽度（双击还原）" {...chatResize} />
        )}
        <div className="chat-col" ref={chatColRef} style={mode === 'ide' && !chatMax ? { flexBasis: chatWidth } : undefined}>
        <header className="topbar">
          <Tips label={sideCollapsed ? '展开侧栏' : '收起侧栏'}>
            <button className="topbar-icon topbar-side-toggle" aria-label={sideCollapsed ? '展开侧栏' : '收起侧栏'}
              onClick={toggleSide}>
              {sideCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
          </Tips>
          {(active?.source === 'subagent' || active?.parentId) && (
            <button className="topbar-back" title="返回主会话" onClick={() => void returnFromSubagent()}>
              <ArrowLeft size={13} /> 返回主会话
            </button>
          )}
          {active?.handoffFrom && active.source !== 'subagent' && (
            <button className="topbar-back" title={`跳回原会话：${active.handoffFrom.title}`}
              onClick={() => void openLinkedSession(active.handoffFrom!.sessionId)}>
              <ArrowLeft size={13} /> 承接自：{active.handoffFrom.title.slice(0, 12)}
            </button>
          )}
          {titleEditing ? (
            <>
              <input className="top-title-input" value={titleDraft} autoFocus maxLength={24}
                aria-label="会话标题" onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') cancelTitleEdit();
                }} />
              {/* onMouseDown preventDefault：点按钮时别让 input 失焦，否则会先提交退出编辑态 */}
              <Tips label={titleGenerating ? '正在生成…' : '让模型重新起个标题'}>
                <button className="topbar-icon" aria-label="重新生成标题" disabled={titleGenerating}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { void regenerateTitle(); }}>
                  <Sparkles size={15} />
                </button>
              </Tips>
            </>
          ) : (
            <button className="top-title" title="点击重命名会话" onClick={beginTitleEdit}>
              {active?.title || 'Paw'}
            </button>
          )}
          {active?.source === 'task' && (
            <span className="top-badge" title="这是定时任务自动运行时留下的会话，标题就是任务名">定时任务</span>
          )}
          {(active?.source === 'subagent' || active?.parentId) && (
            <span className="top-badge subagent-badge" title="这是子代理会话，完整过程不会显示在左侧列表">子代理</span>
          )}
          {active?.permission?.mode === 'plan' && (
            <button className="top-badge plan-badge" title="只读计划模式：点击退出并回到默认模式"
              onClick={() => void handleSetPermissionMode(active.id, 'default')}>
              <Eye size={12} /> 只读计划
            </button>
          )}
          {!active && <span className="top-sub">你的本地全能 AI 助手</span>}
          <BackgroundTasks />
          {/* 模式切换：右上角胶囊下拉（Gemini/Antigravity 同款），不再放在侧栏工作区行上 */}
          <div className="topbar-mode">
            <ModeMenu mode={mode} onChange={changeMode} down end />
          </div>
          {active && active.messages.length > 0 && active.source !== 'subagent' && (
            <Tips label="提炼交接单并开启新会话（/handoff）">
              <button
                className="topbar-icon"
                aria-label="交接到新会话"
                disabled={runningIds.has(active.id) || compactingIds.has(active.id) || handoffBusyIds.has(active.id)}
                onClick={() => void handoff(active.id)}
              >
                <ArrowRightLeft size={15} />
              </button>
            </Tips>
          )}
          <Tips label={browserOpen ? '关闭内置浏览器' : '打开内置浏览器'}>
            <button className={'topbar-icon' + (browserOpen ? ' active' : '')} aria-label="内置浏览器"
              onClick={() => setBrowserOpen((v) => !v)}>
              <Globe size={15} />
            </button>
          </Tips>
          {mode !== 'ide' && (
            <Tips label={filePanelOpen ? '关闭文件预览' : '打开文件预览'}>
              <button className={'topbar-icon' + (filePanelOpen ? ' active' : '')} aria-label="文件预览"
                onClick={() => { setFilePanelOpen((v) => !v); setBrowserOpen(false); }}>
                <Eye size={15} />
              </button>
            </Tips>
          )}
          {mode === 'ide' && (
            <Tips label={chatMax ? '还原对话区' : '对话区全屏（盖住代码区）'}>
              <button className={'topbar-icon' + (chatMax ? ' active' : '')} aria-label={chatMax ? '还原对话区' : '对话区全屏'}
                onClick={() => setChatMax((v) => !v)}>
                {chatMax ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            </Tips>
          )}
        </header>
        <div className="messages-wrap">
          <div className="messages" ref={bottom.ref} onScroll={bottom.onScroll}
            onDragOver={(e) => { if (hasDroppedFiles(e.dataTransfer)) e.preventDefault(); }}
            onDrop={(e) => {
              if (!hasDroppedFiles(e.dataTransfer)) return;
              e.preventDefault();
              void filesFromDataTransfer(e.dataTransfer).then((files) => { if (files.length) void addFiles(files); });
            }}>
            {!active || active.messages.length === 0 ? (
              <div className="empty">
                <div className="empty-badge" aria-hidden="true"><span>🐾</span></div>
                <h1>{active?.handoffFrom ? `继续推进「${active.title}」` : '嗨，我是 Paw'}</h1>
                <p>
                  {active?.handoffFrom
                    ? '交接单已准备就绪，在下方检视或补充你的下一步指令即可无缝继续。'
                    : '读代码、查资料、跑命令、调接口与管理长任务——随时吩咐。'}
                </p>
                {!active?.handoffFrom && (
                  <div className="empty-prompts">
                    {[
                      { title: '梳理项目结构', desc: '快速定位核心模块与调用链路', text: '帮我梳理当前工作区的项目目录结构和核心代码入口' },
                      { title: '排查代码或报错', desc: '定位根因并给出最小修复方案', text: '帮我分析下面这段报错的原因并给出修复建议：\n' },
                      { title: '联网调研对比', desc: '检索最新资料并附可核对来源', text: '帮我上网调研并对比以下方案的优缺点：' },
                      { title: '整理今日日志', desc: '汇总近期工作进展与待办事项', text: '帮我查看最近的工作日志和记忆，整理一份今日进展摘要' },
                    ].map((p) => (
                      <button
                        key={p.title}
                        type="button"
                        className="empty-prompt-card"
                        onClick={() => { setInput(p.text); setTimeout(() => focusRef.current?.focus(), 20); }}
                      >
                        <strong>{p.title}</strong>
                        <span>{p.desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                {msgStart > 0 && (
                  <button className="load-earlier" onClick={loadEarlier}>
                    <ChevronUp size={13} /> 显示更早的 {msgStart} 条消息
                  </button>
                )}
                {active.messages.slice(msgStart).map((m, i) => {
                  const gi = msgStart + i; // 在全量列表里的下标（streaming 判断要用）
                  const turnUserMsg = m.role === 'assistant' && gi > 0 && active.messages[gi - 1]?.role === 'user'
                    ? active.messages[gi - 1]
                    : undefined;
                  return <MessageRow key={m.id} m={m} fallbackModel={model}
                    streaming={runningIds.has(activeId) && gi === msgTotal - 1 && m.role === 'assistant'}
                    workspace={active.workspace ?? ideRoot ?? null}
                    onOpenSession={(id) => void openSubagentSession(id, active.id)}
                    onPreviewAttachment={(a) => {
                      setBrowserOpen(false);
                      setFilePanelOpen(true);
                      setPreviewRequest({ id: Date.now(), attachment: a });
                    }}
                    onPreviewFile={(path) => {
                      setBrowserOpen(false);
                      setFilePanelOpen(true);
                      setPreviewRequest({ id: Date.now(), path });
                    }}
                    onOpenFilePanel={() => {
                      setBrowserOpen(false);
                      setFilePanelOpen(true);
                    }}
                    onRewind={runningIds.has(active.id) ? undefined : (text, atts) => rewindTo(active.id, m.id, text, atts)}
                    onRevert={() => setRevertAsk({ sid: active.id, msgId: m.id })}
                    onFork={!runningIds.has(active.id) && !active.parentId && active.source !== 'subagent' ? () => setForkAsk({ sid: active.id, msgId: m.id }) : undefined}
                    onAnswerAsk={(text) => void answerAsk(active.id, text)}
                    permissionAsks={permissionAsks.get(m.id)}
                    onDecidePermission={(id, dec) => void handleDecidePermission(id, dec)}
                    onAllowGlobal={(ask) => setGlobalAllowAsk(ask)}
                    onOpenTrace={turnUserMsg ? () => void handleOpenTrace(active.id, turnUserMsg.id) : undefined}
                    planApproval={active.permission?.mode === 'plan' && gi === msgTotal - 1 && !runningIds.has(active.id) && !m.error}
                    onApprovePlan={() => void handleApprovePlan(active.id)}
                    widgetHost={widgetHost} />;
                })}
                {active.handoffTo && (
                  <div className="handoff-to-banner">
                    <span>已交接至新会话「{active.handoffTo.title}」</span>
                    <button type="button" onClick={() => void openLinkedSession(active.handoffTo!.sessionId)}>
                      前往继续 <ArrowRight size={12} />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          {bottom.away && (
            <button className="scroll-bottom-btn" onClick={bottom.toBottom} title="回到最新消息并恢复自动跟随">
              <ArrowDown size={13} /> 回到底部
            </button>
          )}
        </div>
        {error && <div className="error-bar">⚠️ {error}</div>}
        {compactingIds.has(activeId) || handoffBusyIds.has(activeId) || compactNotice?.sid === activeId ? (
          <div className="compact-notice" role="status">
            {handoffBusyIds.has(activeId) ? '正在提炼会话交接单…' : compactingIds.has(activeId) ? '正在压缩上下文…' : compactNotice?.text}
          </div>
        ) : null}
        <Composer
          compacting={compactingIds.has(activeId) || handoffBusyIds.has(activeId)}
          contextSessionId={activeId} contextTurn={contextTurn} contextMessages={active?.messages ?? []} contextReading={contextLive && contextLive.turnId === contextTurn?.id ? contextLive.reading : undefined}
          handoffDraft={activeId ? (handoffDrafts.get(activeId) ?? null) : null}
          onUpdateHandoffDraft={(summary) => {
            if (!activeId) return;
            setHandoffDrafts((prev) => {
              const cur = prev.get(activeId);
              if (!cur) return prev;
              return new Map(prev).set(activeId, { ...cur, summary });
            });
          }}
          onClearHandoffDraft={() => {
            if (!activeId) return;
            setHandoffDrafts((prev) => { const n = new Map(prev); n.delete(activeId); return n; });
          }}
          onOpenHandoffSource={(sid) => void openLinkedSession(sid)}
          onCompact={() => void compact(activeId)}
          onHandoff={() => void handoff(activeId)}
          btwMode={btwMode}
          onToggleBtw={() => setBtwMode((v) => !v)}
          btwState={btwState}
          onStopBtw={() => { btwAbortRef.current?.abort(); }}
          onCloseBtw={() => { btwAbortRef.current?.abort(); setBtwState(null); }}
          input={input} attachments={attachments} readingFiles={readingFiles} busy={runningIds.has(activeId)} model={model} models={models}
          modelMenu={modelMenu} modelSearch={modelSearch} modelsRefreshing={modelsRefreshing}
          selectedSkills={selectedSkills} focusRef={focusRef}
          permissionMode={active?.permission?.mode ?? draftPermissionMode}
          onSetPermissionMode={(mode) => {
            if (activeId) void handleSetPermissionMode(activeId, mode);
            else setDraftPermissionMode(mode);
          }}
          selectedConnection={selectedConnection} onSelectConnection={setSelectedConnection}
          onInput={setInput}
          onSkillPaste={onSkillPaste}
          onRestoreAttachment={(a) => addRefs([a])}
          onAddFiles={(files) => void addFiles(files)}
          onRemoveFile={removeFile}
          onToggleSkill={(id) => setSelectedSkills((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])}
          onClearSkills={() => setSelectedSkills([])}
          onToggleModel={toggleModelMenu}
          onCloseModel={() => setModelMenu(false)}
          onModelSearch={setModelSearch}
          onSelectModel={(id) => {
            modelRef.current = id;
            setModel(id);
            // 模型选择按会话记忆：切回该会话时恢复，不把别的会话的选择带过来
            if (currentSession.current) sessionModelsRef.current.set(currentSession.current, id);
            setModelMenu(false); setModelSearch('');
          }}
          queuedMessages={activeId ? (queues.get(activeId) || []) : []}
          onSteerQueued={(id) => void steerQueued(id)}
          onEditQueued={editQueued}
          onDeleteQueued={deleteQueued}
          onSend={send} onStop={stop}
        />
        </div>
        {widgetPanel && !browserOpen && (
          <>
            {!widgetFull && (
              <div className="col-resizer browser-resizer" title="拖动调整部件面板宽度（双击还原）" {...widgetResize} />
            )}
            <WidgetPanel block={widgetPanel.block} messageId={widgetPanel.messageId} host={widgetHost} width={widgetWidth} full={widgetFull}
              onToggleFull={() => setWidgetFull((v) => !v)} onClose={() => setWidgetPanel(null)} />
          </>
        )}
        {browserOpen && browserModal ? (
          <div className="widget-page-modal">
            <BrowserPanel request={browserRequest} width={900} onClose={() => { setBrowserOpen(false); setBrowserModal(false); }} />
          </div>
        ) : browserOpen ? (
          <>
            <div className="col-resizer browser-resizer" title="拖动调整浏览器宽度（双击还原）" {...browserResize} />
            <BrowserPanel request={browserRequest} width={browserWidth} onClose={() => setBrowserOpen(false)} />
          </>
        ) : null}
        {mode !== 'ide' && filePanelOpen && !browserOpen && !widgetPanel && (
          <>
            <div className="col-resizer agent-panel-resizer" title="拖动调整预览宽度（双击还原各占一半）" {...panelResizeHalf} />
            <AgentFilePanel files={previewFiles} root={active?.workspace || ideRoot || ''}
              editorTheme={localStorage.getItem('paw-editor-theme') === 'dark' ? 'dark' : 'light'}
              previewRequest={previewRequest} width={panelW} />
          </>
        )}
        </div>
        )}
        {sideCollapsed && (page !== 'chat' || (mode === 'ide' && chatHidden)) && (
          <div className="page-side-toggle">
            <Tips label="展开侧栏">
              <button className="topbar-icon topbar-side-toggle" aria-label="展开侧栏" onClick={toggleSide}>
                <PanelLeftOpen size={15} />
              </button>
            </Tips>
          </div>
        )}
      </main>
      {taskPanel && <TaskPanel onClose={() => setTaskPanel(false)} onRunInChat={runTaskInChat} />}
      {traceView && (
        <TracePanel
          trace={traceView.trace}
          loading={traceView.loading}
          rate={models.find((m) => m.id === traceView.trace?.model)?.rate}
          onClose={() => setTraceView(null)}
        />
      )}
      {revertAsk && (
        <ConfirmDialog
          title="将对话回退到此消息前？"
          body="回退后，对话恢复到此消息之前，这条消息的内容会回到输入框（可修改后重发），AI 改动的文件会一并还原"
          confirmText="回退"
          onCancel={() => setRevertAsk(null)}
          onConfirm={() => {
            const ask = revertAsk;
            setRevertAsk(null);
            void revertTo(ask.sid, ask.msgId).catch(() => setError('回退失败，请稍后重试。'));
          }}
        />
      )}
      {globalAllowAsk && (
        <ConfirmDialog
          title="所有新会话都允许这个工具？"
          body={`「${globalAllowAsk.tool}」将加入全局许可，之后新建的会话默认放行；已有会话不受追溯影响（当前会话会同步放行）。可在「工具 → 全局许可」中移除。`}
          confirmText="加入全局许可"
          onCancel={() => setGlobalAllowAsk(null)}
          onConfirm={() => void handleAllowGlobal()}
        />
      )}
      {forkAsk && (
        <ConfirmDialog
          title="从此消息分叉出新会话？"
          body="原会话的消息不会改变。如果分叉点之后有文件改动，工作区文件会回退到分叉点状态，两个分支共用同一个目录；建议先 git commit 或 git stash 保存当前改动（run_command 产生的文件修改不在快照覆盖内，IDE 手动保存的文件受自改保护不会覆盖）。"
          confirmText="创建分叉"
          onCancel={() => setForkAsk(null)}
          onConfirm={() => {
            const ask = forkAsk;
            setForkAsk(null);
            void forkSession(ask.sid, ask.msgId);
          }}
        />
      )}
      {bgToasts.length > 0 && (
        <div className="bg-toast-stack" role="status" aria-live="polite">
          {bgToasts.map((toast) => {
            const label =
              toast.status === 'ask' ? '后台会话等待回复'
                : toast.status === 'error' ? '后台会话执行出错'
                  : '后台会话已完成';
            return (
              <div
                key={toast.id}
                className={`bg-toast ${toast.status}`}
                onClick={() => selectSession(toast.sessionId)}
              >
                <span className={`bg-toast-icon ${toast.status}`}>
                  {toast.status === 'ask' ? <HelpCircle size={16} />
                    : toast.status === 'error' ? <AlertCircle size={16} />
                      : <CheckCircle2 size={16} />}
                </span>
                <div className="bg-toast-body">
                  <div className="bg-toast-label">{label}</div>
                  <div className="bg-toast-title" title={toast.title}>{toast.title}</div>
                </div>
                <button
                  type="button"
                  className="bg-toast-open"
                  onClick={(e) => { e.stopPropagation(); selectSession(toast.sessionId); }}
                >
                  查看
                </button>
                <button
                  type="button"
                  className="bg-toast-close"
                  aria-label="关闭提示"
                  onClick={(e) => { e.stopPropagation(); dismissBgToast(toast.sessionId); }}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
