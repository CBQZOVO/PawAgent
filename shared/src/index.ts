// Paw 前后端共享数据契约。
// 设计原则：AgentEvent 是 SSE 的唯一载荷格式；工具 schema 前后端共用一份，
// 避免"名字/结构对不上"（今晚网关踩过的坑）。

export const CONTEXT_WINDOW_TOKENS = 1_000_000;

/** 一条聊天消息（OpenAI chat 格式子集） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}

/** 模型发起的工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串（模型原样输出）
}

/** 工具 JSON Schema 参数定义 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** 工具执行结果（回填给模型） */
export interface ToolResult {
  tool_call_id: string;
  content: string;
  isError?: boolean;
  /** 用户在严格权限模式下主动拒绝执行（不计入内核连续失败护栏） */
  rejectedByUser?: boolean;
}

export type PermissionDecision = 'allow_once' | 'deny' | 'allow_session' | 'deny_session';

export interface SessionPermission {
  mode: 'default' | 'strict';
  allow: string[];
  deny: string[];
}

/**
 * ask_user 的一个结构化问题。
 * 参考 fathom 的实现：给选项 + 允许自由输入，一次最多 4 题。
 */
export interface AskQuestion {
  question: string;
  options: string[];
  multiple?: boolean;
}

export type SubagentStatus = 'running' | 'completed' | 'error' | 'aborted' | 'timeout' | 'limit';

/** 工具卡片/子代理步骤的简短描述。模型没传可选 summary 时按参数生成，避免只剩 read_file。 */
export function toolStepSummary(
  name: string,
  args?: Record<string, unknown>,
  provided?: string,
): string {
  const own = typeof provided === 'string' ? provided.trim() : '';
  if (own) return own;
  const a = args || {};
  const one = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : '');
  const fileLabel = (v: unknown) => {
    const p = one(v);
    if (!p) return '';
    return p.split(/[\\/]/).filter(Boolean).slice(-1)[0] || p;
  };
  const files = Array.isArray(a.files) ? a.files.map(fileLabel).filter(Boolean) : [];
  const path = one(a.path) || one(a.root) || one(a.dir);
  switch (name) {
    case 'read_file': return path ? `读取 ${fileLabel(path) || path}` : '读取文件';
    case 'write_file': return path ? `写入 ${fileLabel(path) || path}` : '写入文件';
    case 'edit_file': return path ? `编辑 ${fileLabel(path) || path}` : '编辑文件';
    case 'delete_file': return path ? `删除 ${fileLabel(path) || path}` : '删除文件';
    case 'list_dir': return path ? `列出 ${path}` : '列出目录';
    case 'search_file': return one(a.pattern) ? `查找 ${one(a.pattern)}` : '搜索文件';
    case 'search_content': return one(a.pattern) ? `搜索 ${one(a.pattern)}` : '搜索内容';
    case 'web_fetch': return one(a.url) ? `读取网页 ${one(a.url)}` : '读取网页';
    case 'run_command': return one(a.cmd) || '执行命令';
    case 'generate_image': return '生成图片';
    case 'git_status': return '查看仓库状态';
    case 'git_diff': return '查看代码差异';
    case 'git_log': return '查看提交记录';
    case 'web_search': return one(a.query) ? `搜索 ${one(a.query)}` : '网页搜索';
    case 'search_parent_session': return one(a.query) ? `回查原会话：${one(a.query)}` : '回查原会话记录';
    default: return name;
  }
}

/** 子代理过程里透传给前端的一步（text 增量合并成段，工具调用单条） */
export interface SubagentStep {
  id?: string;
  kind: 'text' | 'tool' | 'error';
  text: string;
  tool?: string;
  ok?: boolean;
}

/** 子代理卡片视图（挂在 ToolView 上） */
export interface SubagentView {
  id: string;             // 子代理运行 id（= 子会话 id）
  name: string;           // 模型起的短名
  agentName: string;      // 子代理定义名（code-explorer 等）
  status: SubagentStatus;
  steps: SubagentStep[];
  seconds?: number;
  rounds?: number;
  tokens?: { prompt: number; completion: number }; // 二期：token 用量统计
}

