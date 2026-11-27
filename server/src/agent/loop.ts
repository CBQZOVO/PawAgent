// Paw 宿主 ReAct 主循环适配（内核引擎在 @paw/kernel；工具元信息全部由 pawPlugins 声明）
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTEXT_WINDOW_TOKENS, toolStepSummary, type AgentEvent, type ChatMessage } from '@paw/shared';
import {
  canonicalToolKey,
  isSafeReadOnlyShellCommand,
  parseToolArguments,
  runAgent as kernelRunAgent,
  type StreamChatFn,
  type ToolResourceAccess,
  type ToolRuntime,
} from '@paw/kernel';
import { streamChat, type GatewayConfig } from '../gateway/client.js';
import { loadPersonaPrompt, withPersona } from '../persona.js';
import { loadWorkspaceBlock } from '../workspace.js';
import { getAllToolSchemas, executeTool } from '../tools/index.js';
import { isPrunableTool, pruneToolResult } from '../tools/prune.js';
import { normalizeQuestions } from '../tools/ask-user.js';
import { pawPlugins } from '../plugins/index.js';
import { isMcpToolReadOnly } from '../mcp.js';
import { dbCheckpointStore } from './session-context.js';

export { canonicalToolKey, parseToolArguments };

/** 纯元信息/外部只读工具：完全不碰本地工作区文件，与任何文件读写都零冲突，可任意并发 */
const ISOLATED_META_READONLY_TOOLS = new Set([
  'todo_write',
  'web_search',
  'web_fetch',
  'search_parent_session',
  'memory_search',
  'worklog_list',
  'load_skill',
  'list_skills',
]);

/**
 * 把路径解析为磁盘真实路径（解开软链接）：
 * 例如 macOS 上 /tmp 其实是 /private/tmp 的软链接，如果不解开，
 * `write_file('/tmp/a.ts')` 和 `read_file('/private/tmp/a.ts')` 会被当成两个不同文件而并发冲突。
 */
function resolveCanonicalPath(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    // 如果目标文件还没创建（如新建文件），就一层层往上找最近已存在的父目录解开软链，再把尾段拼回去
    const tail: string[] = [];
    let cur = absPath;
    while (true) {
      const parent = path.dirname(cur);
      if (parent === cur) return absPath;
      tail.unshift(path.basename(cur));
      try {
        const realParent = realpathSync(parent);
        return path.join(realParent, ...tail);
      } catch {
        cur = parent;
      }
    }
  }
}

/**
 * 把工具参数里的文件路径统一归一化成资源锁键（`file:<canonicalPath>`）：
 * - 展开 `~/` 家目录与相对路径；
 * - 解开软链接；
 * - Windows 和 macOS（默认 APFS）大小写不敏感，统一转小写，防止 `Foo.ts` 与 `foo.ts` 并发写同一个文件。
 */
function normalizeFileResourceKey(rawPath: unknown, workspace?: string | null): string | null {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const trimmed = rawPath.trim();
  const expanded = trimmed === '~'
    ? os.homedir()
    : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed;
  const base = workspace ? path.resolve(workspace) : process.cwd();
  const abs = path.resolve(base, expanded);
  const canonical = resolveCanonicalPath(abs);
  const norm = process.platform === 'win32' || process.platform === 'darwin'
    ? canonical.toLowerCase()
    : canonical;
  return `file:${norm}`;
}

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
      turnId: ctx.turnId,
      parentSessionId: opts.parentSessionId,
      connectionCode: opts.connectionCode,
      gateway: cfg,
      emit: ctx.emit,
      parentMessages: ctx.parentMessages,
      outputSchema: ctx.outputSchema,
      authorize: opts.authorize,
    }),
    isReadOnly: (name) => pawPlugins.isReadOnly(name) || isMcpToolReadOnly(name),
    isMutating: (name, args) => pawPlugins.isMutating(name, args),
    isPrunable: isPrunableTool,
    /**
     * 告诉内核 DAG 调度器每个工具会「读哪些资源、写哪些资源」：
     * - edit_file / write_file / delete_file 只锁自己的单文件路径，改不同文件可安全并发；
     * - read_file 只读自己的单文件路径，与改其他文件互不阻塞；
     * - run_command 只有被全称谓词证明是前台只读命令时才视作只读，否则作为全局写屏障（writes: ['*']）独占串行。
     */
    getResourceAccess: (name, args): ToolResourceAccess => {
      if (name === 'subagent') return { lane: 'subagent', reads: ['*'], writes: [] };
      if (ISOLATED_META_READONLY_TOOLS.has(name)) return { lane: 'normal', reads: [], writes: [] };
      if (name === 'read_file') {
        const key = normalizeFileResourceKey(args.path, opts.workspace);
        return { lane: 'normal', reads: [key ?? '*'], writes: [] };
      }
      if (name === 'write_file' || name === 'edit_file' || name === 'delete_file') {
        const key = normalizeFileResourceKey(args.path, opts.workspace);
        return key
          ? { lane: 'normal', reads: [key], writes: [key] }
          : { lane: 'normal', reads: ['*'], writes: ['*'] };
      }
      if (name === 'run_command') {
        const safeShell = !args.daemon && !args.background && typeof args.cmd === 'string' && isSafeReadOnlyShellCommand(args.cmd);
        return safeShell
          ? { lane: 'normal', reads: ['*'], writes: [] }
          : { lane: 'normal', reads: ['*'], writes: ['*'] };
      }
      if (pawPlugins.isReadOnly(name) || isMcpToolReadOnly(name) || (name === 'call_api' && !pawPlugins.isMutating('call_api', args))) {
        return { lane: 'normal', reads: ['*'], writes: [] };
      }
      return { lane: 'normal', reads: ['*'], writes: ['*'] };
    },
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
  extraSystemNote?: string;
}

export async function* runAgent(
  cfg: GatewayConfig,
  input: ChatMessage[],
  options: RunAgentOptions = {},
): AsyncGenerator<AgentEvent> {
  const { workspace, systemOverride, parentSessionId, connectionCode, authorize, extraSystemNote } = options;
  const basePersona = systemOverride ? '' : await loadPersonaPrompt(workspace);
  const persona = basePersona && extraSystemNote
    ? `${basePersona}\n\n${extraSystemNote}`
    : (basePersona || extraSystemNote || '');
  let resolvedSystemOverride = systemOverride;
  if (systemOverride) {
    const wsBlock = await loadWorkspaceBlock(workspace);
    resolvedSystemOverride = systemOverride
      + (wsBlock ? '\n\n' + wsBlock : '')
      + (extraSystemNote ? '\n\n' + extraSystemNote : '');
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
