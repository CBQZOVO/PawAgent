// SSE 客户端：POST /api/chat → 逐条 yield AgentEvent（类型来自 shared，前后端同一份契约）
import { normalizeMessage, type AgentEvent, type Attachment, type ChatMessage, type ContextReading, type HandoffContext, type PermissionDecision, type Session, type SessionPermission, type SessionSearchResult, type SessionSummary, type SessionUsage, type TaskRun, type TurnTrace, type ViewMessage } from '@paw/shared';

export interface StreamChatOptions {
  model?: string;
  signal?: AbortSignal;
  attachments?: Attachment[];
  skillIds?: string[];
  /** 用户为这条消息指定的系统连接 */
  connectionCode?: string;
  /** 本次运行的工作区（发起时固定；null=不用工作区） */
  workspace?: string | null;
  /** 定时任务「立即运行」：结束后按此写运行记录 */
  taskRun?: { taskId: string; runId: string };
  /** 当前会话 id：子代理会话挂到父会话下 */
  sessionId?: string;
  turnId?: string;
  /** 会话交接单（首条消息发送时附带） */
  handoff?: HandoffContext;
  /** 交接来源会话 id（供 search_parent_session 回查） */
  parentSessionId?: string;
  /** 客户端当前会话的权限配置兜底 */
  permission?: SessionPermission;
}

