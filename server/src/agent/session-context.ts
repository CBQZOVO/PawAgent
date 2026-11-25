import { CONTEXT_WINDOW_TOKENS, type ChatMessage, type ToolSchema } from '@paw/shared';
import {
  isConversationHistory,
  prefixDigest,
  prepareSessionContext as kernelPrepareSessionContext,
  type CheckpointStore,
  type StreamChatFn,
} from '@paw/kernel';
import { addContextSample, getContextCheckpoint, saveContextCheckpoint } from '../db.js';
import { streamChat, type GatewayConfig } from '../gateway/client.js';

export { isConversationHistory, prefixDigest };

export const dbCheckpointStore: CheckpointStore = {
  getCheckpoint: (sessionId) => getContextCheckpoint(sessionId),
  saveCheckpoint: (sessionId, previous, next) => saveContextCheckpoint(sessionId, previous ?? null, next),
  addSample: (sessionId, sample) => addContextSample(sessionId, sample),
};

export async function prepareSessionContext(
  cfg: GatewayConfig,
  sessionId: string,
  raw: ChatMessage[],
  input: ChatMessage[],
  persona: ChatMessage | undefined,
  tools: ToolSchema[],
  options: { manual?: boolean; signal?: AbortSignal; images?: string[] } = {},
) {
  const provider: StreamChatFn = (opts) => streamChat(cfg, opts.messages, opts.tools, opts.images, opts.signal);
  return kernelPrepareSessionContext(provider, dbCheckpointStore, sessionId, raw, input, persona, tools, {
    ...options,
    windowTokens: CONTEXT_WINDOW_TOKENS,
  });
}
