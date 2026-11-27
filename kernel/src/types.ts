// @paw/kernel 核心数据契约与宿主适配接口（零外部依赖，可独立开源）

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  isError?: boolean;
  rejectedByUser?: boolean;
}

export type PermissionDecision = 'allow_once' | 'deny' | 'allow_session' | 'deny_session';

export interface SessionPermission {
  mode: 'default' | 'strict' | 'plan';
  allow: string[];
  deny: string[];
}

export interface AskQuestion {
  question: string;
  options: string[];
  multiple?: boolean;
}

export interface TodoItem {
  id?: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  dependsOn?: string[];
}

export type SubagentStatus = 'running' | 'completed' | 'error' | 'aborted' | 'timeout' | 'limit';

export interface ContextCategory {
  system: number;     // 系统提示词（不含技能块）
  skills: number;     // 技能（系统提示里的 <available_skills> 块）
  dialog: number;     // 对话消息（user + assistant）
  toolResult: number; // 工具结果（tool 角色）
  agentTools: number; // 内建工具及子智能体 schema
  mcp: number;        // 连接器及 MCP 工具 schema（名字带 server__ 前缀）
  images: number;
}

export interface ContextReading {
  tokens: number;
  estimated: boolean;
  byCategory?: ContextCategory;
}

export interface ToolProgress {
  current: number;
  total: number;
  label: string;
  bytes?: number;
  totalBytes?: number;
  detail?: string;
}

export type AgentEvent =
  | { type: 'context_usage'; reading: ContextReading }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_start'; id: string; name: string; summary?: string; args?: Record<string, unknown> }
  | { type: 'tool_done'; id: string; name: string; ok: boolean; output: string }
  | { type: 'tool_progress'; id: string; name: string; progress: ToolProgress }
  | { type: 'text'; delta: string }
  | { type: 'done'; usage?: { prompt: number; completion: number }; rounds?: number }
  | { type: 'error'; message: string }
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
  | { type: 'subagent_start'; id: string; toolCallId?: string; name: string; agentName: string; task: string }
  | { type: 'subagent_event'; id: string; event: AgentEvent }
  | { type: 'subagent_done'; id: string; status: SubagentStatus; summary: string;
      seconds: number; rounds: number; tokens?: { prompt: number; completion: number } }
  | { type: 'open_browser'; url: string; key?: string; partition?: string; title?: string }
  | { type: 'ask'; questions: AskQuestion[] }
  | { type: 'steer_unconsumed'; ids: string[] }
  | {
      type: 'widget';
      id: string;
      widgetId: string;
      title?: string;
      placement?: 'inline' | 'panel';
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
      status?: 'streaming' | 'ready';
    };

export interface StreamDelta {
  reasoning?: string;
  content?: string;
  toolCalls?: { index: number; id?: string; name?: string; arguments?: string }[];
  finishReason?: string;
  usage?: { prompt: number; completion: number };
}

export interface StreamChatOptions {
  messages: ChatMessage[];
  tools: ToolSchema[];
  images?: string[];
  signal?: AbortSignal;
  model?: string;
}

/** 模型流式提供者：Kernel 不绑定具体网关或 SDK */
export type StreamChatFn = (opts: StreamChatOptions) => AsyncGenerator<StreamDelta>;

export interface ContextCheckpoint {
  covered: number;
  digest: string;
  summary: string;
}

export interface ContextSampleRecord {
  kind: 'request' | 'manual';
  model: string;
  turnId?: string;
  runId?: string;
  round?: number;
  estimatedTokens: number;
  windowTokens: number;
  thresholdTokens: number;
  byCategory: ContextCategory;
  usage?: { prompt: number; completion: number };
  finishReason?: string | null;
  beforeTokens: number;
  reclaimedTokens: number;
  compacted: boolean;
  failure?: string;
}

/** 持久化检查点与上下文采样适配器（默认可不传，仅走内存） */
export interface CheckpointStore {
  getCheckpoint(sessionId: string): ContextCheckpoint | null | undefined;
  saveCheckpoint(sessionId: string, previous: ContextCheckpoint | null | undefined, next: ContextCheckpoint): boolean;
  addSample?(sessionId: string, sample: ContextSampleRecord): void;
}

export interface ToolCallBlock {
  type: 'tool-call';
  id: string;
  name: string;
  summary?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  output?: string;
  progress?: ToolProgress;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | ToolCallBlock
  | { type: 'ask'; questions: AskQuestion[] }
  | {
      type: 'widget';
      id: string;
      widgetId: string;
      title?: string;
      placement?: 'inline' | 'panel';
      connectionCode?: string;
      data?: unknown;
      dataRef?: string;
      options?: Record<string, unknown>;
      state?: unknown;
      status?: 'streaming' | 'ready';
    };

export interface ViewMessage {
  id: string;
  role: 'user' | 'assistant';
  content: ContentBlock[];
  reasoning?: string;
  todos?: TodoItem[];
  ts: number;
  model?: string;
  skillIds?: string[];
  connectionCode?: string;
  error?: string;
  stopped?: boolean;
  durationMs?: number;
}

export interface HandoffContext {
  fromSessionId: string;
  fromTitle: string;
  summary: string;
  changedFiles?: string[];
  pendingTodos?: string[];
  activeDaemons?: string[];
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  depth: number;
  allowedTools?: string[];
  sessionId?: string;
  unattended?: boolean;
  emit: (ev: AgentEvent) => void;
  parentMessages?: ChatMessage[];
  outputSchema?: Record<string, unknown>;
}

/** 宿主工具运行时适配器：将工具注册、元信息分类与执行与内核解耦 */
export interface ToolRuntime {
  getSchemas(): Promise<ToolSchema[]> | ToolSchema[];
  execute(name: string, args: Record<string, unknown>, toolCallId: string, ctx: ToolExecutionContext): Promise<ToolResult>;
  authorize?(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    ctx: ToolExecutionContext,
  ): Promise<{ decision: 'allow' | 'deny'; reason?: string; rejectedByUser?: boolean }>;
  isReadOnly?(name: string): boolean;
  isMutating?(name: string, args: Record<string, unknown>): boolean;
  isPrunable?(name: string): boolean;
  getResourceAccess?(name: string, args: Record<string, unknown>): {
    lane?: 'subagent' | 'normal';
    reads: string[];
    writes: string[];
  };
  formatHistoryResult?(name: string, content: string, prunableCountInRound: number): string;
  summarizeCall?(name: string, args?: Record<string, unknown>, provided?: string): string;
  normalizeAskQuestions?(raw: unknown): AskQuestion[];
}