export async function getContextReading(sessionId: string, turnId: string, since: number, signal: AbortSignal): Promise<ContextReading | null> {
  const params = new URLSearchParams({ turnId, since: String(since) });
  const response = await fetch(`/api/context/${encodeURIComponent(sessionId)}/usage?${params}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).reading ?? null;
}

export async function compactContext(sessionId: string, model: string, messages: ChatMessage[], workspace: string | null, turnId?: string) {
  const response = await fetch('/api/context/compact', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, model, messages, workspace, turnId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  if (typeof data.message !== 'string') throw new Error('未收到压缩回执');
  const tokens = data.insight?.estimatedTokens;
  const byCategory = data.insight?.byCategory;
  return {
    message: data.message as string,
    reading: typeof tokens === 'number'
      ? { tokens, estimated: true, ...(byCategory ? { byCategory } : {}) }
      : null,
  };
}

export interface HandoffResponse {
  handoff: HandoffContext;
  suggestedTitle: string;
  nextPrompt: string;
  inherited: {
    workspace?: string | null;
    model?: string;
    skillIds: string[];
    connectionCode?: string;
  };
}

export async function createHandoff(params: {
  sessionId: string;
  title: string;
  model: string;
  messages: ChatMessage[];
  viewMessages: ViewMessage[];
  goal?: string;
  workspace: string | null;
  signal?: AbortSignal;
}): Promise<HandoffResponse> {
  const response = await fetch('/api/context/handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: params.signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  if (!data?.handoff?.summary) throw new Error('未收到有效的会话交接单');
  return data as HandoffResponse;
}

const TURN_NOTIFY_TEXT = {
  done: '这一轮回答完成了',
  error: '这一轮执行出错了',
  ask: '有几个问题需要你回答',
} as const;

/**
 * 一轮结束时的系统通知。焦点判断在调用方做（只有那一瞬间的状态才准）。
 * 桌面版走 App 自己的通知：通知栏显示 Paw 的图标和应用名，点一下回到窗口；
 * 浏览器版没有 App 身份，回落服务端 osascript，图标归属不可控。
 */
export async function notifyTurnEnd(kind: keyof typeof TURN_NOTIFY_TEXT): Promise<void> {
  const body = TURN_NOTIFY_TEXT[kind];
  const desktop = (window as unknown as {
    pawDesktop?: { notify?: (payload: { title: string; body: string }) => Promise<void> };
  }).pawDesktop;
  if (desktop?.notify) {
    await desktop.notify({ title: 'Paw', body });
    return;
  }
  await fetch('/api/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

/** 后台任务跑完的系统通知（窗口不在前台时才发，调用方判断） */
export async function notifyBackground(body: string): Promise<void> {
  const desktop = (window as unknown as {
    pawDesktop?: { notify?: (payload: { title: string; body: string }) => Promise<void> };
  }).pawDesktop;
  if (desktop?.notify) {
    await desktop.notify({ title: 'Paw', body });
    return;
  }
  await fetch('/api/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

export async function* streamChat(
  messages: ChatMessage[],
  opts: StreamChatOptions = {},
): AsyncGenerator<AgentEvent> {
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages, model: opts.model, attachments: opts.attachments,
      skillIds: opts.skillIds, connectionCode: opts.connectionCode,
      workspace: opts.workspace, taskRun: opts.taskRun,
      sessionId: opts.sessionId, turnId: opts.turnId,
      handoff: opts.handoff, parentSessionId: opts.parentSessionId,
      permission: opts.permission,
    }),
    signal: opts.signal,
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('响应无流');

  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 事件以空行分隔
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          yield JSON.parse(line.slice(5).trim()) as AgentEvent;
        } catch {
          /* 跳过坏包 */
        }
      }
    }
  }
}

/** 运行中强行提醒模型（插话注入当前正在执行的轮次）；若会话已结束返回 injected=false */
export async function steerChat(
  sessionId: string,
  payload: { id?: string; text: string; attachments?: Attachment[]; skillIds?: string[] },
): Promise<{ ok: boolean; injected: boolean }> {
  const r = await fetch('/api/chat/steer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, ...payload }),
  });
  if (!r.ok) return { ok: false, injected: false };
  return r.json() as Promise<{ ok: boolean; injected: boolean }>;
}

/** /btw 只读旁路问答：独立 SSE 流，不落库、不调工具、不干扰主会话 */
export async function* streamBtw(
  messages: ChatMessage[],
  opts: { model?: string; workspace?: string | null; signal?: AbortSignal } = {},
): AsyncGenerator<AgentEvent> {
  const resp = await fetch('/api/chat/btw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, model: opts.model, workspace: opts.workspace }),
    signal: opts.signal,
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('响应无流');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          yield JSON.parse(line.slice(5).trim()) as AgentEvent;
        } catch { /* 跳过坏包 */ }
      }
    }
  }
}

/** 权限确认卡决策回执 */
export async function approvePermissionApi(
  sessionId: string,
  id: string,
  decision: PermissionDecision,
): Promise<{ ok: boolean; decision?: PermissionDecision }> {
  const r = await fetch('/api/chat/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, id, decision }),
  });
  if (!r.ok) return { ok: false };
  return r.json() as Promise<{ ok: boolean; decision?: PermissionDecision }>;
}

/** 全局工具许可：只影响之后新建的会话，服务端强过滤 run_command / call_api */
export async function getGlobalPermissions(): Promise<{ allow: string[] }> {
  const r = await fetch('/api/permissions/global');
  const d = await r.json() as { allow?: string[] };
  return { allow: Array.isArray(d.allow) ? d.allow : [] };
}

export async function putGlobalPermissions(allow: string[]): Promise<{ ok: boolean; allow: string[] }> {
  const r = await fetch('/api/permissions/global', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allow }),
  });
  const d = await r.json() as { ok?: boolean; allow?: string[] };
  return { ok: !!d.ok, allow: Array.isArray(d.allow) ? d.allow : [] };
}

/** 专用权限更新接口（只改 meta.permission，不碰 messages） */
export async function updateSessionPermissionApi(
  sessionId: string,
  permission: SessionPermission,
): Promise<{ ok: boolean; permission?: SessionPermission; error?: string }> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/permission`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permission }),
  });
  return r.json() as Promise<{ ok: boolean; permission?: SessionPermission; error?: string }>;
}

