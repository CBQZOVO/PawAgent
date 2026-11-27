// ReAct 主循环内核：调模型 → 解析 tool_calls → 因果分批执行 → 裁剪回填 → 再调，直到收尾。
// 零宿主耦合：模型流、工具运行时、持久化检查点、人设注入均通过 RunAgentParams 注入。
import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ChatMessage,
  CheckpointStore,
  StreamChatFn,
  TodoItem,
  ToolCall,
  ToolResult,
  ToolRuntime,
} from './types.js';
import { compactMessages } from './context.js';
import { isConversationHistory, prepareSessionContext } from './session-context.js';
import { pruneToolResult } from './prune.js';
import { AsyncQueue } from './queue.js';
import { scheduleToolBatches, type ToolResourceAccess } from './dag.js';

const DEFAULT_MAX_ROUNDS = Math.max(4, Number(process.env.PAW_MAX_ROUNDS) || 200);
const REPEAT_REMIND_AT = [3, 5, 8];
const DEFAULT_MAX_PARALLEL_CALLS = 10;
const DEFAULT_MAX_PARALLEL_SUBAGENTS = 4;

/** 解析工具 JSON 参数：必须是普通键值对象，拒绝数组/null/原始值 */
export function parseToolArguments(raw: string): { args: Record<string, unknown>; bad: boolean } {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, bad: false };
    }
    return { args: {}, bad: true };
  } catch {
    return { args: {}, bad: true };
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const entries = Object.keys(obj).sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return '{' + entries.join(',') + '}';
}

/** 归一化工具调用签名：剔除仅用于 UI 展示的 summary 字段并按 key 排序 */
export function canonicalToolKey(name: string, raw: string): string {
  const { args, bad } = parseToolArguments(raw);
  if (bad) return `${name}\u0000RAW:${(raw || '').trim()}`;
  const { summary: _uiOnly, ...rest } = args;
  return `${name}\u0000${stableStringify(rest)}`;
}

function repeatReminder(toolName: string, count: number): string {
  if (count <= REPEAT_REMIND_AT[0]) {
    return '你在用完全相同的参数重复调用同一个工具。先仔细看上一次的结果：如果任务没完成，换一个思路或换参数，不要重复同一个调用。';
  }
  return `重复调用提醒：工具 \`${toolName}\` 已经累计 ${count} 次使用同一份参数且期间没有任何状态推进。不要再这样调用它了——看最新结果，换动作、换参数，或者证据够了就直接收尾给结论。`;
}

export interface RunAgentParams {
  streamChat: StreamChatFn;
  model: string;
  tools: ToolRuntime;
  input: ChatMessage[];
  store?: CheckpointStore;
  images?: string[];
  signal?: AbortSignal;
  depth?: number;
  allowedTools?: string[];
  maxRounds?: number;
  maxParallelCalls?: number;
  maxParallelSubagents?: number;
  windowTokens?: number;
  /** 主代理固定人设/系统提示（不参与压缩） */
  systemPrompt?: string;
  /** 可选自定义人设注入方式（例如注入到首条 user 消息）；缺省直接作为 system 消息发送 */
  injectSystemPrompt?: (messages: ChatMessage[], prompt: string) => ChatMessage[];
  /** 子代理 system prompt（直接置顶为 system 消息，不走 systemPrompt/injectSystemPrompt） */
  systemOverride?: string;
  sessionId?: string;
  turnId?: string;
  rawHistory?: ChatMessage[];
  unattended?: boolean;
  outputSchema?: Record<string, unknown>;
  /** 运行中拉取用户强行提醒（插话）消息队列；每次调用清空并返回待注入内容 */
  drainSteering?: () => string[];
}

