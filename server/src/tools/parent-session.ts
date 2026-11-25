// search_parent_session：交接会话按需回查源会话历史细节（平时 0 上下文开销）。
import { assistantHistoryText, messageText, type ToolCallBlock, type ToolSchema, type ViewMessage } from '@paw/shared';
import { getSession } from '../db.js';

export const SEARCH_PARENT_SESSION_SCHEMA: ToolSchema = {
  name: 'search_parent_session',
  description: 'Search the parent (previous) session that handed off to this conversation. Use ONLY when you need specific details omitted from <handoff_context> (such as an exact error message, API response field, file path, or earlier decision). Supports keyword search or browsing the latest turns when query is empty.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords to search (space-separated, case-insensitive). Leave empty to view the latest turns of the parent session.' },
      limit: { type: 'number', description: 'Max matched messages to return (default 6, max 15)' },
      include_tools: { type: 'boolean', description: 'Also search inside tool call inputs/outputs (default true)' },
      summary: { type: 'string', description: '用简体中文简述要回查什么细节，20字以内' },
    },
  },
};

const MAX_SNIPPET_CHARS = 1200;

function stripBase64(s: string): string {
  return s.replace(/data:image\/[^)\s"']+/g, '[图片数据已省略]');
}

function buildSearchableText(m: ViewMessage, includeTools: boolean): string {
  const parts: string[] = [];
  const prose = messageText(m).trim();
  if (prose) parts.push(prose);
  if (includeTools && m.role === 'assistant') {
    for (const b of m.content || []) {
      if (b.type !== 'tool-call') continue;
      const t = b as ToolCallBlock;
      const argsText = t.args ? JSON.stringify(t.args) : '';
      const outText = typeof t.output === 'string' ? stripBase64(t.output) : '';
      const piece = `[tool:${t.name}${t.ok === false ? ' 失败' : ''}] ${argsText.slice(0, 300)}${outText ? `\n${outText}` : ''}`;
      parts.push(piece);
    }
  }
  return parts.join('\n\n');
}

function excerptAround(text: string, terms: string[]): string {
  if (text.length <= MAX_SNIPPET_CHARS) return text;
  const lower = text.toLowerCase();
  let firstHit = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (firstHit < 0 || idx < firstHit)) firstHit = idx;
  }
  if (firstHit < 0) return text.slice(0, MAX_SNIPPET_CHARS) + '…';
  const start = Math.max(0, firstHit - 300);
  const end = Math.min(text.length, start + MAX_SNIPPET_CHARS);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

export function executeSearchParentSession(
  args: Record<string, unknown>,
  parentSessionId?: string,
): string {
  if (!parentSessionId) {
    throw new Error('当前会话没有关联的交接源会话，无法回查。');
  }
  const session = getSession(parentSessionId);
  if (!session) {
    return `原会话（${parentSessionId}）不存在或已被删除。`;
  }
  const messages = session.messages || [];
  if (!messages.length) {
    return `原会话「${session.title}」没有任何历史消息。`;
  }

  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const limit = Math.min(15, Math.max(1, Number(args.limit) || 6));
  const includeTools = args.include_tools !== false;

  if (!query) {
    const recent = messages.slice(-limit);
    const offset = messages.length - recent.length;
    const formatted = recent.map((m, i) => {
      const role = m.role === 'user' ? '用户' : '助手';
      const body = m.role === 'assistant' ? assistantHistoryText(m) : messageText(m).trim();
      return `#${offset + i + 1} [${role}]\n${(body || '（无文本）').slice(0, MAX_SNIPPET_CHARS)}`;
    });
    return `原会话「${session.title}」（共 ${messages.length} 条消息，展示最近 ${recent.length} 条）：\n\n${formatted.join('\n\n---\n\n')}`;
  }

  const lowerQuery = query.toLowerCase();
  const terms = lowerQuery.split(/\s+/).filter(Boolean);
  const scored: { idx: number; score: number; role: string; snippet: string }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const hay = buildSearchableText(m, includeTools);
    if (!hay) continue;
    const lowerHay = hay.toLowerCase();
    let score = 0;
    if (lowerHay.includes(lowerQuery)) score += 3;
    for (const term of terms) {
      if (lowerHay.includes(term)) score += 1;
    }
    if (score > 0) {
      scored.push({
        idx: i + 1,
        score,
        role: m.role === 'user' ? '用户' : '助手',
        snippet: excerptAround(hay, terms),
      });
    }
  }

  if (!scored.length) {
    return `在原会话「${session.title}」（共 ${messages.length} 条消息）中未找到匹配「${query}」的内容。可换更短的关键词，或留空 query 浏览最近轮次。`;
  }

  scored.sort((a, b) => b.score - a.score || b.idx - a.idx);
  const top = scored.slice(0, limit).sort((a, b) => a.idx - b.idx);
  const lines = top.map((h) => `#${h.idx} [${h.role}]\n${h.snippet}`);
  return `原会话「${session.title}」命中 ${scored.length} 条（展示最相关的 ${top.length} 条）：\n\n${lines.join('\n\n---\n\n')}`;
}