/** 导出单个会话为 JSON 文件 */
export function exportSessionUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/export`;
}

/** 批量/单个导入会话 JSON（服务端事务写入，绝不覆盖已有 id） */
export async function importSessionsApi(
  rawText: string,
): Promise<{ ok: boolean; count: number; imported: SessionSummary[]; error?: string }> {
  const r = await fetch('/api/sessions/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawText,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `导入失败（HTTP ${r.status}）`);
  return d as { ok: boolean; count: number; imported: SessionSummary[] };
}

/** 获取单个会话的轻量轮次轨迹 */
export async function getTurnTracesApi(sessionId: string, signal?: AbortSignal): Promise<TurnTrace[]> {
  const r = await fetch(`/api/traces/${encodeURIComponent(sessionId)}`, { signal });
  if (!r.ok) return [];
  const d = (await r.json()) as { traces?: TurnTrace[] };
  return Array.isArray(d.traces) ? d.traces : [];
}

/** 本会话每轮用量（只取最近 100 轮实测轨迹），失败返回空结构 */
export async function getUsageApi(sessionId: string, signal?: AbortSignal): Promise<SessionUsage> {
  const empty: SessionUsage = { turns: [], total: { prompt: 0, completion: 0, rounds: 0 } };
  try {
    const r = await fetch(`/api/usage/${encodeURIComponent(sessionId)}`, { signal });
    if (!r.ok) return empty;
    const d = await r.json() as Partial<SessionUsage>;
    if (!Array.isArray(d.turns) || !d.total) return empty;
    return d as SessionUsage;
  } catch {
    return empty;
  }
}

/** 会话标题：第二次模型调用。失败返回空串，调用方保留字符串兜底标题。 */
export async function generateTitleApi(text: string, model?: string): Promise<string> {
  try {
    const r = await fetch('/api/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model }),
    });
    if (!r.ok) return '';
    const d = await r.json() as { title?: string };
    return typeof d.title === 'string' ? d.title.trim().slice(0, 24) : '';
  } catch {
    return '';
  }
}

export interface ModelInfo {
  id: string;
  group: string;
  /** 网关渠道倍率，不是单价；null 表示未设置 */
  rate?: number | null;
}

export async function getModels(): Promise<{ models: ModelInfo[]; default?: string | null; error?: string }> {
  const r = await fetch('/api/models');
  return r.json();
}

export type SearchProvider = 'deepseek' | 'ddg';

export async function getSearchConfig(): Promise<{ provider: SearchProvider; hasDeepseekKey: boolean }> {
  const r = await fetch('/api/search-config');
  return r.json();
}

export async function setSearchConfig(provider: SearchProvider): Promise<void> {
  const r = await fetch('/api/search-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
}

// 会话持久化（SQLite via server）
export async function getSessions(): Promise<Session[]> {
  const r = await fetch('/api/sessions');
  const d = await r.json();
  // 列表接口只给摘要（不含 messages）。这里补成空数组，
  // 保证「摘要态」的会话也能安全参与渲染/停止标记；正文由 getSession 按需加载。
  return (d.sessions || []).map((s: Session) => ({ ...s, messages: [] }));
}

/** 取单个会话的完整消息（列表接口只有摘要） */
export async function getSession(id: string): Promise<Session | null> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!r.ok) return null;
  const s = (await r.json()) as Session;
  // 老会话的 content 是字符串 + tools 数组（块模型之前写的），读进来先归一化
  return { ...s, messages: (s.messages || []).map((m) => normalizeMessage(m as unknown as Record<string, unknown>)) };
}

/** 历史消息正文检索（后端扫描 user/assistant 文本块） */
export async function searchSessionsApi(
  q: string,
  opts: { workspace?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<SessionSearchResult[]> {
  const query = q.trim();
  if (!query) return [];
  const params = new URLSearchParams({ q: query });
  if (opts.workspace) params.set('workspace', opts.workspace);
  if (opts.limit) params.set('limit', String(opts.limit));
  const r = await fetch(`/api/sessions/search?${params}`, { signal: opts.signal });
  if (!r.ok) return [];
  const d = (await r.json()) as { results?: SessionSearchResult[] };
  return Array.isArray(d.results) ? d.results : [];
}

/** 回滚文件：把 beforeTs 之后 AI 改过的文件还原（编辑消息重发前调用） */
export async function rewindFiles(sessionId: string, beforeTs: number): Promise<{ restored: string[]; skipped: string[] }> {
  const r = await fetch('/api/rewind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, beforeTs }),
  });
  if (!r.ok) throw new Error(`回退文件失败（HTTP ${r.status}）`);
  return r.json();
}

/** 从指定消息创建会话分叉（原会话消息保留，工作区按基线回退并继承前置快照） */
export async function forkSessionApi(
  sessionId: string,
  messageId: string,
  title?: string,
): Promise<{ ok: boolean; session: SessionSummary; restored: string[]; skipped: string[] }> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId, ...(title ? { title } : {}) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `分叉会话失败（HTTP ${r.status}）`);
  return d;
}

/** 跨同源分叉切换工作区文件状态（服务端通过最近公共祖先 LCA 自动撤销/重放快照） */
export async function switchSessionWorkspaceApi(
  fromSessionId: string,
  toSessionId: string,
): Promise<{
  ok: boolean;
  switched: boolean;
  lcaSessionId: string | null;
  pivotTs: number | null;
  restored: string[];
  replayed: string[];
  skipped: string[];
}> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(toSessionId)}/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromSessionId }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `切换分支工作区状态失败（HTTP ${r.status}）`);
  return d;
}

export async function putSessions(sessions: Session[]): Promise<void> {
  const r = await fetch('/api/sessions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions }),
  });
  if (!r.ok) throw new Error(`保存会话失败 HTTP ${r.status}`);
}

export async function delSession(id: string): Promise<void> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`删除会话失败 HTTP ${r.status}`);
}

// 定时任务
export async function getTasks(): Promise<import('@paw/shared').ScheduledTask[]> {
  const d = await (await fetch('/api/tasks')).json();
  return d.tasks || [];
}
export async function putTask(t: import('@paw/shared').ScheduledTask): Promise<void> {
  const r = await fetch('/api/tasks', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t) });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
}
export async function delTask(id: string): Promise<void> {
  const r = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`删除任务失败 HTTP ${r.status}`);
}
export async function getTaskRuns(id: string): Promise<import('@paw/shared').TaskRun[]> {
  const d = await (await fetch(`/api/tasks/${encodeURIComponent(id)}/runs`)).json();
  return d.runs || [];
}

// 技能列表（供输入框选择器与 / 快捷菜单）
export interface SkillSummary { id: string; name: string; description: string; source?: 'user' | 'workspace' }
export async function getSkills(): Promise<SkillSummary[]> {
  try {
    const d = await (await fetch('/api/skills')).json();
    return d.skills || [];
  } catch { return []; }
}

// 所有任务的运行记录（聊天页右侧面板）
export interface TaskRunWithName extends TaskRun { taskName: string }
export async function getAllTaskRuns(): Promise<TaskRunWithName[]> {
  try { return (await (await fetch('/api/tasks/runs/all')).json()).runs || []; }
  catch { return []; }
}

// 工作区
export const WORKSPACE_CHANGED = 'paw:workspace-changed';
export interface WorkspaceInfo { root: string | null; workspaces: string[]; candidates: string[] }
export async function getWorkspace(): Promise<WorkspaceInfo> {
  try { return await (await fetch('/api/workspace')).json(); }
  catch { return { root: null, workspaces: [], candidates: [] }; }
}
// 工作区写入串行化：快速切会话会连发多个 PUT，乱序完成会让「最后一次点击」
// 被更早发出的旧值覆盖（表现：点别的会话再点回来，当前工作区高亮丢了）。
// 同时用 epoch 守卫：只有最新一次排队的写入才派发 WORKSPACE_CHANGED，避免中间态旧值短暂覆盖 UI。
let wsWriteQueue: Promise<unknown> = Promise.resolve();
let wsWriteEpoch = 0;
function queueWsWrite(op: (isLatest: () => boolean) => Promise<void>): Promise<void> {
  const epoch = ++wsWriteEpoch;
  const run = wsWriteQueue.then(() => op(() => epoch === wsWriteEpoch), () => op(() => epoch === wsWriteEpoch));
  wsWriteQueue = run.catch(() => { /* 队列不断链 */ });
  return run;
}
export function setWorkspace(root: string | null): Promise<void> {
  return queueWsWrite(async (isLatest) => {
    const r = await fetch('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root }) });
    if (r.ok && isLatest()) window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED, { detail: { root } }));
  });
}
export function removeWorkspace(root: string): Promise<void> {
  return queueWsWrite(async (isLatest) => {
    const r = await fetch('/api/workspace', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root }) });
    if (r.ok && isLatest()) window.dispatchEvent(new Event(WORKSPACE_CHANGED));
  });
}

// 弹出 macOS Finder 选文件夹，返回选中路径（取消返回 null）
export async function pickWorkspaceFolder(): Promise<string | null> {
  try {
    const r = await fetch('/api/workspace/pick', { method: 'POST' });
    return (await r.json()).root ?? null;
  } catch { return null; }
}

// ===== 后台任务（Agent 用 run_command(background=true) 起的进程）=====
export interface BgJobView {
  id: string;
  cmd: string;
  cwd: string;
  daemon: boolean;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}
export async function getBackgroundJobs(): Promise<BgJobView[]> {
  try { return (await (await fetch('/api/jobs')).json()).jobs || []; }
  catch { return []; }
}
export async function killBackgroundJob(id: string): Promise<void> {
  await fetch(`/api/jobs/${encodeURIComponent(id)}/kill`, { method: 'POST' });
}

// ===== IDE 模式：工作区文件树 / 文件内容 =====
export interface FsEntry { name: string; path: string; dir: boolean; size?: number }
export async function getFsTree(root: string, sub = '.', q?: string): Promise<{ entries: FsEntry[]; truncated?: boolean; total?: number; error?: string }> {
  try {
    const qs = q ? `&q=${encodeURIComponent(q)}` : '';
    return await (await fetch(`/api/fs/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(sub)}${qs}`)).json();
  } catch { return { entries: [], error: '网络错误' }; }
}
export interface FsFile { path: string; content: string; lines: number; truncated: boolean; binary?: boolean; size: number; notice?: string; error?: string }
export async function getFsFile(root: string, file: string): Promise<FsFile> {
  try {
    return await (await fetch(`/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(file)}`)).json();
  } catch { return { path: file, content: '', lines: 0, truncated: false, size: 0, error: '网络错误' }; }
}
/** IDE 编辑器手动保存（Cmd+S）：服务端限制在工作区内，只写文本文件 */
export async function saveWorkspaceFile(root: string, file: string, content: string): Promise<{ ok: true; size: number } | { error: string }> {
  try {
    const r = await fetch('/api/fs/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: file, content }),
    });
    return await r.json();
  } catch { return { error: '网络错误' }; }
}

export interface FileStatInfo { exists: boolean; size?: number; isDir?: boolean; absPath?: string }
const statCache = new Map<string, { at: number; info: FileStatInfo }>();
const STAT_CACHE_MS = 15_000;
/** 批量检查产物文件是否存在及文件大小（带 15s 短缓存，避免列表重渲染重复请求） */
export async function statFiles(paths: string[], root?: string | null): Promise<Record<string, FileStatInfo>> {
  const uniq = [...new Set(paths.filter(Boolean))];
  const out: Record<string, FileStatInfo> = {};
  const missing: string[] = [];
  const now = Date.now();
  const prefix = `${root || ''}::`;
  for (const p of uniq) {
    const hit = statCache.get(prefix + p);
    if (hit && now - hit.at < STAT_CACHE_MS) out[p] = hit.info;
    else missing.push(p);
  }
  if (!missing.length) return out;
  try {
    const r = await fetch('/api/fs/stat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: missing, root: root || undefined }),
    });
    if (r.ok) {
      const d = (await r.json()) as { items?: Record<string, FileStatInfo> };
      if (statCache.size > 256) statCache.clear();
      for (const [k, v] of Object.entries(d.items || {})) {
        out[k] = v;
        statCache.set(prefix + k, { at: now, info: v });
      }
    }
  } catch { /* ignore */ }
  return out;
}

// ===== 腾讯文档引擎：Office 文件预览 =====
export interface OfficeStatus { available: boolean; port: number; needsDownload?: boolean; error?: string }
export async function getOfficeStatus(): Promise<OfficeStatus> {
  try {
    return await (await fetch('/api/office/status')).json();
  } catch {
    return { available: false, port: 0 };
  }
}
/** 带机器可读 code：OFFICE_ENGINE_MISSING 时前端才询问用户是否下载 */
export class OfficeError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'OfficeError';
    this.code = code;
  }
}
export interface OfficePreview { url: string; error?: string; code?: string }
/** path 用磁盘绝对路径；mode=readonly 打开只读预览 */
export async function getOfficePreview(path: string, mode: 'readonly' | 'edit' = 'readonly'): Promise<OfficePreview> {
  const params = new URLSearchParams({ path, mode });
  const r = await fetch(`/api/office/preview?${params}`);
  const d = await r.json().catch(() => ({})) as OfficePreview;
  if (!r.ok) throw new OfficeError(d.error || `HTTP ${r.status}`, d.code);
  if (typeof d.url !== 'string' || !d.url) throw new OfficeError(d.error || '未返回预览地址', d.code);
  return d;
}
/** 用户确认后下载引擎到 ~/.paw/office/ 并启动（服务端拒绝静默下载） */
export async function downloadOfficeEngine(): Promise<OfficeStatus> {
  const r = await fetch('/api/office/download', { method: 'POST' });
  const d = await r.json().catch(() => ({})) as OfficeStatus;
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

// ===== IDE 内置终端 =====
export interface TerminalInfo { shell: string; shellName: string; cwd: string; sessions: number; maxSessions: number }
export async function getTerminalInfo(cwd?: string | null): Promise<TerminalInfo | null> {
  try {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
    return await (await fetch(`/api/terminal/info${q}`)).json();
  } catch { return null; }
}
/** 终端 WebSocket 地址：vite dev（5173）走代理，桌面版直连自身 origin */
export function terminalWsUrl(params: { cwd?: string | null; cols: number; rows: number; shell?: string }): string {
  const q = new URLSearchParams();
  if (params.cwd) q.set('cwd', params.cwd);
  q.set('cols', String(params.cols));
  q.set('rows', String(params.rows));
  if (params.shell) q.set('shell', params.shell);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/terminal?${q}`;
}

