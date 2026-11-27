// Paw 宿主 ReAct 主循环适配（内核引擎在 @paw/kernel；工具元信息全部由 pawPlugins 声明）
import { CONTEXT_WINDOW_TOKENS, toolStepSummary, type AgentEvent, type ChatMessage } from '@paw/shared';
import {
  canonicalToolKey,
  parseToolArguments,
  runAgent as kernelRunAgent,
  type StreamChatFn,
  type ToolRuntime,
} from '@paw/kernel';
import { streamChat, type GatewayConfig } from '../gateway/client.js';
import { loadPersonaPrompt, withPersona } from '../persona.js';
import { loadWorkspaceBlock } from '../workspace.js';
import { getAllToolSchemas, executeTool } from '../tools/index.js';
import { isPrunableTool, pruneToolResult } from '../tools/prune.js';
import { normalizeQuestions } from '../tools/ask-user.js';
import { pawPlugins } from '../plugins/index.js';
import { dbCheckpointStore } from './session-context.js';

export { canonicalToolKey, parseToolArguments };

export function createPawToolRuntime(
  cfg: GatewayConfig,
  opts: {
    workspace?: string | null;
    parentSessionId?: string;
    connectionCode?: string;
    authorize?: ToolRuntime['authorize'];
  } = {},
): ToolRuntime {
  return {
    getSchemas: () => getAllToolSchemas(opts.workspace, { hasParentSession: !!opts.parentSessionId }),
    authorize: opts.authorize,
    execute: (name, args, toolCallId, ctx) => executeTool(name, args, toolCallId, {
      signal: ctx.signal,
      workspace: opts.workspace,
      depth: ctx.depth,
      allowedTools: ctx.allowedTools,
      sessionId: ctx.sessionId,
      parentSessionId: opts.parentSessionId,
      connectionCode: opts.connectionCode,
      gateway: cfg,
      emit: ctx.emit,
      parentMessages: ctx.parentMessages,
      outputSchema: ctx.outputSchema,
      authorize: opts.authorize,
    }),
    isReadOnly: (name) => pawPlugins.isReadOnly(name),
    isMutating: (name, args) => pawPlugins.isMutating(name, args),
    isPrunable: isPrunableTool,
    formatHistoryResult: (name, content, roundReads) => {
      if (pawPlugins.hasTool(name)) {
        return pawPlugins.formatHistoryResult(name, content, roundReads) ?? content;
      }
      if (isPrunableTool(name)) {
        return pruneToolResult(content, roundReads, name);
      }
      return content;
    },
    summarizeCall: toolStepSummary,
    normalizeAskQuestions: normalizeQuestions,
  };
}

export interface RunAgentOptions {
  images?: string[];
  signal?: AbortSignal;
  workspace?: string | null;
  depth?: number;
  allowedTools?: string[];
  maxRounds?: number;
  systemOverride?: string;
  sessionId?: string;
  parentSessionId?: string;
  turnId?: string;
  connectionCode?: string;
  rawHistory?: ChatMessage[];
  unattended?: boolean;
  outputSchema?: Record<string, unknown>;
  drainSteering?: () => string[];
  authorize?: ToolRuntime['authorize'];
}

export async function* runAgent(
  cfg: GatewayConfig,
  input: ChatMessage[],
  options: RunAgentOptions = {},
): AsyncGenerator<AgentEvent> {
  const { workspace, systemOverride, parentSessionId, connectionCode, authorize } = options;
  const persona = systemOverride ? '' : await loadPersonaPrompt(workspace);
  let resolvedSystemOverride = systemOverride;
  if (systemOverride) {
    const wsBlock = await loadWorkspaceBlock(workspace);
    resolvedSystemOverride = systemOverride + (wsBlock ? '\n\n' + wsBlock : '');
  }
  const provider: StreamChatFn = (s) => streamChat(cfg, s.messages, s.tools, s.images, s.signal);
  const tools = createPawToolRuntime(cfg, { workspace, parentSessionId, connectionCode, authorize });

  yield* kernelRunAgent({
    streamChat: provider,
    model: cfg.model,
    tools,
    store: dbCheckpointStore,
    input,
    images: options.images,
    signal: options.signal,
    depth: options.depth,
    allowedTools: options.allowedTools,
    maxRounds: options.maxRounds,
    windowTokens: CONTEXT_WINDOW_TOKENS,
    systemPrompt: persona || undefined,
    injectSystemPrompt: withPersona,
    systemOverride: resolvedSystemOverride,
    sessionId: options.sessionId,
    turnId: options.turnId,
    rawHistory: options.rawHistory,
    unattended: options.unattended,
    outputSchema: options.outputSchema,
    drainSteering: options.drainSteering,
  });
}
