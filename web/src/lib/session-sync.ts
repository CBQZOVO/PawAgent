// 会话合并与流式事件归位的纯函数（便于单测覆盖启动竞态与并行子代理场景）。
import { toolStepSummary, type AgentEvent, type ContentBlock, type Session, type ViewMessage } from '@paw/shared';

type ToolBlock = Extract<ContentBlock, { type: 'tool-call' }>;

const isToolBlock = (b: ContentBlock): b is ToolBlock => b.type === 'tool-call';

/**
 * tool_done 归位：只更新 ok；普通工具写 output，子代理卡片不写。
 * 子代理正文由 subagent_done 按 runId 写入；外层 id 来自网关 tool_call id，
 * 并行时可能重复，用它写 output 会把后完成的结论串进另一张卡片。
 */
export function applyToolDone(blocks: ContentBlock[], ev: Extract<AgentEvent, { type: 'tool_done' }>): ContentBlock[] {
  const i = blocks.findIndex((b) => b.type === 'tool-call' && b.id === ev.id);
  if (i < 0) return blocks;
  const hit = blocks[i] as ToolBlock;
  const out = [...blocks];
  out[i] = hit.subagent ? { ...hit, ok: ev.ok } : { ...hit, ok: ev.ok, output: ev.output };
  return out;
}

/** 将一批流式事件顺序应用到单条 assistant 消息上（帧级批量合并时只克隆一次消息结构） */
export function applyEventsToMessage(hit: ViewMessage, events: AgentEvent[]): ViewMessage {
  if (!events.length) return hit;
  const m: ViewMessage = { ...hit, content: [...hit.content] };
  for (const ev of events) {
    if (ev.type === 'subagent_start' || ev.type === 'subagent_event' || ev.type === 'subagent_done') {
      const id = ev.id;
      let i = -1;
      if (ev.type === 'subagent_start') {
        if (ev.toolCallId) i = m.content.findIndex((b) => isToolBlock(b) && b.id === ev.toolCallId);
        if (i < 0) i = m.content.findIndex((b) => isToolBlock(b) && b.name === 'subagent' && !b.subagent);
        if (i < 0) {
          m.content.push({ type: 'tool-call', id: ev.toolCallId || id, name: 'subagent', summary: ev.name });
          i = m.content.length - 1;
        }
      } else {
        i = m.content.findIndex((b) => isToolBlock(b) && b.subagent?.id === id);
      }
      if (i < 0) continue;
      const cur = m.content[i];
      if (!isToolBlock(cur)) continue;
      const t: ToolBlock = { ...cur };
      if (ev.type === 'subagent_start') {
        t.subagent = { id, name: ev.name, agentName: ev.agentName, status: 'running', steps: [] };
      } else if (ev.type === 'subagent_event' && t.subagent) {
        const sub = { ...t.subagent, steps: [...t.subagent.steps] };
        const inner = ev.event;
        if (inner.type === 'text') {
          const lastStep = sub.steps[sub.steps.length - 1];
          if (lastStep?.kind === 'text') sub.steps[sub.steps.length - 1] = { ...lastStep, text: lastStep.text + inner.delta };
          else sub.steps.push({ kind: 'text', text: inner.delta });
        } else if (inner.type === 'tool_start') {
          sub.steps.push({
            id: inner.id,
            kind: 'tool',
            text: toolStepSummary(inner.name, inner.args, inner.summary),
            tool: inner.name,
          });
        } else if (inner.type === 'tool_done') {
          let j = inner.id ? sub.steps.findIndex((x) => x.kind === 'tool' && x.id === inner.id) : -1;
          if (j < 0) j = sub.steps.findIndex((x) => x.kind === 'tool' && x.tool === inner.name && x.ok === undefined);
          if (j >= 0) sub.steps[j] = { ...sub.steps[j], ok: inner.ok };
        }
        if (sub.steps.length > 40) sub.steps = sub.steps.slice(-40);
        t.subagent = sub;
      } else if (ev.type === 'subagent_done' && t.subagent) {
        t.subagent = { ...t.subagent, status: ev.status, seconds: ev.seconds, rounds: ev.rounds, tokens: ev.tokens };
        t.ok = ev.status === 'completed' || ev.status === 'limit';
        t.output = ev.summary;
      }
      m.content[i] = t;
      continue;
    }
    if (ev.type === 'ask') {
      m.content.push({ type: 'ask', questions: ev.questions });
      continue;
    }
    switch (ev.type) {
      case 'reasoning': m.reasoning = (m.reasoning || '') + ev.delta; break;
      case 'text': {
        const lastB = m.content[m.content.length - 1];
        if (lastB?.type === 'text') m.content[m.content.length - 1] = { type: 'text', text: lastB.text + ev.delta };
        else m.content.push({ type: 'text', text: ev.delta });
        break;
      }
      case 'tool_start': {
        m.content.push({ type: 'tool-call', id: ev.id, name: ev.name, summary: ev.summary, args: ev.args });
        if (ev.name === 'todo_write' && Array.isArray(ev.args?.todos)) {
          m.todos = (ev.args.todos as { content?: unknown; status?: unknown }[])
            .filter((t) => typeof t?.content === 'string')
            .map((t) => ({
              content: String(t.content),
              status: (t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending') as 'pending' | 'in_progress' | 'completed',
            }));
        }
        break;
      }
      case 'tool_progress': {
        const i = m.content.findIndex((b) => isToolBlock(b) && b.id === ev.id);
        const cur = i >= 0 ? m.content[i] : undefined;
        if (cur && isToolBlock(cur)) m.content[i] = { ...cur, progress: ev.progress };
        break;
      }
      case 'tool_done': m.content = applyToolDone(m.content, ev); break;
      case 'error': m.error = (m.error ? m.error + '\n' : '') + ev.message; break;
      default: break;
    }
  }
  return m;
}

/**
 * 启动合并：服务端列表是真相源。
 * - 两边都有 → 用服务端版本；
 * - 只有服务端 → 保留；
 * - 只有本地且是本次页面新建的 → 保留（等推送）；
 * - 只有本地且不是本次新建 → 服务端已删除，丢弃（旧缓存不得让已删会话复活）。
 * 返回顺序：本地新建的在前（新会话排最上），其余按服务端顺序。
 */
export function mergeSessions(server: Session[], local: Session[], createdThisMount: Set<string>): Session[] {
  const byId = new Map(server.map((s) => [s.id, s]));
  const out: Session[] = [...server];
  for (let i = local.length - 1; i >= 0; i--) {
    const s = local[i];
    if (!byId.has(s.id) && createdThisMount.has(s.id)) {
      out.unshift(s);
      byId.set(s.id, s);
    }
  }
  return out;
}