// ===== 网关 token 配置（未配置时显示输入页）=====
export interface TokenStatus { configured: boolean; file: string; baseUrl?: string }
export async function getTokenStatus(): Promise<TokenStatus> {
  return (await fetch('/api/token-status')).json();
}
export async function saveToken(token: string, baseUrl?: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseUrl ? { token, baseUrl } : { token }),
  });
  return r.json();
}

export const PLUGINS_CHANGED = 'paw:plugins-changed';

export interface PluginPageInfo {
  key: string;
  pluginDir: string;
  pluginName: string;
  id: string;
  label: string;
  icon?: string;
  order: number;
  url: string;
}

/** 已启用插件解析后的部件清单（GET /api/widgets） */
export interface WidgetInfo {
  key: string;
  pluginDir: string;
  pluginName: string;
  id: string;
  title?: string;
  description?: string;
  url: string;
  placement: 'inline' | 'panel';
  defaultHeight: number;
  maxHeight: number;
  sameOrigin: boolean;
  defaultConnection?: string;
  allowedConnections?: 'session' | string[];
  sso: boolean;
}

export interface BuiltinPluginInfo {
  name: string;
  version?: string;
  tools: string[];
}

export interface ExternalPluginInfo {
  name: string;
  version?: string;
  description?: string;
  dir: string;
  entry: string;
  tools: string[];
  pages?: PluginPageInfo[];
  config: Record<string, unknown>;
}