export async function* runAgent(params: RunAgentParams): AsyncGenerator<AgentEvent> {
  const {
    streamChat,
    model,
    tools,
    input,
    store,
    images,
    signal,
    depth = 0,
    allowedTools,
    systemPrompt,
    injectSystemPrompt,
    systemOverride,
    sessionId,
    turnId,
    rawHistory,
    unattended,
    outputSchema,
    windowTokens,
    drainSteering,
  } = params;
  const maxRounds = params.maxRounds || DEFAULT_MAX_ROUNDS;
  const maxParallelCalls = params.maxParallelCalls || DEFAULT_MAX_PARALLEL_CALLS;
  const maxParallelSubagents = params.maxParallelSubagents || DEFAULT_MAX_PARALLEL_SUBAGENTS;
  const runId = randomUUID();
  const usageTotal = { prompt: 0, completion: 0 };

  const pinned: ChatMessage | undefined = !systemOverride && systemPrompt
    ? { role: 'system', content: systemPrompt }
    : undefined;
  let messages = pinned ? [pinned, ...input] : [...input];
  if (systemOverride) {
    messages.unshift({ role: 'system', content: systemOverride });
  }

  const all = [...(await tools.getSchemas())];
  if (allowedTools?.includes('structured_output') && !all.some((t) => t.name === 'structured_output')) {
    all.push({
      name: 'structured_output',
      description: '提交最终结构化结果。data 必须符合任务给定的 JSON Schema。这是你完成任务的唯一正确收尾方式——提交后无需再输出正文。',
      parameters: {
        type: 'object',
        properties: { data: { type: 'object', description: '符合任务 JSON Schema 的结果对象' } },
        required: ['data'],
      },
    });
  }
  const canAskUser = depth === 0 && !unattended && (!allowedTools || allowedTools.includes('ask_user'));
  const toolSchemas = (allowedTools ? all.filter((t) => allowedTools.includes(t.name)) : all)
    .filter((t) => canAskUser || t.name !== 'ask_user');

  const summarize = (name: string, args?: Record<string, unknown>, provided?: string) =>
    tools.summarizeCall ? tools.summarizeCall(name, args, provided) : (provided || name);
  const isReadOnly = (name: string) => tools.isReadOnly?.(name) ?? false;
  const isMutating = (name: string, args: Record<string, unknown>) => tools.isMutating?.(name, args) ?? false;
  const isPrunable = (name: string) => tools.isPrunable?.(name) ?? false;

  let lastSig = '';
  let repeatCount = 0;
  const recentCallCounts = new Map<string, number>();
  let errorRounds = 0;
  let lastTodos: TodoItem[] = [];
  let todoNudged = false;

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) return;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let reasoningText = '';
    let answerText = '';
    let finish = '';

    // 图片每一轮都带：以前只在第 0 轮发，模型一调工具，下一轮图片就从上下文里消失，
    // 「先跑工具、再回头对着截图分析」必然扑空（2026-11-26 两条排查会话实锤）。
    const roundImages = images;
    const budgetOptions = { images: roundImages, signal, windowTokens };
    const plan = round === 0 && store && sessionId && rawHistory && isConversationHistory(rawHistory)
      ? await prepareSessionContext(streamChat, store, sessionId, rawHistory, input, pinned, toolSchemas, budgetOptions)
      : await compactMessages(streamChat, messages, toolSchemas, budgetOptions);
    if (signal?.aborted) return;
    messages = plan.messages;
    yield {
      type: 'context_usage',
      reading: { tokens: plan.insight.estimatedTokens, estimated: true, byCategory: plan.insight.byCategory },
    };

    const wire = pinned && injectSystemPrompt && systemPrompt
      ? injectSystemPrompt(messages.slice(1), systemPrompt)
      : messages;
    let usage: { prompt: number; completion: number } | undefined;
    try {
      for await (const d of streamChat({ messages: wire, tools: toolSchemas, images: roundImages, signal, model })) {
        if (d.reasoning) {
          reasoningText += d.reasoning;
          yield { type: 'reasoning', delta: d.reasoning };
        }
        if (d.content) {
          answerText += d.content;
          yield { type: 'text', delta: d.content };
        }
        if (d.toolCalls) {
          for (const tc of d.toolCalls) {
            const cur = toolAcc.get(tc.index) || { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.name) cur.name = tc.name;
            if (tc.arguments) cur.args += tc.arguments;
            toolAcc.set(tc.index, cur);
          }
        }
        if (d.finishReason) finish = d.finishReason;
        if (d.usage) usage = d.usage;
      }
    } finally {
      if (sessionId && !signal?.aborted) {
        store?.addSample?.(sessionId, {
          kind: 'request',
          model,
          turnId,
          runId,
          round: round + 1,
          ...plan.insight,
          usage,
          finishReason: finish || null,
          beforeTokens: plan.beforeTokens,
          reclaimedTokens: plan.beforeTokens - plan.insight.estimatedTokens,
          compacted: !!plan.summary,
          failure: plan.failure,
        });
      }
    }
    if (usage) {
      usageTotal.prompt += usage.prompt;
      usageTotal.completion += usage.completion;
      yield {
        type: 'context_usage',
        reading: { tokens: usage.prompt, estimated: false, byCategory: plan.insight.byCategory },
      };
    }

    if (signal?.aborted) return;
    const seenInRound = new Set<string>();
    const seenIds = new Set<string>();
    const calls: ToolCall[] = [...toolAcc.values()]
      .filter((t) => t.name)
      .filter((t) => {
        const key = canonicalToolKey(t.name, t.args);
        if (seenInRound.has(key)) return false;
        seenInRound.add(key);
        return true;
      })
      .map((t) => {
        const id = t.id && !seenIds.has(t.id) ? t.id : randomUUID();
        seenIds.add(id);
        return { id, name: t.name, arguments: t.args };
      });

    if (calls.length === 0) {
      const unfinished = lastTodos.filter((t) => t.status !== 'completed');
      if (unfinished.length > 0 && !todoNudged && round < maxRounds - 1) {
        todoNudged = true;
        messages.push({ role: 'assistant', content: answerText, reasoning_content: reasoningText || undefined });
        messages.push({
          role: 'user',
          content: `你的任务清单还有 ${unfinished.length} 项没标完成：\n`
            + unfinished.map((t) => `- ${t.content}（${t.status === 'in_progress' ? '进行中' : '待办'}）`).join('\n')
            + '\n\n上面的正文已经发给用户了，不要重复。'
            + '如果这些事其实已经做完，调用 todo_write 重新提交完整清单（全部标 completed）；'
            + '如果确实没做或做不了，直接说明原因，别让清单停在半路。',
        });
        continue;
      }
      messages.push({ role: 'assistant', content: answerText, reasoning_content: reasoningText || undefined });
      // 本轮准备收尾前再检查一次：若用户在生成期间点了「强行提醒」，立刻注入并续跑一轮
      const endSteers = round < maxRounds - 1 ? drainSteering?.() : undefined;
      if (endSteers?.length) {
        const combined = endSteers.join('\n\n');
        const sid = `steer-${randomUUID().slice(0, 8)}`;
        yield { type: 'tool_start', id: sid, name: 'user_steer', summary: `强行提醒：${combined.slice(0, 48)}` };
        yield { type: 'tool_done', id: sid, name: 'user_steer', ok: true, output: combined };
        messages.push({
          role: 'user',
          content: `<system-reminder>\n用户在你执行过程中发来了强行提醒（插话），请立刻优先响应：\n${combined}\n</system-reminder>`,
        });
        continue;
      }
      yield { type: 'done', usage: usageTotal.prompt || usageTotal.completion ? usageTotal : undefined, rounds: round + 1 };
      return;
    }

    messages.push({ role: 'assistant', content: answerText, tool_calls: calls, reasoning_content: reasoningText || undefined });

    const parsed = calls.map((call) => {
      const { args, bad } = parseToolArguments(call.arguments);
      const sig = canonicalToolKey(call.name, call.arguments);
      return { call, args, bad, sig };
    });

    const todoCall = [...parsed].reverse().find((p) => p.call.name === 'todo_write' && !p.bad);
    if (todoCall && Array.isArray(todoCall.args.todos)) {
      lastTodos = (todoCall.args.todos as { id?: unknown; content?: unknown; status?: unknown; dependsOn?: unknown }[])
        .filter((t) => typeof t?.content === 'string')
        .map((t) => ({
          ...(typeof t.id === 'string' && t.id.trim() ? { id: t.id.trim() } : {}),
          content: String(t.content),
          status: (t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending') as TodoItem['status'],
          ...(Array.isArray(t.dependsOn)
            ? { dependsOn: t.dependsOn.filter((d): d is string => typeof d === 'string' && !!d.trim()) }
            : {}),
        }));
    }

    const results = new Map<string, ToolResult>();
    for (const p of parsed) {
      if (!p.bad) continue;
      const errMsg = finish === 'length'
        ? '工具参数 JSON 因触发单次输出长度上限被截断。请拆分操作、减小单次内容体积，或改用 edit_file 分段修改。'
        : '工具参数不是合法的 JSON 对象（可能被截断或格式错误）。请修正 arguments 后重新调用。';
      results.set(p.call.id, { tool_call_id: p.call.id, content: errMsg, isError: true });
      yield { type: 'tool_start', id: p.call.id, name: p.call.name, summary: summarize(p.call.name) };
      yield { type: 'tool_done', id: p.call.id, name: p.call.name, ok: false, output: errMsg };
    }

    if (canAskUser && tools.normalizeAskQuestions) {
      const askCalls = parsed.filter((p) => p.call.name === 'ask_user' && !p.bad);
      for (const askCall of askCalls) {
        const questions = tools.normalizeAskQuestions(askCall.args.questions);
        if (questions.length) {
          yield { type: 'ask', questions };
          return;
        }
        results.set(askCall.call.id, {
          tool_call_id: askCall.call.id,
          content: '错误：ask_user 的 questions 为空。要么给出至少一个问题（每题必须有 question 字段），要么不用这个工具、直接继续。',
          isError: true,
        });
      }
    }

    const activeCalls = parsed.filter((p) => p.call.name !== 'todo_write');
    const roundSig = activeCalls.length ? activeCalls.map((p) => p.sig).join('\n') : '';
    repeatCount = roundSig && roundSig === lastSig ? repeatCount + 1 : 0;
    lastSig = roundSig;
    let roundReminder = REPEAT_REMIND_AT.includes(repeatCount) && activeCalls[0]
      ? repeatReminder(activeCalls.map((p) => p.call.name).join('/'), repeatCount)
      : '';
    if (!roundReminder) {
      for (const p of activeCalls) {
        const c = (recentCallCounts.get(p.sig) || 0) + 1;
        recentCallCounts.set(p.sig, c);
        if (!roundReminder && (c === 4 || c === 6 || c === 9)) {
          roundReminder = repeatReminder(p.call.name, c);
        }
      }
    } else {
      for (const p of activeCalls) recentCallCounts.set(p.sig, (recentCallCounts.get(p.sig) || 0) + 1);
    }

    const runnableCalls = parsed.filter((p) => !results.has(p.call.id));
    const roundReads = runnableCalls.filter((p) => isPrunable(p.call.name)).length;

    // 根据每个工具的读写资源集合（Bernstein 冲突条件）构建因果 DAG 并切成并发波次：
    // - 宿主若提供 getResourceAccess（如 server 端按文件路径区分），不同文件的 edit_file / write_file 会自动合并到同一波并行；
    // - 未提供时退化为安全保守策略：只读工具共用只读池，写工具作为全局写屏障（writes: ['*']）独占串行。
    const classifyAccess = (name: string, args: Record<string, unknown>): ToolResourceAccess => {
      if (tools.getResourceAccess) return tools.getResourceAccess(name, args);
      if (name === 'subagent') return { lane: 'subagent', reads: ['*'], writes: [] };
      if (isReadOnly(name)) return { lane: 'normal', reads: ['*'], writes: [] };
      return { lane: 'normal', reads: ['*'], writes: ['*'] };
    };
    const scheduledBatches = scheduleToolBatches(runnableCalls, (p) => classifyAccess(p.call.name, p.args));

    for (const scheduled of scheduledBatches) {
      if (signal?.aborted) return;

      if (scheduled.lane === 'subagent') {
        const subBatch = scheduled.items;
        const queue = new AsyncQueue<AgentEvent>();
        let cursor = 0;
        const launch = async (p: typeof parsed[number]) => {
          const summary = summarize(p.call.name, p.args, typeof p.args.summary === 'string' ? p.args.summary : undefined);
          queue.push({ type: 'tool_start', id: p.call.id, name: p.call.name, summary, args: p.args });
          const execCtx = {
            signal,
            depth,
            sessionId,
            unattended,
            emit: (ev: AgentEvent) => queue.push(ev),
            parentMessages: p.args.fork === true ? wire : undefined,
          };
          let r: ToolResult;
          if (tools.authorize) {
            const auth = await tools.authorize(p.call.name, p.args, p.call.id, execCtx)
              .catch((e: Error) => ({ decision: 'deny' as const, reason: e.message, rejectedByUser: true }));
            if (auth.decision === 'deny') {
              const reason = auth.reason ? `：${auth.reason}` : '';
              r = {
                tool_call_id: p.call.id,
                content: `用户拒绝执行 ${p.call.name}${reason}`,
                isError: true,
                rejectedByUser: auth.rejectedByUser ?? true,
              };
            } else {
              r = await tools.execute(p.call.name, p.args, p.call.id, execCtx)
                .catch((e: Error) => ({ tool_call_id: p.call.id, content: `Tool error: ${e.message}`, isError: true }));
            }
          } else {
            r = await tools.execute(p.call.name, p.args, p.call.id, execCtx)
              .catch((e: Error) => ({ tool_call_id: p.call.id, content: `Tool error: ${e.message}`, isError: true }));
          }
          results.set(p.call.id, r);
          queue.push({ type: 'tool_done', id: p.call.id, name: p.call.name, ok: !r.isError, output: r.content });
        };
        const workers = Array.from({ length: Math.min(maxParallelSubagents, subBatch.length) }, async () => {
          while (cursor < subBatch.length && !signal?.aborted) {
            await launch(subBatch[cursor++]);
          }
        });
        const allDone = Promise.all(workers).finally(() => queue.close());
        for await (const ev of queue) yield ev;
        await allDone;
        continue;
      }

      const batch = scheduled.items;
      for (const p of batch) {
        yield {
          type: 'tool_start',
          id: p.call.id,
          name: p.call.name,
          summary: summarize(p.call.name, p.args, typeof p.args.summary === 'string' ? p.args.summary : undefined),
          args: p.args,
        };
      }
      const queue = new AsyncQueue<AgentEvent>();
      let cursor = 0;
      const workers = Array.from({ length: Math.min(maxParallelCalls, batch.length) }, async () => {
        while (cursor < batch.length && !signal?.aborted) {
          const p = batch[cursor++];
          const execCtx = {
            signal,
            depth,
            allowedTools,
            sessionId,
            unattended,
            outputSchema,
            emit: (ev: AgentEvent) => queue.push(ev),
          };
          let r: ToolResult;
          if (tools.authorize) {
            const auth = await tools.authorize(p.call.name, p.args, p.call.id, execCtx)
              .catch((e: Error) => ({ decision: 'deny' as const, reason: e.message, rejectedByUser: true }));
            if (auth.decision === 'deny') {
              const reason = auth.reason ? `：${auth.reason}` : '';
              r = {
                tool_call_id: p.call.id,
                content: `用户拒绝执行 ${p.call.name}${reason}`,
                isError: true,
                rejectedByUser: auth.rejectedByUser ?? true,
              };
            } else {
              r = await tools.execute(p.call.name, p.args, p.call.id, execCtx)
                .catch((e: Error) => ({ tool_call_id: p.call.id, content: `Tool error: ${e.message}`, isError: true }));
            }
          } else {
            r = await tools.execute(p.call.name, p.args, p.call.id, execCtx)
              .catch((e: Error) => ({ tool_call_id: p.call.id, content: `Tool error: ${e.message}`, isError: true }));
          }
          results.set(p.call.id, r);
          queue.push({ type: 'tool_done', id: p.call.id, name: p.call.name, ok: !r.isError, output: r.content });
        }
      });
      const allDone = Promise.all(workers).finally(() => queue.close());
      for await (const ev of queue) yield ev;
      await allDone;
    }
    if (signal?.aborted) return;

    const hasStateProgress = parsed.some((p) => {
      if (!isMutating(p.call.name, p.args)) return false;
      const r = results.get(p.call.id);
      return !!r && !r.isError;
    });
    if (hasStateProgress) recentCallCounts.clear();

    for (const { call } of parsed) {
      const result = results.get(call.id) ?? { tool_call_id: call.id, content: '工具未返回结果', isError: true };
      let historyContent = result.content;
      if (tools.formatHistoryResult) {
        historyContent = tools.formatHistoryResult(call.name, historyContent, roundReads);
      } else if (isPrunable(call.name)) {
        historyContent = pruneToolResult(historyContent, roundReads, call.name);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: historyContent });
    }

    const validStructured = parsed.some((p) => p.call.name === 'structured_output' && !p.bad && !results.get(p.call.id)?.isError);
    const anyFailedInRound = parsed.some((p) => results.get(p.call.id)?.isError);
    if (validStructured && !anyFailedInRound) {
      yield { type: 'done', usage: usageTotal.prompt || usageTotal.completion ? usageTotal : undefined, rounds: round + 1 };
      return;
    }

    const reminders: string[] = [];
    if (roundReminder) reminders.push(roundReminder);
    const failedNames = [...new Set(parsed
      .filter((p) => {
        if (canAskUser && p.call.name === 'ask_user') return false;
        const r = results.get(p.call.id);
        return !!r?.isError && !r.rejectedByUser;
      })
      .map((p) => p.call.name))];
    if (failedNames.length) {
      errorRounds++;
      reminders.push(errorRounds >= 2
        ? `连续第 ${errorRounds} 轮出现工具失败（${failedNames.join('、')}）。停下来重新检查假设：换工具、缩小范围或先查清 schema/路径/字段名；不要继续用同一套调用硬顶。`
        : `本轮工具失败（${failedNames.join('、')}）。先读错误原因，检查路径/schema/字段名；不要原样重试同一条命令。预期超过 30 秒的命令改用 background=true + get_terminal_output。`);
    } else {
      errorRounds = 0;
    }
    if (round === maxRounds - 3) {
      reminders.push('⚠️ 工具轮次预算只剩 2 轮：停止继续探索，立刻基于已有发现给出结论；没查清的地方直接说明缺口。');
    }
    const midSteers = drainSteering?.();
    if (midSteers?.length) {
      const combined = midSteers.join('\n\n');
      const sid = `steer-${randomUUID().slice(0, 8)}`;
      yield { type: 'tool_start', id: sid, name: 'user_steer', summary: `强行提醒：${combined.slice(0, 48)}` };
      yield { type: 'tool_done', id: sid, name: 'user_steer', ok: true, output: combined };
      reminders.push(`用户在你执行过程中发来了强行提醒（插话），请立刻优先响应并在接下来的行动中遵循：\n${combined}`);
    }
    if (reminders.length) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'tool') {
        lastMsg.content += `\n\n<system-reminder>\n${reminders.join('\n')}\n</system-reminder>`;
      } else {
        messages.push({ role: 'user', content: reminders.join('\n') });
      }
    }
  }

  yield { type: 'error', message: `__LIMIT__工具轮次预算（${maxRounds} 轮）用完了，先停在这里：上面是已经查到的内容。可以让我接着做，或把范围缩小一点。` };
}