export interface ContextCategory {
  system: number;
  user: number;
  assistant: number;
  tool: number;
  tools: number;
  images: number;
}

export interface ContextReading {
  tokens: number;
  estimated: boolean;
  byCategory?: ContextCategory;
}

/**
 * SSE 事件流载荷——前端据此渲染。
 * - reasoning: 思维链增量（折叠块）
 * - tool:      工具调用/结果（Mano 风格卡片，summary 是模型自填的中文目的）
 * - text:      正文增量
 * - done:      本轮结束
 * - error:     出错
 */
export type AgentEvent =
  | { type: 'context_usage'; reading: ContextReading }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_start'; id: string; name: string; summary?: string; args?: Record<string, unknown> }
  | { type: 'tool_done'; id: string; name: string; ok: boolean; output: string }
  | { type: 'tool_progress'; id: string; name: string; progress: ToolProgress }
  | { type: 'text'; delta: string }
  | { type: 'done'; usage?: { prompt: number; completion: number }; rounds?: number }
  | { type: 'error'; message: string }
  // 严格权限模式：挂起当前工具调用等待用户放行或拒绝
  | {
      type: 'permission_ask';
      id: string;
      toolCallId: string;
      tool: string;
      title: string;
      detail: string;
      options: PermissionDecision[];
    }
  | { type: 'permission_updated'; permission: SessionPermission }
  // 子代理：start 建卡片 → event 透传过程（text/tool_start/tool_done）→ done 收尾
  | { type: 'subagent_start'; id: string; toolCallId?: string; name: string; agentName: string; task: string }
  | { type: 'subagent_event'; id: string; event: AgentEvent }
  | { type: 'subagent_done'; id: string; status: SubagentStatus; summary: string;
      seconds: number; rounds: number; tokens?: { prompt: number; completion: number } }
  // 内置浏览器：服务端 SSO 换票后只把最终 URL 给 UI，不把 token 写进模型上下文
  | { type: 'open_browser'; url: string; key?: string; partition?: string; title?: string }
  // 结构化提问：ask_user 命中即**暂停本轮**（后面没有 done，前端发起时不要等流结束）
  // 用户答复作为下一条 user 消息发出，模型接着往下做。
  | { type: 'ask'; questions: AskQuestion[] }
  // 强行提醒未消费回执：本轮提前结束时把未送达模型的 steer id 回传前端，前端回滚进队列不丢消息
  | { type: 'steer_unconsumed'; ids: string[] }
  // 自定义部件：工具主动发射，前端落到消息块；绝不进模型上下文
  | {
      type: 'widget';
      id: string;
      widgetId: string;
      title?: string;
      placement?: WidgetPlacement;
      connectionCode?: string;
      data?: unknown;
      dataRef?: string;
      options?: Record<string, unknown>;
      autoOpen?: boolean;
    }
  | {
      type: 'widget_update';
      id: string;
      data?: unknown;
      options?: Record<string, unknown>;
      status?: WidgetStatus;
    };

export type WidgetPlacement = 'inline' | 'panel';
export type WidgetStatus = 'streaming' | 'ready';

/** 部件 Bridge 协议版本：不匹配的信封直接丢弃，避免新旧部件互相误解 */
export const WIDGET_BRIDGE_PROTOCOL = 'paw-widget/1' as const;

/** 部件 ↔ 宿主的所有 postMessage 都套这层信封（防串台见 WidgetFrame） */
export interface WidgetBridgeEnvelope {
  protocol: typeof WIDGET_BRIDGE_PROTOCOL;
  channel: 'paw-widget';
  instanceId: string;
  /** 只接受 from: 'widget'；防止部件伪造宿主的 init / update 消息 */
  from: 'widget' | 'host';
  /** 请求/响应关联 ID；api_call / connection_call 必填 */
  requestId?: string | number;
  type: string;
  payload?: unknown;
}

export interface WidgetInitPayload {
  instanceId: string;
  sessionId?: string;
  messageId?: string;
  connectionCode?: string;
  theme?: string;
  mode?: WidgetPlacement;
  data?: unknown;
  dataRef?: string;
  options?: Record<string, unknown>;
  state?: unknown;
}