export interface DisabledPluginInfo {
  dir: string;
  name: string;
  version?: string;
  description?: string;
  config: Record<string, unknown>;
}

export interface FailedPluginInfo {
  dir: string;
  name?: string;
  version?: string;
  description?: string;
  config: Record<string, unknown>;
  error: string;
}

export interface PluginInventory {
  pluginsDir: string;
  builtin: BuiltinPluginInfo[];
  external: ExternalPluginInfo[];
  disabled: DisabledPluginInfo[];
  skipped: string[];
  failed: FailedPluginInfo[];
  pages?: PluginPageInfo[];
  widgets?: WidgetInfo[];
}

export async function getWidgets(): Promise<WidgetInfo[]> {
  const res = await fetch('/api/widgets');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()).widgets ?? []) as WidgetInfo[];
}

/** 解析业务页面 URL：无 SSO 插件时服务端直接拼 baseUrl + path */
export async function resolveBusinessPage(code: string, opts: {
  path?: string; query?: Record<string, string>; title?: string;
}): Promise<{ url: string; partition: string; title?: string }> {
  const res = await fetch(`/api/connections/${encodeURIComponent(code)}/sso/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as { url: string; partition: string; title?: string };
}

export async function getPlugins(): Promise<PluginInventory> {
  const res = await fetch('/api/plugins');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function reloadPlugins(): Promise<PluginInventory> {
  const res = await fetch('/api/plugins/reload', { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  window.dispatchEvent(new Event(PLUGINS_CHANGED));
  return data;
}

export async function updatePlugin(
  dirOrName: string,
  patch: { enabled?: boolean; config?: Record<string, unknown> },
): Promise<PluginInventory> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(dirOrName)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  window.dispatchEvent(new Event(PLUGINS_CHANGED));
  return data;
}
