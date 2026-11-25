// 子代理 Paw 宿主适配（核心编排在 @paw/kernel）
import type { AgentEvent, ChatMessage, ToolResult } from '@paw/shared';
import {
  forkContextBlock,
  runSubagent,
  validateSchema,
  type SubagentArgs,
} from '@paw/kernel';
import { streamChat, type GatewayConfig } from '../gateway/client.js';
import { loadWorkspaceBlock } from '../workspace.js';
import { upsertSession } from '../db.js';
import { loadSubagents } from './agents.js';
import { createPawToolRuntime } from './loop.js';
import { dbCheckpointStore } from './session-context.js';

export { validateSchema, type SubagentArgs };
export const validateSchemaForTest = (v: unknown, s: Record<string, unknown>) => validateSchema(v, s);
export const forkContextForTest = forkContextBlock;

export interface SubagentContext {
  cfg: GatewayConfig;
  workspace?: string | null;
  parentSignal?: AbortSignal;
  parentSessionId?: string;
  emit?: (ev: AgentEvent) => void;
  parentMessages?: ChatMessage[];
}

export async function runSubagentTool(
  args: SubagentArgs,
  toolCallId: string,
  ctx: SubagentContext,
): Promise<ToolResult> {
  const wsBlock = await loadWorkspaceBlock(ctx.workspace);
  return runSubagent(args, toolCallId, {
    loadDefs: () => loadSubagents(ctx.workspace),
    createStreamChat: (modelOverride) => {
      const subCfg: GatewayConfig = { ...ctx.cfg, model: modelOverride || ctx.cfg.model };
      return {
        model: subCfg.model,
        streamChat: (s) => streamChat(subCfg, s.messages, s.tools, s.images, s.signal),
      };
    },
    tools: createPawToolRuntime(ctx.cfg, { workspace: ctx.workspace }),
    workspacePrompt: wsBlock || undefined,
    store: dbCheckpointStore,
    parentSignal: ctx.parentSignal,
    parentSessionId: ctx.parentSessionId,
    emit: ctx.emit,
    parentMessages: ctx.parentMessages,
    onSessionSave: (record) => upsertSession({
      ...record,
      workspace: ctx.workspace || undefined,
    }),
  });
}
