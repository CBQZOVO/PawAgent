// 子代理执行内核：独立/fork 上下文、工具白名单、事件透传、结构化输出校验、结果只回结论。
import type {
  AgentEvent,
  ChatMessage,
  CheckpointStore,
  StreamChatFn,
  SubagentStatus,
  ToolResult,
  ToolRuntime,
  ViewMessage,
} from './types.js';
import type { SubagentDef } from './agents.js';
import { appendText, appendTool, setToolResult } from './blocks.js';
import { runAgent } from './loop.js';

const uid = () => Math.random().toString(36).slice(2, 10);
const MAX_OUTPUT_CHARS = 32_000;
const DEFAULT_TIMEOUT_MS = 1_800_000;
const FORK_CONTEXT_CHARS = 48_000;

export interface SubagentArgs {
  subagent_name?: string;
  description?: string;
  prompt?: string;
  thoroughness?: string;
  fork?: boolean;
  output_schema?: Record<string, unknown>;
}

export interface SubagentSessionRecord {
  id: string;
  title: string;
  messages: ViewMessage[];
  updatedAt: number;
  source: 'subagent';
  parentId?: string;
}

export interface RunSubagentOptions {
  loadDefs: () => Promise<SubagentDef[]> | SubagentDef[];
  createStreamChat: (model?: string) => { streamChat: StreamChatFn; model: string };
  tools: ToolRuntime;
  workspacePrompt?: string;
  store?: CheckpointStore;
  parentSignal?: AbortSignal;
  parentSessionId?: string;
  emit?: (ev: AgentEvent) => void;
  parentMessages?: ChatMessage[];
  timeoutMs?: number;
  onSessionSave?: (record: SubagentSessionRecord) => void;
}

/** fork：把父已完成对话压成一段上下文文本（保最近的内容，截断保尾） */
export function forkContextBlock(msgs: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of msgs) {
    if (m.role === 'system') continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (!text) continue;
    if (m.role === 'user') parts.push(`[用户] ${text}`);
    else if (m.role === 'assistant') parts.push(`[主代理] ${text}`);
    else if (m.role === 'tool') parts.push(`[工具结果] ${text.slice(0, 1500)}`);
  }
  let joined = parts.join('\n\n');
  if (joined.length > FORK_CONTEXT_CHARS) joined = '…（前文已截断）\n' + joined.slice(-FORK_CONTEXT_CHARS);
  return joined;
}

/** 极简 JSON Schema 校验（type/required/properties/enum/items，够结构化输出用） */
export function validateSchema(value: unknown, schema: Record<string, unknown>, pathStr = '$'): string[] {
  const errs: string[] = [];
  const type = schema.type as string | undefined;
  const check = (t: string, v: unknown): boolean => {
    if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
    if (t === 'array') return Array.isArray(v);
    if (t === 'string') return typeof v === 'string';
    if (t === 'number' || t === 'integer') return typeof v === 'number' && (t !== 'integer' || Number.isInteger(v));
    if (t === 'boolean') return typeof v === 'boolean';
    if (t === 'null') return v === null;
    return true;
  };
  if (type && !check(type, value)) { errs.push(`${pathStr} 应为 ${type}`); return errs; }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errs.push(`${pathStr} 不在枚举 ${JSON.stringify(schema.enum)} 里`);
  if (type === 'object' && value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const req of (schema.required as string[]) || []) {
      if (!(req in obj)) errs.push(`${pathStr}.${req} 缺失（required）`);
    }
    const props = (schema.properties as Record<string, Record<string, unknown>>) || {};
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) errs.push(...validateSchema(obj[k], sub, `${pathStr}.${k}`));
    }
  }
  if (type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errs.push(...validateSchema(v, schema.items as Record<string, unknown>, `${pathStr}[${i}]`)));
  }
  return errs;
}

function roundsFor(def: SubagentDef): number | undefined {
  return def.maxRounds && def.maxRounds > 0 ? def.maxRounds : undefined;
}