/** 上传的文件附件（内容随请求发送，后端拼进 user message） */
export interface Attachment {
  name: string;
  content: string;   // 文本文件内容（图片为 base64 data URL 占位）
  size: number;
  mime: string;
  kind: 'image' | 'file';  // 粘贴图片 vs 拖入/上传文件（WorkBuddy 两种引用格式）
  /** 桌面端选文件时 Electron 暴露的本机绝对路径；仅用于右侧面板预览原件，不发给模型。 */
  localPath?: string;
}

/** 会话交接双向链接 */
export interface HandoffLink {
  sessionId: string;
  title: string;
}

/** 会话交接单：挂在新会话待发送草稿及首条 user 消息上，前端渲染折叠卡片，后端注入 <handoff_context> */
export interface HandoffContext {
  fromSessionId: string;
  fromTitle: string;
  summary: string;
  changedFiles?: string[];
  pendingTodos?: string[];
  activeDaemons?: string[];
}

/** 将交接单格式化为发给模型的 <handoff_context> 块（前后端共用，保证历史摘要与首轮完全一致） */
export function formatHandoffBlock(h: HandoffContext): string {
  const summary = (h.summary || '').trim();
  if (!summary) return '';
  return [
    `<handoff_context from_session="${h.fromTitle.replace(/"/g, "'")}" from_session_id="${h.fromSessionId}">`,
    '本会话承接自上一会话的交接单，请直接在此基础上继续工作，不要重复已完成步骤。',
    '如需查证上一会话中省略的具体报错原文、接口返回或讨论细节，可调用 `search_parent_session` 工具按关键词回查。',
    '',
    summary,
    '</handoff_context>',
  ].join('\n');
}

/** /api/chat 请求体 */
export interface ChatRequest {
  turnId?: string;
  messages: ChatMessage[];
  model?: string;
  attachments?: Attachment[];
  skillIds?: string[];   // 用户选中的技能，后端把 SKILL.md 全文注入消息
  /** 用户为这条消息指定的系统连接（code）：后端注入一段说明，让模型优先用它调接口 */
  connectionCode?: string;
  /**
   * 本次运行的工作区（发起时固定，整轮工具都用它）。
   * null=不使用工作区；缺省=沿用服务端当前工作区（兼容旧客户端）。
   * 不能省略：否则用户切换会话后，进行中的工具会落到新工作区。
   */
  workspace?: string | null;
  /** 定时任务「立即运行」时携带：本轮结束后按此 id 写运行记录 */
  taskRun?: { taskId: string; runId: string };
  /** 客户端会话 id：子代理会话挂到父会话下用（缺省也能跑，只是不关联） */
  sessionId?: string;
  /** 交接单内容：首条消息发送时注入 <handoff_context> 给模型 */
  handoff?: HandoffContext;
  /** 若当前会话由旧会话交接而来，携带源会话 id 供 search_parent_session 按需回查 */
  parentSessionId?: string;
  /** 客户端当前会话的权限配置兜底（防新建会话首轮尚未防抖落库时丢失 strict 配置） */
  permission?: SessionPermission;
}

/** /btw 只读旁路问答请求：不落库、不调工具、不触发复盘 */
export interface BtwRequest {
  messages: ChatMessage[];
  model?: string;
  workspace?: string | null;
}

/** 单轮执行轨迹（落 turn_traces 表，用于排查慢轮次与工具耗时分解） */
export interface TurnTraceTool {
  id: string;
  name: string;
  start: number;
  end: number;
  ms: number;
  ok: boolean;
  rejectedByUser?: boolean;
}

export interface TurnTrace {
  turnId: string;
  at: number;
  totalMs: number;
  firstTextMs?: number;
  toolMs: number;
  approvalWaitMs: number;
  modelMs: number;
  rounds: number;
  usage?: { prompt: number; completion: number };
  model?: string;
  tools: TurnTraceTool[];
}

/** 会话持久化类型（前后端共用：web localStorage 缓存 + server SQLite） */
export interface ToolProgress {
  current: number;
  total: number;
  label: string;
  bytes?: number;
  totalBytes?: number;
}

