import { createHash } from 'node:crypto';
import type { ChatMessage, CheckpointStore, StreamChatFn, ToolSchema } from './types.js';
import { compactMessages } from './context.js';

// 用模型实际能看到的历史核对检查点。编辑、回退或另一客户端的新分支不能沿用旧摘要。
export function prefixDigest(messages: ChatMessage[], count: number) {
  const hash = createHash('sha256');
  for (const m of messages.slice(0, count)) {
    hash.update(JSON.stringify([
      m.role,
      m.content,
      m.reasoning_content ?? '',
      m.tool_call_id ?? '',
      m.tool_calls ?? null,
    ]));
  }
  return hash.digest('hex');
}

function isValidToolCall(tc: unknown): tc is NonNullable<ChatMessage['tool_calls']>[number] {
  if (!tc || typeof tc !== 'object') return false;
  const c = tc as Record<string, unknown>;
  return typeof c.id === 'string' && c.id.length > 0
    && typeof c.name === 'string' && c.name.length > 0
    && typeof c.arguments === 'string';
}

export function isConversationHistory(messages: ChatMessage[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object' || typeof m.content !== 'string') return false;
    if (m.reasoning_content != null && typeof m.reasoning_content !== 'string') return false;
    if (m.role === 'user') {
      if (m.tool_calls || m.tool_call_id) return false;
      continue;
    }
    if (m.role === 'assistant') {
      if (m.tool_call_id) return false;
      if (m.tool_calls !== undefined) {
        if (!Array.isArray(m.tool_calls) || !m.tool_calls.length || !m.tool_calls.every(isValidToolCall)) return false;
        const pending = new Set(m.tool_calls.map((c) => c.id));
        if (pending.size !== m.tool_calls.length) return false;
        while (pending.size > 0) {
          const next = messages[++i];
          if (!next || next.role !== 'tool' || typeof next.content !== 'string'
              || typeof next.tool_call_id !== 'string' || !pending.delete(next.tool_call_id)
              || next.tool_calls) return false;
        }
      }
      continue;
    }
    return false;
  }
  return true;
}

export async function prepareSessionContext(
  streamChat: StreamChatFn,
  store: CheckpointStore,
  sessionId: string,
  raw: ChatMessage[],
  input: ChatMessage[],
  persona: ChatMessage | undefined,
  tools: ToolSchema[],
  options: { manual?: boolean; signal?: AbortSignal; images?: string[]; windowTokens?: number } = {},
) {
  const previous = store.getCheckpoint(sessionId);
  const valid = previous && previous.covered < raw.length && previous.digest === prefixDigest(raw, previous.covered);
  const covered = valid ? previous.covered : 0;
  const head: ChatMessage[] = persona ? [persona] : [];
  if (valid) head.push({ role: 'assistant', content: previous.summary });
  const messages = [...head, ...input.slice(covered)];
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  // 没有新完成的轮次时，重复 /compact 无需再次请求摘要模型。
  const historyEnd = lastUser > head.length ? lastUser : 0;
  const result = await compactMessages(streamChat, messages, tools, { ...options, historyEnd });
  let newlyCovered = 0;
  if (result.summary && result.cut !== undefined) {
    options.signal?.throwIfAborted();
    newlyCovered = result.cut - head.length;
    const nextCount = covered + newlyCovered;
    if (!store.saveCheckpoint(sessionId, previous, {
      covered: nextCount, digest: prefixDigest(raw, nextCount), summary: result.summary,
    }) && options.manual) throw new Error('会话上下文已更新，请重新执行 /compact。');
  }
  return { ...result, newlyCovered };
}
