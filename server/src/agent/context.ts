import { CONTEXT_WINDOW_TOKENS, type ChatMessage, type ToolSchema } from '@paw/shared';
import {
  compactMessages as kernelCompactMessages,
  inspectContext as kernelInspectContext,
  type CompactResult,
  type StreamChatFn,
} from '@paw/kernel';
import { streamChat, type GatewayConfig } from '../gateway/client.js';

export function inspectContext(messages: ChatMessage[], tools: ToolSchema[], images: string[] = []) {
  return kernelInspectContext(messages, tools, images, CONTEXT_WINDOW_TOKENS);
}

export async function compactMessages(
  cfg: GatewayConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  options: {
    manual?: boolean;
    signal?: AbortSignal;
    images?: string[];
    historyEnd?: number;
    stream?: typeof streamChat;
  } = {},
): Promise<CompactResult> {
  const streamFn = options.stream ?? streamChat;
  const provider: StreamChatFn = (opts) => streamFn(cfg, opts.messages, opts.tools, opts.images, opts.signal);
  return kernelCompactMessages(provider, messages, tools, {
    manual: options.manual,
    signal: options.signal,
    images: options.images,
    historyEnd: options.historyEnd,
    windowTokens: CONTEXT_WINDOW_TOKENS,
  });
}