export interface ToolView {
  id: string;
  name: string;
  summary?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  output?: string;
  progress?: ToolProgress;   // 长任务在同一张卡上更新进度
  subagent?: SubagentView;   // name === 'subagent' 时有值（子代理卡片）
}

/** todo_write 的任务清单条目（对标 Qoder TodoWrite / dsh todo_write） */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * 一条消息的内容块（text / thinking / tool-call / ask-user 等混排，顺序由数组保证）。
 * 结果直接回填到对应的 tool-call 块上，按 id 配对。
 */
/** 会话流里的自定义部件实例。data/state 只给 UI，不参与模型历史序列化。 */
export interface WidgetBlock {
  type: 'widget';
  id: string;
  widgetId: string;
  title?: string;
  placement?: WidgetPlacement;
  connectionCode?: string;
  data?: unknown;
  dataRef?: string;
  options?: Record<string, unknown>;
  /** 用户在部件内操作后的交互态，刷新后还原 */
  state?: unknown;
  status?: WidgetStatus;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  // answer 有值 = 用户已经答过（卡片转为只读，防止重复提交；刷新后也能还原）
  | { type: 'ask'; questions: AskQuestion[]; answer?: string }
  | WidgetBlock
  | {
      type: 'tool-call';
      id: string;
      name: string;
      summary?: string;
      args?: Record<string, unknown>;
      ok?: boolean;
      output?: string;
      progress?: ToolProgress;   // 长任务进度（同一张工具卡更新）
      subagent?: SubagentView;   // name === 'subagent' 时有值（子代理卡片）
    };

export interface ViewMessage {
  id: string;
  role: 'user' | 'assistant';
  /** 按实际发生顺序排的块：text 与 tool-call 交错。user 消息通常只有一块 text。 */
  content: ContentBlock[];
  /** 思考过程：对齐 CodeBuddy 在 UI 层把 thinking 拍平成消息字段的做法（不占块顺序） */
  reasoning?: string;
  todos?: TodoItem[];    // 本轮最新任务清单（todo_write 全量覆盖，卡片渲染）
  ts: number;
  model?: string;
  attachments?: Attachment[];
  skillIds?: string[];   // 用户发送时选中的技能（复制消息/历史回传用）
  connectionCode?: string; // 这条消息指定用哪个系统连接（气泡上显示 chip）
  handoff?: HandoffContext; // 交接会话的首条消息携带的交接单（折叠展示，发给模型时注入上下文）
  error?: string;        // 本轮的错误信息（独立字段，不混进正文）
  stopped?: boolean;     // 用户点了停止（不再显示'思考中'）
  /** 本轮耗时（毫秒）：流结束/中断时写回，折叠条与底部工具条上显示（对齐 CodeBuddy 的「已处理 2m3s」） */
  durationMs?: number;
}

/** 工具调用块（卡片数据全在这，`tools` 数组已并入 content） */
export type ToolCallBlock = Extract<ContentBlock, { type: 'tool-call' }>;

/** 消息里的纯文本（复制、标题用）：只拼 text 块。widget 块的 data/state 永不进正文或模型历史。 */
export function messageText(m: Pick<ViewMessage, 'content'>): string {
  return (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
}

const LEAKED_TOOL_DIGEST_RE = /\n*\[本轮工具记录[:：][\s\S]*?\]\s*$/;
const IGNORED_HISTORY_TOOLS = new Set(['ask_user', 'load_skill', 'describe_image']);
const VALID_TOOL_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

/**
 * 历史助手消息的「最终回复正文」：
 * - 若本轮调用过工具，只取最后一个 tool-call 之后的 text 块，避免把中间过程独白（“先跑一下…再看一下…”）
 *   拼成一整段纯文本发回模型，诱发长会话里模型用纯文本假装执行工具的模仿幻觉。
 * - 若末尾没有文本（如 ask_user 或中途停止），退回最后一个非空 text 块。
 * - 同时剥离历史上可能残留/被模型模仿吐出的 `[本轮工具记录：...]` 尾巴，防止继续污染后续轮次。
 */
export function assistantFinalText(m: Pick<ViewMessage, 'content'>): string {
  const blocks = m.content || [];
  let lastToolIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'tool-call') { lastToolIdx = i; break; }
  }
  const clean = (s: string) => s.replace(LEAKED_TOOL_DIGEST_RE, '').trim();
  if (lastToolIdx < 0) return clean(messageText(m));

