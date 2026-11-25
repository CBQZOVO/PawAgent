// 把 AgentEvent 归集到 ViewMessage.content 块数组：
// 正文紧接上一块追加，工具插入独立块并按 id 回填结果。
import type { ToolCallBlock, ViewMessage } from './types.js';

export function appendText(msg: ViewMessage, delta: string): void {
  const last = msg.content[msg.content.length - 1];
  if (last && last.type === 'text') (last as { type: 'text'; text: string }).text += delta;
  else msg.content.push({ type: 'text', text: delta });
}

export function appendTool(msg: ViewMessage, tool: ToolCallBlock): void {
  msg.content.push(tool);
}

export function setToolResult(msg: ViewMessage, id: string, ok: boolean, output: string): void {
  const b = msg.content.find((x): x is ToolCallBlock => x.type === 'tool-call' && x.id === id);
  if (!b) return;
  b.ok = ok;
  b.output = output;
}
