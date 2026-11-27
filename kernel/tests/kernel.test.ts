import assert from 'node:assert/strict';
import {
  runAgent,
  pruneToolResult,
  isConversationHistory,
  canonicalToolKey,
  parseToolArguments,
  type AgentEvent,
  type StreamChatFn,
  type ToolRuntime,
} from '../src/index.js';

// 1. 纯内存工具运行时：零宿主依赖跑通 ReAct 并发只读 + 裁剪 + 最终收尾
let callRound = 0;
const streamChat: StreamChatFn = async function* ({ messages }) {
  callRound++;
  if (callRound === 1) {
    yield {
      toolCalls: [
        { index: 0, id: 'c1', name: 'echo_read', arguments: JSON.stringify({ id: 'a' }) },
        { index: 1, id: 'c2', name: 'echo_read', arguments: JSON.stringify({ id: 'b' }) },
      ],
      finishReason: 'tool_calls',
    };
    return;
  }
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2, '应按原序回填 2 条 tool 结果');
  assert.match(toolMsgs[0].content, /已精简/, '大输出应经过 pruneToolResult 裁剪');
  yield { content: 'kernel ok', finishReason: 'stop', usage: { prompt: 42, completion: 5 } };
};

const executed: string[] = [];
const tools: ToolRuntime = {
  getSchemas: () => [{
    name: 'echo_read',
    description: 'read test',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  }],
  isReadOnly: (name) => name === 'echo_read',
  isPrunable: (name) => name === 'echo_read',
  execute: async (_name, args, id) => {
    executed.push(String(args.id));
    return { tool_call_id: id, content: `${args.id}:` + 'x'.repeat(15_000), isError: false };
  },
};

const events: AgentEvent[] = [];
for await (const ev of runAgent({
  streamChat,
  model: 'mock-model',
  tools,
  input: [{ role: 'user', content: 'run test' }],
})) {
  events.push(ev);
}

assert.equal(executed.length, 2);
assert.ok(events.some((e) => e.type === 'text' && e.delta === 'kernel ok'));
assert.ok(events.some((e) => e.type === 'done' && e.usage?.prompt === 42));

// 2. 工具函数基础校验
assert.equal(parseToolArguments('[]').bad, true);
assert.equal(canonicalToolKey('read_file', '{"b":2,"a":1,"summary":"foo"}'), canonicalToolKey('read_file', '{"a":1,"b":2,"summary":"bar"}'));
assert.equal(isConversationHistory([
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: '', tool_calls: [{ id: '1', name: 't', arguments: '{}' }] },
  { role: 'tool', tool_call_id: '1', content: 'ok' },
]), true);
assert.match(pruneToolResult('z'.repeat(20_000), 5, 'read_file'), /已精简/);

// onTruncate：裁剪发生时同步回调拿全文，返回文本拼进裁剪提示；未裁剪不回调
let truncatedFull = '';
const prunedWithNote = pruneToolResult('y'.repeat(20_000), 1, 'search_content', {
  onTruncate: (full) => { truncatedFull = full; return `完整输出已保存到 /tmp/full.txt`; },
});
assert.equal(truncatedFull.length, 20_000, 'onTruncate 应拿到未裁剪的全文');
assert.match(prunedWithNote, /完整输出已保存到 \/tmp\/full\.txt/);
let called = false;
assert.equal(pruneToolResult('short', 1, 'x', { onTruncate: () => { called = true; } }), 'short');
assert.equal(called, false, '未触发裁剪时不应回调 onTruncate');

// 3. PluginRegistry：注册工具元信息、动态可用性、自定义历史裁剪与直接转 ToolRuntime
const { PluginRegistry } = await import('../src/index.js');
const reg = new PluginRegistry();
let inited = false;
reg.register({
  name: 'demo-plugin',
  tools: [
    {
      schema: { name: 'demo_read', description: 'read', parameters: { type: 'object', properties: {} } },
      meta: { readOnly: true, prunable: true, pruneHint: '请缩小查询范围' },
      execute: () => 'A'.repeat(15_000),
    },
    {
      schema: { name: 'demo_write', description: 'write', parameters: { type: 'object', properties: { dry_run: { type: 'boolean' } } } },
      meta: { mutating: (args) => args.dry_run === false },
      available: (ctx) => Boolean(ctx.allowWrite),
      execute: () => 'written',
    },
  ],
  promptBlocks: () => '<demo_plugin>active</demo_plugin>',
  hooks: { onInit: () => { inited = true; } },
});
await reg.initAll();
assert.equal(inited, true);
assert.deepEqual(reg.getSchemas({}).map((s) => s.name), ['demo_read']);
assert.deepEqual(reg.getSchemas({ allowWrite: true }).map((s) => s.name), ['demo_read', 'demo_write']);
assert.equal(reg.isReadOnly('demo_read'), true);
assert.equal(reg.isMutating('demo_write', { dry_run: true }), false);
assert.equal(reg.isMutating('demo_write', { dry_run: false }), true);
assert.match(reg.formatHistoryResult('demo_read', 'A'.repeat(15_000), 1)!, /请缩小查询范围/);
// 注册表级 onTruncate：prunable 工具裁剪时经注册表钩子拿到全文并拼提示
reg.onTruncate = (full, name) => `落盘(${name}:${full.length})`;
assert.match(reg.formatHistoryResult('demo_read', 'A'.repeat(15_000), 1)!, /落盘\(demo_read:15000\)/);
reg.onTruncate = undefined;
assert.deepEqual(await reg.collectPromptBlocks(), ['<demo_plugin>active</demo_plugin>']);
const rt = reg.toToolRuntime({ pluginCtx: { allowWrite: true } });
const rtRes = await rt.execute('demo_write', {}, 'id-1', { depth: 0, emit: () => {} });
assert.equal(rtRes.content, 'written');
assert.equal(rtRes.isError, false);