  const tail = blocks
    .slice(lastToolIdx + 1)
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text' && Boolean(b.text?.trim()))
    .map((b) => b.text.trim())
    .join('\n\n');
  if (tail) return clean(tail);

  for (let i = lastToolIdx - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'text' && b.text?.trim()) return clean(b.text);
  }
  return '';
}

function compactHistoryToolArgs(args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '{}';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 240) {
      out[k] = `${v.slice(0, 120)}… [已省略 ${v.length} 字]`;
    } else if (Array.isArray(v) && v.length > 12) {
      out[k] = [...v.slice(0, 10), `… (+${v.length - 10} items)`];
    } else {
      out[k] = v;
    }
  }
  try {
    const json = JSON.stringify(out);
    if (json.length <= 600) return json;
    // 超长时只保留关键定位字段，确保仍为合法 JSON
    const slim: Record<string, unknown> = {};
    for (const k of ['path', 'cmd', 'query', 'pattern', 'url', 'job_id', 'connection', 'method', 'description', 'subagent_name', 'background', 'daemon']) {
      if (k in out) slim[k] = out[k];
    }
    return JSON.stringify(slim);
  } catch {
    return '{}';
  }
}

function compactHistoryToolOutput(t: ToolCallBlock): string {
  const prefix = t.ok === false ? '[失败] ' : '';
  const raw = typeof t.output === 'string' ? t.output.trim() : '';
  if (!raw) return t.ok === undefined ? '[未完成/已中断]' : (t.ok === false ? '[执行失败]' : '[已完成]');
  if (raw.length <= 500) return prefix + raw;
  const omitted = raw.length - 480;
  return `${prefix}${raw.slice(0, 340)}\n… [已省略 ${omitted} 字] …\n${raw.slice(-140)}`;
}

/**
 * 将单条历史助手 ViewMessage 转为标准 OpenAI ChatMessage 序列：
 * - 最近几轮（includeToolCalls=true）：保留精简后的真实 `(assistant[tool_calls] + tool...)` 消息对，
 *   再接最终回复文本。既保留文件路径/job_id/接口结果等上下文锚点，又给模型提供真实 function-calling 范例，
 *   彻底避免把工具记录拼进 assistant 正文引发的「纯文本编造工具执行」幻觉。
 * - 更早轮次（includeToolCalls=false）：只保留最终回复正文，不拼接 `[本轮工具记录：...]`。
 * - widget 块由下方各步骤按 type 过滤，不把部件 data/state 塞进模型上下文。
 */
export function assistantHistoryMessages(
  m: Pick<ViewMessage, 'content' | 'stopped'>,
  options: { includeToolCalls?: boolean; turnIndex?: number; maxToolCalls?: number } = {},
): ChatMessage[] {
  const finalProse = assistantFinalText(m);
  const maxTools = options.maxToolCalls ?? 10;
  const turnIdx = options.turnIndex ?? 0;

  if (!options.includeToolCalls) {
    return finalProse ? [{ role: 'assistant', content: finalProse }] : [];
  }

  const allTools = (m.content || []).filter(
    (b): b is ToolCallBlock =>
      b.type === 'tool-call' &&
      !IGNORED_HISTORY_TOOLS.has(b.name) &&
      VALID_TOOL_NAME_RE.test(b.name),
  );
  const keptTools = allTools.length > maxTools ? allTools.slice(-maxTools) : allTools;

  if (!keptTools.length) {
    return finalProse ? [{ role: 'assistant', content: finalProse }] : [];
  }

  const toolCalls: ToolCall[] = [];
  const toolMessages: ChatMessage[] = [];
  for (let i = 0; i < keptTools.length; i++) {
    const t = keptTools[i];
    const callId = `hist_${turnIdx}_${i}`;
    toolCalls.push({
      id: callId,
      name: t.name,
      arguments: compactHistoryToolArgs(t.args),
    });
    toolMessages.push({
      role: 'tool',
      tool_call_id: callId,
      content: compactHistoryToolOutput(t),
    });
  }

  const out: ChatMessage[] = [
    { role: 'assistant', content: '', tool_calls: toolCalls },
    ...toolMessages,
  ];
  if (finalProse) {
    out.push({ role: 'assistant', content: finalProse });
  } else if (m.stopped) {
    out.push({ role: 'assistant', content: '（本轮已中途停止）' });
  }
  return out;
}

