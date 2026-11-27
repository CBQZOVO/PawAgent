// todo_write：支持可选有向无环图（DAG）前置依赖的多步任务清单。
// 全量覆盖语义：模型每次传完整清单，前端渲染成进度卡片；
// 若声明了 id / dependsOn，自动运行 Kahn 拓扑分层与三色 DFS 环检测，拦截循环依赖并计算可并发就绪前沿。
import type { ToolSchema, TodoItem } from '@paw/shared';
import { topologicalLayers } from '@paw/kernel';

const MAX_TODOS = 30;
const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export const TODO_TOOL_SCHEMA: ToolSchema = {
  name: 'todo_write',
  description: 'Create/update the task checklist for a multi-step job. Pass the FULL list every time (it replaces the previous one). '
    + 'Optional DAG scheduling: assign unique `id` (e.g. "t1") and `dependsOn` (array of prerequisite ids) to model task dependencies; '
    + 'cyclic dependencies are automatically rejected and ready-to-run parallel tasks (in-degree 0) are highlighted. '
    + 'Mark active item(s) in_progress while working on them (multiple allowed when running parallel tracks/subagents), and flip each to completed as soon as it is done. '
    + 'Before you write your final answer, the list must contain no pending or in_progress item: '
    + 'mark everything you actually finished as completed; for anything you deliberately skipped, '
    + 'say so in the answer rather than leaving it hanging. '
    + 'Use for any task with 3+ distinct steps so the user can see progress; skip it for trivial single-step tasks.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Full checklist. Each item: {id?: string, content: string, status: "pending"|"in_progress"|"completed", dependsOn?: string[]}',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Optional unique step identifier (e.g. "step-1") for dependency DAG edges' },
            content: { type: 'string', description: 'Short imperative task description' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional list of prerequisite step `id`s that must complete before this step starts',
            },
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

  const seenExplicitIds = new Set<string>();
  let hasDagEdges = false;

  const prelim = raw.map((t, i) => {
    const item = t as Record<string, unknown>;
    const content = String(item?.content || '').trim();
    const status = String(item?.status || '');
    if (!content) throw new Error(`第 ${i + 1} 项 content 为空`);
    if (!STATUSES.has(status)) {
      throw new Error(`第 ${i + 1} 项 status 无效: ${status}（只能是 pending/in_progress/completed）`);
    }

    const explicitId = typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
    if (explicitId) {
      if (seenExplicitIds.has(explicitId)) {
        throw new Error(`第 ${i + 1} 项任务 id 重复: "${explicitId}"`);
      }
      seenExplicitIds.add(explicitId);
    }
    const dependsOn = Array.isArray(item?.dependsOn)
      ? [...new Set(item.dependsOn.filter((d): d is string => typeof d === 'string' && !!d.trim()).map((d) => d.trim()))]
      : undefined;
    if (dependsOn?.length) hasDagEdges = true;
    return { explicitId, content, status: status as TodoItem['status'], dependsOn };
  });

  // 为没有显式填 id 的条目分配不与显式 id 碰撞的隐式编号（如 #1、#2）
  const usedIds = new Set(seenExplicitIds);
  const todos: Array<TodoItem & { resolvedId: string }> = prelim.map((item, i) => {
    let resolvedId = item.explicitId;
    if (!resolvedId) {
      let cand = `#${i + 1}`;
      let suffix = 1;
      while (usedIds.has(cand)) cand = `#${i + 1}_${suffix++}`;
      resolvedId = cand;
      usedIds.add(cand);
    }
    return {
      ...(item.explicitId ? { id: item.explicitId } : {}),
      resolvedId,
      content: item.content,
      status: item.status,
      ...(item.dependsOn?.length ? { dependsOn: item.dependsOn } : {}),
    };
  });

  // 如果清单里用到了 id / dependsOn，跑一次拓扑排序：
  // 1) 拦截引用了不存在前置任务的悬空依赖；
  // 2) 拦截 A->B->A 这类循环依赖（直接抛错让模型重排计划）；
  // 3) 计算出「执行波次（Wave 1 -> Wave 2）」和「当前所有前置已完成、可立刻并行开工的就绪项」。
  let dagNotes = '';
  if (hasDagEdges || seenExplicitIds.size > 0) {
    const topo = topologicalLayers(
      todos,
      (t) => t.resolvedId,
      (t) => t.dependsOn ?? [],
    );
    if (topo.missingDeps.length > 0) {
      const m = topo.missingDeps[0];
      throw new Error(`任务 "${m.id}" 依赖了不存在的前置任务 id: "${m.missing}"`);
    }
    if (topo.cycles.length > 0) {
      const ring = topo.cycles[0].join(' -> ');
      throw new Error(`任务清单存在循环依赖（DAG 校验拒绝）：${ring}`);
    }

    if (hasDagEdges) {
      const byId = new Map(todos.map((t) => [t.resolvedId, t]));
      const premature: string[] = []; // 前置还没完成却提前标了 in_progress / completed 的项
      const ready: string[] = [];     // 当前入度=0（所有前置都已完成）的待办项

      for (const t of todos) {
        const unfinishedDeps = (t.dependsOn ?? []).filter((d) => byId.get(d)?.status !== 'completed');
        if (t.status !== 'pending' && unfinishedDeps.length > 0) {
          premature.push(`${t.resolvedId}（前置未完成: ${unfinishedDeps.join(', ')}）`);
        }
        if (t.status === 'pending' && unfinishedDeps.length === 0) {
          ready.push(`${t.resolvedId}: ${t.content}`);
        }
      }

      const waveDesc = topo.layers
        .map((layer, w) => `Wave ${w + 1}: [${layer.map((x) => x.resolvedId).join(', ')}]`)
        .join(' → ');
      const parts = [`拓扑执行波次：${waveDesc}`];
      if (ready.length > 0) {
        parts.push(`当前就绪可并行项（入度=0）：${ready.join('；')}`);
      }
      if (premature.length > 0) {
        parts.push(`⚠️ 依赖顺序提醒：${premature.join('；')}`);
      }
      dagNotes = '\n' + parts.join('\n');
    }
  }

  const done = todos.filter((t) => t.status === 'completed').length;
  const lines = todos.map((t) => {
    const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
    const idTag = t.id ? `[${t.id}] ` : '';
    const depTag = t.dependsOn?.length ? ` (依赖: ${t.dependsOn.join(', ')})` : '';
    return `${icon} ${idTag}${t.content}${depTag}`;
  });
  return `清单已更新（${done}/${todos.length} 完成）\n${lines.join('\n')}${dagNotes}`;
}