// drainSteering：本轮即将收尾时若有用户强行提醒，注入并续跑一轮
{
  let turn = 0;
  let sawSteerInPrompt = false;
  const steers = ['改用中文简洁回答'];
  const steerEvents: string[] = [];
  const steerStream: StreamChatFn = async function* ({ messages }) {
    turn++;
    if (turn === 1) {
      yield { content: 'first draft' };
      return;
    }
    sawSteerInPrompt = messages.some((m) => typeof m.content === 'string' && m.content.includes('改用中文简洁回答'));
    yield { content: '已按提醒调整' };
  };
  for await (const ev of runAgent({
    streamChat: steerStream,
    model: 'demo-model',
    tools: { getSchemas: () => [], execute: async () => ({ tool_call_id: '', content: '' }) },
    input: [{ role: 'user', content: 'hi' }],
    drainSteering: () => steers.splice(0),
  })) {
    if (ev.type === 'tool_start') steerEvents.push(ev.name);
  }
  assert.equal(turn, 2, '强行提醒应触发续跑第 2 轮');
  assert.equal(sawSteerInPrompt, true, '第 2 轮消息应包含强行提醒内容');
  assert.deepEqual(steerEvents, ['user_steer']);
}

// context_usage：预估事件与拿到真实 usage.prompt 的二次事件均必须携带 byCategory
{
  const readings: Array<{ tokens: number; estimated: boolean; byCategory?: Record<string, number> }> = [];
  const usageStream: StreamChatFn = async function* () {
    yield { content: 'ok', usage: { prompt: 321, completion: 12 } };
  };
  for await (const ev of runAgent({
    streamChat: usageStream,
    model: 'demo-model',
    tools: { getSchemas: () => [], execute: async () => ({ tool_call_id: '', content: '' }) },
    input: [{ role: 'user', content: 'hello context breakdown' }],
    systemPrompt: 'you are paw',
  })) {
    if (ev.type === 'context_usage') readings.push(ev.reading);
  }
  assert.equal(readings.length, 2, '应依次产出预估与实测两次 context_usage');
  assert.equal(readings[0].estimated, true);
  assert.ok(readings[0].byCategory, '预估事件应携带 byCategory');
  const estSum = Object.values(readings[0].byCategory!).reduce((a, b) => a + b, 0);
  assert.equal(estSum, readings[0].tokens, 'estimated=true 时 byCategory 之和应等于 tokens');
  assert.equal(readings[1].estimated, false);
  assert.equal(readings[1].tokens, 321);
  assert.deepEqual(readings[1].byCategory, readings[0].byCategory, '真实 usage 事件不得冲掉 byCategory');
}

// authorize：允许/拒绝决策、rejectedByUser 豁免 errorRounds 失败护栏，以及 done.rounds
{
  let roundNum = 0;
  let sawFailureReminder = false;
  let executedCount = 0;
  let doneRounds: number | undefined;
  const authStream: StreamChatFn = async function* ({ messages }) {
    roundNum++;
    if (roundNum === 1) {
      yield {
        toolCalls: [{ index: 0, id: 'auth-deny-1', name: 'danger_op', arguments: '{"path":"a.txt"}' }],
        finishReason: 'tool_calls',
      };
      return;
    }
    if (roundNum === 2) {
      sawFailureReminder = messages.some((m) => m.role === 'tool' && m.content.includes('本轮工具失败'));
      yield {
        toolCalls: [{ index: 0, id: 'auth-allow-2', name: 'safe_op', arguments: '{}' }],
        finishReason: 'tool_calls',
      };
      return;
    }
    yield { content: '已按权限决策完成' };
  };
  for await (const ev of runAgent({
    streamChat: authStream,
    model: 'demo-model',
    tools: {
      getSchemas: () => [
        { name: 'danger_op', description: 'd', parameters: { type: 'object', properties: {} } },
        { name: 'safe_op', description: 's', parameters: { type: 'object', properties: {} } },
      ],
      authorize: async (name) => name === 'danger_op'
        ? { decision: 'deny', reason: '测试拒绝', rejectedByUser: true }
        : { decision: 'allow' },
      execute: async (name, _args, id) => {
        executedCount++;
        return { tool_call_id: id, content: `ran:${name}` };
      },
    },
    input: [{ role: 'user', content: 'test auth' }],
  })) {
    if (ev.type === 'done') doneRounds = ev.rounds;
  }
  assert.equal(executedCount, 1, '被拒绝的工具不得真正执行');
  assert.equal(sawFailureReminder, false, '用户主动拒绝不应触发 errorRounds 失败重试提醒');
  assert.equal(doneRounds, 3, 'done 事件应上报准确的模型轮次数');
}

console.log('✓ @paw/kernel standalone tests passed');