/**
 * 历史助手消息转给模型的紧凑文本：正文 + 关键工具轨迹摘要。
 *
 * 解决跨轮次「工具失忆」痛点（2026-11-24 评估导出数据可用性会话实锤）：
 * - 以前只拼 text 块，上一轮写过的脚本路径、启动的后台 job_id/PID、子代理查完还未复述的 DTO 结论、
 *   以及被用户中途停止前的动作全部蒸发，导致下一轮反复全盘 find 找脚本、重派子代理。
 * - 这里只提炼高信噪比锚点（文件路径、job_id、接口状态、未复述时的子代理摘要），严格限长，不带大段输出与凭据。
 */
export function assistantHistoryText(m: Pick<ViewMessage, 'content' | 'stopped'>): string {
  const prose = messageText(m).trim();
  const blocks = m.content || [];
  const tools = blocks.filter((b): b is ToolCallBlock => b.type === 'tool-call' && b.name !== 'ask_user' && b.name !== 'load_skill' && b.name !== 'describe_image');
  const hasAsk = blocks.some((b) => b.type === 'ask');
  if (!tools.length && !m.stopped) return prose;

  const notes: string[] = [];
  const seen = new Set<string>();
  const addNote = (s: string) => {
    if (!s || seen.has(s) || notes.length >= 16) return;
    seen.add(s);
    notes.push(s);
  };

  for (const t of tools) {
    const a = t.args || {};
    const out = typeof t.output === 'string' ? t.output : '';
    const status = t.ok === false ? ' [失败]' : '';
    if (t.name === 'write_file' || t.name === 'edit_file' || t.name === 'delete_file') {
      if (typeof a.path === 'string') addNote(`${t.name}(${a.path})${status}`);
    } else if (t.name === 'run_command') {
      const cmd = typeof a.cmd === 'string' ? a.cmd.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
      if (a.background === true || a.daemon === true) {
        const jobMatch = out.match(/job-[\w-]+/)?.[0];
        const pidMatch = out.match(/pid=(\d+)/)?.[1];
        addNote(`run_command(${a.daemon ? 'daemon' : 'bg'}${jobMatch ? ` ${jobMatch}` : ''}${pidMatch ? ` pid=${pidMatch}` : ''}: ${cmd})${status}`);
      } else if (t.ok === false || m.stopped) {
        addNote(`run_command(${cmd})${status}`);
      }
    } else if (t.name === 'kill_job' && typeof a.job_id === 'string') {
      addNote(`kill_job(${a.job_id})${status}`);
    } else if (t.name === 'call_api') {
      const firstLine = out.split('\n')[0]?.trim().slice(0, 120);
      addNote(firstLine ? `call_api: ${firstLine}` : `call_api(${String(a.method || 'GET')} ${String(a.connection || '')}${String(a.path || '')})${status}`);
    } else if (t.name === 'analyze_har' && typeof a.path === 'string') {
      addNote(`analyze_har(${a.path})${status}`);
    } else if (t.name === 'har_batch_download') {
      addNote(`har_batch_download(${String(a.har || '')}${a.output_dir ? ` -> ${String(a.output_dir)}` : ''}, dry_run=${a.dry_run !== false})${status}`);
    } else if (t.name === 'subagent') {
      const label = String(a.description || a.subagent_name || 'subagent');
      // 若本轮因 ask_user / 用户停止收尾、或正文过短未整合子代理报告，保留子代理结论摘要以防丢失
      if (out && (hasAsk || m.stopped || prose.length < 400)) {
        addNote(`subagent(${label}) 结论摘要: ${out.replace(/\s+/g, ' ').slice(0, 1200)}`);
      } else {
        addNote(`subagent(${label})${status}`);
      }
    }
  }
  if (m.stopped) addNote('本轮被用户中途停止');
  if (!notes.length) return prose;
  const digest = `[本轮工具记录：${notes.join('；')}]`.slice(0, 2400);
  return prose ? `${prose}\n\n${digest}` : digest;
}

