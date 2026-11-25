// 会话存储：SQLite 为主（server），localStorage 做即时缓存/离线兜底。
// 类型定义在 shared，前后端共用。
import { assistantHistoryMessages, formatHandoffBlock, messageText, normalizeMessage, type ChatMessage, type Session, type ViewMessage } from '@paw/shared';

export type { ToolView, ViewMessage, Session } from '@paw/shared';

const KEY = 'paw.sessions.v1';

export function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Session[];
    if (!Array.isArray(arr)) return [];
    // 老缓存里 content 还是字符串（块模型之前写的），进来先归一化
    return arr.map((s) => ({ ...s, messages: (s.messages || []).map((m) => normalizeMessage(m as unknown as Record<string, unknown>)) }));
  } catch {
    return [];
  }
}

export function saveSessions(sessions: Session[]): void {
  try {
    // localStorage 只做离线兜底，SQLite 才是真相源。瘦身规则：
    // - 只留最近 100 个会话；
    // - 附件正文置空（base64 有几 MB）；
    // - 工具输出里含内嵌图片（生图 base64）的也置空，避免缓存写入卡主线程。
    const lite = sessions.slice(0, 100).map((s) => ({
      ...s,
      messages: s.messages.map((m: ViewMessage) => ({
        ...m,
        attachments: m.attachments?.map((a) => ({ ...a, content: '' })),
        // 生图结果含几 MB base64：缓存里只留卡片不留正文（SQLite 才是真相源）
        content: m.content.map((b) =>
          b.type === 'tool-call' && b.output?.includes('data:image/') ? { ...b, output: undefined } : b),
      })),
    }));
    localStorage.setItem(KEY, JSON.stringify(lite));
  } catch {
    /* 超配额就算了，SQLite 才是真相源 */
  }
}

/** 最近几轮带工具调用的助手消息保留精简后的真实 tool_calls + tool 结果对 */
const RECENT_TOOL_HISTORY_TURNS = 4;

/** ViewMessage[] → 网关 ChatMessage[]（最近几轮保留精简真实 tool_calls，更早轮次只保留最终回复） */
export function toChatMessages(messages: ViewMessage[]): ChatMessage[] {
  const valid = messages.filter((m) => m.content.length || m.attachments?.length || m.handoff?.summary);
  // 找出最后 RECENT_TOOL_HISTORY_TURNS 条包含工具调用的 assistant 索引
  const recentToolIndices = new Set<number>();
  for (let i = valid.length - 1; i >= 0 && recentToolIndices.size < RECENT_TOOL_HISTORY_TURNS; i--) {
    const m = valid[i];
    if (m.role === 'assistant' && m.content.some((b) => b.type === 'tool-call')) {
      recentToolIndices.add(i);
    }
  }

  const out: ChatMessage[] = [];
  for (let i = 0; i < valid.length; i++) {
    const m = valid[i];
    if (m.role === 'user') {
      // 附件引用拼回：只给**正文里没有占位符**的旧消息用。
      // 新消息的正文（编辑器序列化）已经原位带 `@"文件名"` 占位符，
      // 再拼一遍就是「文件发两遍」——server 的 replace 会把两遍都命中（2026-11-22 实锤）
      const text = messageText(m);
      const atts = m.attachments ?? [];
      const hasPlaceholders = atts.some((a) => text.includes(`@"${a.name}"`));
      const refs = atts.length && !hasPlaceholders
        ? '\n' + atts.map((a) =>
            a.kind === 'image' ? `@image:${a.name}` : `@"${a.name}"`
          ).join(' ')
        : '';
      const skillRefs = m.skillIds?.length ? '\n' + m.skillIds.map((id) => `@skill:${id}`).join(' ') : '';
      const handoffPrefix = m.handoff?.summary ? formatHandoffBlock(m.handoff) + '\n\n' : '';
      out.push({ role: 'user', content: handoffPrefix + text + refs + skillRefs });
      continue;
    }
    // 跨轮次不回传旧 reasoning_content（遵循 DeepSeek/GLM 多轮规范，避免思维链在长会话累积 20w+ token）；
    // 最近几轮保留真实精简 tool_calls + tool 对，更早轮次只保留最终回复，不再把 `[本轮工具记录：...]` 拼进 assistant 正文。
    out.push(...assistantHistoryMessages(m, {
      includeToolCalls: recentToolIndices.has(i),
      turnIndex: i,
    }));
  }
  return out;
}