export async function runSubagent(
  args: SubagentArgs,
  toolCallId: string,
  opts: RunSubagentOptions,
): Promise<ToolResult> {
  const name = String(args.subagent_name || '').trim();
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return { tool_call_id: toolCallId, content: '缺少 prompt：任务描述必须自包含', isError: true };

  const defs = await opts.loadDefs();
  const def = defs.find((d) => d.name === name);
  if (!def) {
    const avail = defs.map((d) => d.name).join(', ') || '（无）';
    return { tool_call_id: toolCallId, content: `没有名为 "${name}" 的子代理。可用：${avail}`, isError: true };
  }

  const runId = `sub-${uid()}`;
  const shortName = String(args.description || name).slice(0, 40);
  const maxRounds = roundsFor(def);
  const emit = opts.emit || (() => {});
  const t0 = Date.now();

  emit({ type: 'subagent_start', id: runId, toolCallId, name: shortName, agentName: def.name, task: prompt.slice(0, 300) });

  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  opts.parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.SUBAGENT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const { streamChat, model } = opts.createStreamChat(def.model);
  const useFork = args.fork === true && !!opts.parentMessages?.length;
  const forkBlock = useFork ? forkContextBlock(opts.parentMessages!) : '';
  const taskContent = forkBlock
    ? `<parent_conversation>\n以下是主对话已完成的上下文（供参考，你的任务在下面）：\n${forkBlock}\n</parent_conversation>\n\n${prompt}`
    : prompt;
  const wantStructured = !!args.output_schema && typeof args.output_schema === 'object';
  const structuredTools = wantStructured ? [...def.tools, 'structured_output'] : def.tools;
  const system = def.prompt + '\n\n' + [
    '你是被派生出来的子代理：',
    useFork
      ? '- 你继承了主对话的上下文（<parent_conversation>），在此基础上完成任务；不要重复已完成的工作。'
      : '- 你看不到主对话，一切以任务描述为准；缺信息就基于现有证据给出部分结论并说明缺口。',
    '- 你的工具权限在启动时就固定了，无法提升；不在白名单里的工具会被直接拒绝，不要尝试。',
    wantStructured
      ? `- 完成后必须调用 structured_output 工具提交结构化结果，参数 data 必须符合这个 JSON Schema：\n${JSON.stringify(args.output_schema)}\n提交前自查必填字段和类型；提交后无需再输出正文。`
      : '- 完成后用一段话汇报结论（先结论后证据），不要寒暄、不要提问。',
  ].join('\n');

  let status: SubagentStatus = 'completed';
  let output = '';
  // 只记录最后一轮（无后续工具调用）的正文，避免中间过渡旁白（如「我先看看…」）挤占结论与前端 500 字预览
  let finalRoundOutput = '';
  let rounds = 0;
  let toolCount = 0;
  let prevWasTool = false;
  let structuredData: unknown = undefined;
  let structuredError = '';
  const usage = { prompt: 0, completion: 0 };
  const viewMessages: ViewMessage[] = [
    { id: uid(), role: 'user', content: [{ type: 'text', text: prompt }], ts: Date.now() },
  ];
  const assistant: ViewMessage = { id: uid(), role: 'assistant', content: [], ts: Date.now(), model };

  try {
    for await (const ev of runAgent({
      streamChat,
      model,
      tools: opts.tools,
      store: opts.store,
      input: [{ role: 'user', content: taskContent }],
      signal: ctrl.signal,
      depth: 1,
      allowedTools: structuredTools,
      maxRounds,
      systemOverride: system + (opts.workspacePrompt ? '\n\n' + opts.workspacePrompt : ''),
      sessionId: opts.parentSessionId,
      unattended: true,
      outputSchema: wantStructured ? args.output_schema : undefined,
    })) {
      const forward: AgentEvent | null = (ev.type === 'text' || ev.type === 'tool_start' || ev.type === 'tool_done') ? ev : null;
      if (ev.type === 'text' || ev.type === 'reasoning') { prevWasTool = false; }
      if (ev.type === 'text') { output += ev.delta; finalRoundOutput += ev.delta; appendText(assistant, ev.delta); }
      else if (ev.type === 'reasoning') assistant.reasoning = (assistant.reasoning || '') + ev.delta;
      else if (ev.type === 'tool_start') {
        finalRoundOutput = '';
        if (!prevWasTool) rounds++; prevWasTool = true; toolCount++;
        appendTool(assistant, { type: 'tool-call', id: ev.id, name: ev.name, summary: ev.summary, args: ev.args });
        if (ev.name === 'structured_output' && wantStructured) {
          const data = (ev.args as Record<string, unknown>)?.data;
          const errs = validateSchema(data, args.output_schema!);
          if (errs.length) structuredError = errs.join('；');
          else { structuredData = data; structuredError = ''; }
        }
      }
      else if (ev.type === 'tool_done') {
        setToolResult(assistant, ev.id, ev.ok, ev.output);
      }
      else if (ev.type === 'done' && ev.usage) { usage.prompt += ev.usage.prompt; usage.completion += ev.usage.completion; }
      if (forward) emit({ type: 'subagent_event', id: runId, event: forward });
      else if (ev.type === 'error') {
        if (ev.message.startsWith('__LIMIT__')) {
          if (status === 'completed') status = 'limit';
          assistant.error = (assistant.error ? assistant.error + '\n' : '') + ev.message.slice(9);
        } else {
          status = 'error';
          assistant.error = (assistant.error ? assistant.error + '\n' : '') + ev.message;
        }
      }
    }
    if (ctrl.signal.aborted) status = opts.parentSignal?.aborted ? 'aborted' : 'timeout';
    else if (status === 'completed' && !output.trim() && structuredData === undefined) status = 'error';
  } catch (e) {
    status = ctrl.signal.aborted ? (opts.parentSignal?.aborted ? 'aborted' : 'timeout') : 'error';
    assistant.error = (e as Error).message;
  } finally {
    clearTimeout(timer);
    opts.parentSignal?.removeEventListener('abort', onParentAbort);
  }

  const seconds = (Date.now() - t0) / 1000;
  if (wantStructured && status === 'completed') {
    if (structuredData === undefined) {
      status = 'error';
      assistant.error = (assistant.error ? assistant.error + '\n' : '') + (structuredError ? `结构化输出校验失败：${structuredError}` : '子代理没有调用 structured_output 提交结果');
    }
  }
  if (status === 'aborted' || status === 'timeout') assistant.stopped = true;
  viewMessages.push(assistant);

  try {
    opts.onSessionSave?.({
      id: runId,
      title: `${def.name} · ${shortName}`,
      messages: viewMessages,
      updatedAt: Date.now(),
      source: 'subagent',
      parentId: opts.parentSessionId,
    });
  } catch { /* 落库失败不影响结果回传 */ }

  const statusText: Record<SubagentStatus, string> = {
    running: '运行中', completed: '完成', error: '失败',
    aborted: '被停止', timeout: '超时', limit: '达到轮次上限（部分结论）',
  };
  let body = wantStructured && structuredData !== undefined
    ? '```json\n' + JSON.stringify(structuredData, null, 2) + '\n```'
    : (finalRoundOutput.trim() || output.trim());
  if (body.length > MAX_OUTPUT_CHARS) body = body.slice(0, MAX_OUTPUT_CHARS) + '\n…（结论过长已截断，完整过程见子会话）';
  if (!body) body = assistant.error || '子代理没有给出结论';
  const tokenInfo = usage.prompt || usage.completion ? `，tokens ${usage.prompt}+${usage.completion}` : '';
  const summary = `[子代理 ${def.name}「${shortName}」${statusText[status]}，用时 ${seconds.toFixed(0)}s，${toolCount} 次工具调用${tokenInfo}]\n${body}`;

  emit({
    type: 'subagent_done',
    id: runId,
    status,
    summary: body.slice(0, 500),
    seconds,
    rounds: Math.max(1, rounds),
    tokens: usage.prompt || usage.completion ? usage : undefined,
  });
  const hardFail = status === 'error' || status === 'timeout' || status === 'aborted'
    || (status === 'limit' && !output.trim() && structuredData === undefined);
  return { tool_call_id: toolCallId, content: summary, isError: hardFail };
}