/** 消息里的所有工具卡片（按顺序） */
export function messageTools(m: Pick<ViewMessage, 'content'>) {
  return (m.content || []).flatMap((b) => (b.type === 'tool-call' ? [b] : []));
}

/**
 * 老数据归一化：把「content: string + tools: ToolView[]」转成块数组。
 *
 * 为什么只能放「工具在前、正文在后」：老格式里顺序信息在写入时就丢了
 * （正文是一整串、工具是另一个数组），恢复不了，只能按旧渲染顺序摆。
 * 上一版临时加的 `blocks` 字段也在这里一并转过来。
 */
export function normalizeMessage(raw: Record<string, unknown>): ViewMessage {
  const m = raw as unknown as ViewMessage & { tools?: unknown; blocks?: unknown };
  if (Array.isArray(m.content) && (m.content as ContentBlock[]).every((b) => b && typeof b.type === 'string')) {
    return { ...m, content: m.content as ContentBlock[] };
  }
  const tools = Array.isArray(m.tools) ? (m.tools as { id: string }[]) : [];
  const text = typeof m.content === 'string' ? m.content : '';
  const blocks = Array.isArray(m.blocks)
    ? (m.blocks as { kind: string; id?: string; text?: string }[])
    : null;

  const content: ContentBlock[] = [];
  if (blocks?.length) {
    // 上一版的 blocks：只存了 id，卡片数据还在 tools 里
    for (const b of blocks) {
      if (b.kind === 'text' && typeof b.text === 'string') content.push({ type: 'text', text: b.text });
      else if (b.kind === 'tool' && b.id) {
        const t = tools.find((x) => x.id === b.id);
        if (t) content.push({ type: 'tool-call', ...(t as object) } as ContentBlock);
      }
    }
    // blocks 里没覆盖到的工具（理论上不该有）补在末尾，别丢卡片
    for (const t of tools) if (!content.some((c) => c.type === 'tool-call' && c.id === t.id)) content.push({ type: 'tool-call', ...(t as object) } as ContentBlock);
  } else {
    for (const t of tools) content.push({ type: 'tool-call', ...(t as object) } as ContentBlock);
    if (text) content.push({ type: 'text', text });
  }
  const { tools: _t, blocks: _b, ...rest } = m;
  return { ...(rest as object), content } as ViewMessage;
}

export interface Session {
  id: string;
  title: string;
  messages: ViewMessage[];
  updatedAt: number;
  source?: 'task' | 'subagent'; // 定时任务/子代理产生的会话（侧栏单独处理）
  taskId?: string;      // 关联的任务 id（点击运行记录能跳到会话）
  workspace?: string;   // 创建时的工作区根路径（侧栏按此分组；无=最近任务）
  runId?: string;       // 关联的运行记录 id（一次执行 ↔ 一条记录 ↔ 一个会话）
  parentId?: string;    // 子代理会话：父会话 id（侧栏不显示，只从子代理卡片进）
  handoffFrom?: HandoffLink; // 交接来源会话（顶栏显示「← 承接自」快捷跳转）
  handoffTo?: HandoffLink;   // 已交接至哪个新会话（原会话底部显示跳转提示）
  permission?: SessionPermission; // 按会话的工具权限配置（默认 default 不拦截）
}

/** 会话列表摘要（/api/sessions 只返回这些，消息正文按需从 /api/sessions/:id 拉取） */
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  workspace?: string;
  source?: 'task' | 'subagent';
  taskId?: string;
  runId?: string;
  parentId?: string;
  handoffFrom?: HandoffLink;
  handoffTo?: HandoffLink;
  permission?: SessionPermission;
}

