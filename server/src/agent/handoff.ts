// 会话交接 Paw 宿主适配（核心双层提取逻辑在 @paw/kernel）
import type { ChatMessage, ViewMessage } from '@paw/shared';
import {
  extractDeterministicState as kernelExtractDeterministicState,
  generateHandoffBrief as kernelGenerateHandoffBrief,
  type DeterministicHandoffState,
  type HandoffGenerateResult,
  type StreamChatFn,
} from '@paw/kernel';
import { streamChat, type GatewayConfig } from '../gateway/client.js';
import { getRunningDaemons } from '../tools/background.js';
import { dbCheckpointStore } from './session-context.js';

export type { DeterministicHandoffState, HandoffGenerateResult };

export function extractDeterministicState(
  viewMessages: ViewMessage[],
  activeDaemons: string[] = getRunningDaemons(),
): DeterministicHandoffState {
  return kernelExtractDeterministicState(viewMessages, activeDaemons);
}

export interface HandoffGenerateOptions {
  sessionId: string;
  sessionTitle: string;
  chatMessages: ChatMessage[];
  viewMessages?: ViewMessage[];
  goal?: string;
  workspace?: string | null;
  signal?: AbortSignal;
  stream?: typeof streamChat;
}

export async function generateHandoffBrief(
  cfg: GatewayConfig,
  opts: HandoffGenerateOptions,
): Promise<HandoffGenerateResult> {
  const streamFn = opts.stream ?? streamChat;
  const provider: StreamChatFn = (s) => streamFn(cfg, s.messages, s.tools, s.images, s.signal);
  return kernelGenerateHandoffBrief(provider, {
    sessionId: opts.sessionId,
    sessionTitle: opts.sessionTitle,
    chatMessages: opts.chatMessages,
    viewMessages: opts.viewMessages,
    activeDaemons: getRunningDaemons(),
    defaultModel: cfg.model,
    goal: opts.goal,
    workspace: opts.workspace,
    signal: opts.signal,
    store: dbCheckpointStore,
  });
}
