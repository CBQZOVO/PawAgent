// todo_write：多步任务清单。对标 Qoder TodoWrite / dsh todo_write。
// 全量覆盖语义：模型每次传完整清单，前端渲染成进度卡片（勾选动画）。
// 工具本身只校验+回显；清单数据走 tool_start args → 前端 ToolCard 渲染。
import type { ToolSchema, TodoItem } from '@paw/shared';

const MAX_TODOS = 30;
const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export const TODO_TOOL_SCHEMA: ToolSchema = {
  name: 'todo_write',
  description: 'Create/update the task checklist for a multi-step job. Pass the FULL list every time (it replaces the previous one). '
    + 'Mark exactly one item in_progress while working on it, and flip it to completed the moment it is done. '
    // 收尾条款：不写清楚，模型正文写完就停手，清单永远停在 9/11（CodeBuddy 也栽在这）
    + 'Before you write your final answer, the list must contain no pending or in_progress item: '
    + 'mark everything you actually finished as completed; for anything you deliberately skipped, '
    + 'say so in the answer rather than leaving it hanging. '
    + 'Use for any task with 3+ distinct steps so the user can see progress; skip it for trivial single-step tasks.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Full checklist. Each item: {content: string, status: "pending"|"in_progress"|"completed"}',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Short imperative task description' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
      summary: { type: 'string', description: '用简体中文简述当前进展，20字以内' },
    },
    required: ['todos'],
  },
};

export function executeTodoWrite(args: Record<string, unknown>): string {
  const raw = Array.isArray(args.todos) ? args.todos : [];
  if (!raw.length) throw new Error('todos 不能为空数组');
  if (raw.length > MAX_TODOS) throw new Error(`清单最多 ${MAX_TODOS} 项，拆小任务`);
  const todos: TodoItem[] = raw.map((t, i) => {
    const item = t as Record<string, unknown>;
    const content = String(item?.content || '').trim();
    const status = String(item?.status || '');
    if (!content) throw new Error(`第 ${i + 1} 项 content 为空`);
    if (!STATUSES.has(status)) throw new Error(`第 ${i + 1} 项 status 无效: ${status}（只能是 pending/in_progress/completed）`);
    return { content, status: status as TodoItem['status'] };
  });
  const doing = todos.filter((t) => t.status === 'in_progress').length;
  if (doing > 1) throw new Error('同一时间只能有 1 项 in_progress');
  const done = todos.filter((t) => t.status === 'completed').length;
  const lines = todos.map((t) => `${t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'} ${t.content}`);
  return `清单已更新（${done}/${todos.length} 完成）\n${lines.join('\n')}`;
}