/** 历史消息搜索命中项（/api/sessions/search 返回） */
export interface SessionSearchResult {
  sessionId: string;
  title: string;
  updatedAt: number;
  workspace?: string;
  messageId: string;
  role: 'user' | 'assistant';
  snippet: string;
}

/**
 * 模型能力清单：2026-11-20 用真实图片对网关 37 个模型的实测结果。
 * 只有这些模型能真正读懂 image_url part（其余会答"看不到图片"）。
 * 前后端共用：前端画 👁 标识，后端做"图片转文字"转交。
 *
 * 注意：图片只在发送的那一轮作为 image part 发给模型，历史消息里只剩 @"文件名" 占位。
 * 后续轮次模型答"看不到图"，是图片没落盘、没有路径可读，不是模型读不了图
 * （见 server/src/attachments.ts：图片落盘后路径会随历史一起给模型）。
 */
export const VISION_MODELS = new Set([
  'gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6.2-astra', 'codex-auto-review',
  'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5',
  'gemini-3.8-flash', 'gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-4-neon', 'gemini-4-argon',
  'glm-5.3-flashx', 'kimi-k3', 'haiyue-122b-a10b', 'haiyue-v3.5-27b',
  'hy4flash', 'hy4flash-free', 'hy4std', 'deepseek-v4.1-flash', 'mimo-v2.6-pro',
  'step-5-preview', 'space-bunny', 'grok-4.7',
]);

export function canSeeImages(model: string): boolean {
  return VISION_MODELS.has(model.toLowerCase());
}

/** 定时任务：定时执行一个工具调用（内置工具，未来含 MCP） */
export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;        // 任务内容（自然语言，到点发给模型执行）
  model: string;         // 用哪个模型执行
  skillIds: string[];    // 附带的技能（执行时注入 SKILL.md 全文）
  cron: string;          // 5 段 cron：分 时 日 月 周（由下面的可视化规则生成）
  repeat: 'once' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'interval';
  time: string;          // "HH:mm"
  weekdays?: number[];   // 每周模式：0=周日..6=周六
  dayOfMonth?: number;   // 每月模式：1-31
  month?: number;        // 每年模式：1-12
  dayOfYear?: number;    // 每年模式的日
  intervalMinutes?: number; // 间隔模式：每 N 分钟
  startDate?: string;    // 有效期起 "YYYY-MM-DD"
  endDate?: string;      // 有效期止 "YYYY-MM-DD"
  wecomPush?: boolean;   // 推送到企业微信（占位）
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
}

/** 定时任务执行记录 */
export interface TaskRun {
  id: string;
  taskId: string;
  at: number;
  ok: boolean;
  output: string;
  seconds: number;
}

// ── 附件占位符：chip 在文本里的位置标记 ──────────────────────────────
// 附件 chip 能夹在文字中间（前/中/后都有可能），所以消息正文不能只是纯文本：
// chip 在编辑器里序列化成 `@"文件名"`，展示时按占位符原位还原成 chip，
// 发给模型时原位替换成附件内容。没有占位符的旧消息按「chip 全部前置」兜底。

export type AttSegment =
  | { kind: 'text'; text: string }
  | { kind: 'chip'; att: Attachment };

export function splitAttachmentPlaceholders(
  text: string,
  atts: Attachment[],
): AttSegment[] | null {
  if (!atts.length || !text.includes('@"')) return null;
  const refs = atts.map((att) => ({ att, raw: `@"${att.name}"` })).sort((a, b) => b.raw.length - a.raw.length);
  const used = new Set<Attachment>();
  const out: AttSegment[] = [];
  let last = 0;
  let at = text.indexOf('@"');
  while (at >= 0) {
    const matches = refs.filter((r) => text.startsWith(r.raw, at));
    const match = matches.find((r) => r.raw === matches[0].raw && !used.has(r.att)) ?? matches[0];
    if (match) {
      if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
      out.push({ kind: 'chip', att: match.att });
      used.add(match.att);
      last = at + match.raw.length;
    }
    at = text.indexOf('@"', match ? last : at + 2);
  }
  if (!out.length) return null;
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}
