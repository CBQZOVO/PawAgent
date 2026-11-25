import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { ChatMessage } from '@paw/shared';

// 走真实 HTTP、网关 SSE 和 SQLite 路径，模型响应由回环地址上的测试服务提供。
const dir = await mkdtemp(join(tmpdir(), 'paw-context-flow-'));
const replies: ChatMessage[][] = [];
let summaries = 0;      // 上下文压缩摘要调用数
let reflections = 0;    // 轮次复盘（记忆/工作日志提炼）调用数
let broken = false;
// 指定回复：返回 { status, frames }，frames 是 SSE 的 data 帧内容
let scripted: ((messages: ChatMessage[]) => { status?: number; frames: object[] }) | null = null;
const gateway = createServer(async (req, res) => {
  // 复盘（reflection.ts）先 GET /v1/models 挑最低倍率模型：返回单模型清单
  if (req.method === 'GET' && (req.url || '').split('?')[0] === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'local-test', owned_by: 'test', rate_multiplier: 0.1 }] }));
    return;
  }
  let json = '';
  for await (const chunk of req) json += chunk;
  const { messages, tools } = JSON.parse(json);
  // 无 tools 的调用有两类：压缩摘要 和 每轮复盘（reflection.ts，提示词含「长期记忆」）。分开计数。
  const firstText = typeof messages?.[0]?.content === 'string' ? messages[0].content : '';
  const reflecting = !tools && firstText.includes('长期记忆');
  const summarizing = !tools && !reflecting;
  if (reflecting) reflections++;
  if (summarizing) summaries++; else if (!reflecting) replies.push(messages);
  if (reflecting) {
    // 复盘是后台 fire-and-forget，固定回一段非 JSON 文本即可（parseJsonLoose 会丢弃），不进 scripted/attempts 计数
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '（复盘回复）' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  if (scripted) {
    const reply = scripted(messages);
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'text/event-stream' });
    res.end(reply.frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const frame = { choices: [{ delta: { content: summarizing ? '先前已核实的任务状态' : '继续处理' }, finish_reason: broken && summarizing ? 'length' : 'stop' }], usage: { prompt_tokens: 123, completion_tokens: 9 } };
  res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
});
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
let child: ChildProcess | undefined;
async function start() {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PAW_DATA_DIR: dir, PORT: '0', PAW_HOST: '127.0.0.1', GATEWAY_KEY: 'fixture',
      GATEWAY_URL: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`, PAW_CONTEXT_WINDOW_TOKENS: '64000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  let log = '';
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server startup timed out')), 20000);
    proc.stdout.on('data', chunk => {
      log += chunk;
      const url = log.match(/Paw server on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (url) { clearTimeout(timer); resolve(url); }
    });
    proc.stderr.on('data', chunk => { log += chunk; });
    proc.once('exit', code => { clearTimeout(timer); reject(new Error(`test server exited (${code}): ${log}`)); });
  });
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit');
  child.kill();
  await closed;
}
try {
  let url = await start();
  const post = (path: string, messages: ChatMessage[], sessionId = 'manual', turnId?: string) => fetch(url + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, turnId, messages, model: 'local-test', workspace: null }), signal: AbortSignal.timeout(15000),
  });
  const old: ChatMessage[] = [{ role: 'user', content: '原始任务' }, { role: 'assistant', content: '旧的核查结果'.repeat(500) }, { role: 'user', content: '最近的原文' }];
  const reading = async (session: string, turn: string, since = 1) =>
    (await fetch(`${url}/api/context/${session}/usage?turnId=${turn}&since=${since}`)).json();
  const manual = await (await post('/api/context/compact', old, 'manual', 'first')).json();
  assert.deepEqual(await reading('manual', 'first'), { reading: { tokens: manual.insight.estimatedTokens, estimated: true } });
  assert.equal(manual.insight.compacted, true);
  assert.ok(manual.insight.reclaimedTokens > 0);
  await stop();
  url = await start();
  await (await post('/api/chat', old)).text();
  assert.match(JSON.stringify(replies.at(-1)), /先前已核实的任务状态/);
  assert.doesNotMatch(JSON.stringify(replies.at(-1)), /旧的核查结果/);
  assert.ok(replies.at(-1)?.at(-1)?.content.includes('最近的原文'));
  const { latest: legacy } = await (await fetch(url + '/api/context/manual')).json();
  const since = legacy.at - 1000;
  await fetch(url + '/api/sessions', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ id: 'manual', title: '旧会话', updatedAt: legacy.at, messages: [
      { role: 'user', id: 'legacy', ts: since, content: [] },
      { role: 'assistant', id: 'reply', ts: since, content: [], durationMs: 1000 },
    ] }]) });
  assert.equal((await (await post('/api/context/compact', old)).json()).insight.compacted, false);
  assert.deepEqual(await reading('manual', 'legacy', since), { reading: { tokens: 123, estimated: false } });
  assert.equal(summaries, 1);
  // 每轮对话收尾会异步触发复盘（reflection.ts），轮询等它发起到测试网关
  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (reflections >= 1 ? resolve() : Date.now() - t0 > 8000 ? reject(new Error('复盘调用未发生')) : setTimeout(tick, 100));
    tick();
  });
  const edited = old.map((m, i) => i === 0 ? { ...m, content: '更正后的任务' } : m);
  await (await post('/api/chat', edited)).text();
  assert.match(JSON.stringify(replies.at(-1)), /更正后的任务/);
  assert.doesNotMatch(JSON.stringify(replies.at(-1)), /先前已核实的任务状态/);
  broken = true;
  assert.equal((await post('/api/context/compact', edited)).status, 502);
  broken = false;
  await (await post('/api/chat', old)).text();
  assert.match(JSON.stringify(replies.at(-1)), /先前已核实的任务状态/);
  const long = old.map((m, i) => i === 1 ? { ...m, content: '自动压缩记录'.repeat(134_000) } : m);
  const stream = await (await post('/api/chat', long, 'auto', 'second')).text();
  assert.doesNotMatch(JSON.stringify(replies.at(-1)), /自动压缩记录/);
  const { latest } = await (await fetch(url + '/api/context/auto')).json();
  assert.equal(latest.windowTokens, 1_000_000);
  assert.equal(latest.thresholdTokens, 800_000);
  assert.equal(latest.compacted, true);
  assert.equal(latest.usage.prompt, 123);
  assert.equal(latest.turnId, 'second');
  const events = stream.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
  const actual = { tokens: 123, estimated: false };
  assert.deepEqual(events.filter(ev => ev.type === 'context_usage').map(ev => ev.reading),
    [{ tokens: latest.estimatedTokens, estimated: true }, actual]);
  assert.deepEqual(await reading('auto', 'second'), { reading: actual });
  assert.deepEqual(await reading('manual', 'second'), { reading: null });
  assert.deepEqual(await reading('auto', 'first'), { reading: null });
  assert.ok(latest.byCategory.tools > 0 && latest.reclaimedTokens > 0);
  // ---------- 同一轮 tool_call 撞 id / 网关首包前瞬断 ----------
  const toolFrame = (index: number, args: object) => ({ choices: [{ delta: { tool_calls: [{ index, id: 'dup', type: 'function', function: { name: 'read_file', arguments: JSON.stringify(args) } }] } }] });
  await writeFile(join(dir, 'a.txt'), 'AAA');
  await writeFile(join(dir, 'b.txt'), 'BBB');
  scripted = (messages) => messages.length > 2
    ? { frames: [{ choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] }] }
    : { frames: [toolFrame(0, { path: join(dir, 'a.txt') }), toolFrame(1, { path: join(dir, 'b.txt') }), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }] };
  const parseEvents = (text: string) => text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
  const dup = parseEvents(await (await post('/api/chat', [{ role: 'user', content: '读两个文件' }], 'dup')).text());
  assert.equal(new Set(dup.filter(ev => ev.type === 'tool_start').map(ev => ev.id)).size, 2, '撞 id 的两个调用，事件 id 必须唯一');
  assert.deepEqual(dup.filter(ev => ev.type === 'tool_done').map(ev => ev.output.includes('AAA') ? 'a' : 'b').sort(), ['a', 'b']);
  const last = replies.at(-1)!;
  const results = last.filter(m => m.role === 'tool');
  assert.deepEqual(results.map(m => m.content), ['1\tAAA', '1\tBBB'], '模型看到的结果要按调用各归各的');
  assert.deepEqual((last.find(m => m.role === 'assistant') as { tool_calls: { id: string }[] }).tool_calls.map(c => c.id),
    results.map(m => m.tool_call_id), '回传的 tool_calls 与 tool 结果按 id 配对');
  let attempts = 0;
  scripted = () => ({ status: ++attempts === 1 ? 502 : 200, frames: attempts === 1 ? [] : [{ choices: [{ delta: { content: '重试成功' }, finish_reason: 'stop' }] }] });
  const retried = await (await post('/api/chat', [{ role: 'user', content: '触发重试' }], 'retry')).text();
  assert.equal(attempts, 2, '首包前 502 应自动重试一次');
  assert.ok(retried.includes('重试成功') && !retried.includes('"type":"error"'));
  attempts = 0;
  scripted = () => { attempts++; return { status: 404, frames: [] }; };
  const notRetryable = await (await post('/api/chat', [{ role: 'user', content: '不该重试' }], 'noretry')).text();
  assert.equal(attempts, 1, '404 是确定性错误，不重试');
  assert.ok(notRetryable.includes('"type":"error"'));

  // ---------- 网关发 tool_calls 但标 finish_reason=stop 时不丢调用 + sessionId 文件回滚生效 ----------
  const rewindTarget = join(dir, 'rewind-target.txt');
  await writeFile(rewindTarget, 'BEFORE');
  const beforeEditTs = Date.now() - 50;
  let editTurn = 0;
  scripted = () => ++editTurn === 1
    ? { frames: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc-stop', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: rewindTarget, old_string: 'BEFORE', new_string: 'AFTER' }) } }] }, finish_reason: 'stop' }] }] }
    : { frames: [{ choices: [{ delta: { content: '修改完成' }, finish_reason: 'stop' }] }] };
  const stopToolOut = parseEvents(await (await post('/api/chat', [{ role: 'user', content: '改文件' }], 'rewind-sess')).text());
  assert.ok(stopToolOut.some(ev => ev.type === 'tool_done' && ev.name === 'edit_file' && ev.ok === true), 'finish_reason=stop 时仍应执行 tool_calls');
  const rewound = await (await fetch(url + '/api/rewind', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'rewind-sess', beforeTs: beforeEditTs }),
  })).json() as { restored: string[]; skipped: string[] };
  assert.deepEqual(rewound.restored, [rewindTarget], 'loop 透传 sessionId 后 /api/rewind 应能还原 AI 改动的文件');

  // ---------- 同轮 write_file → subagent 严格因果顺序 + structured_output 校验重试与零空跑收尾 ----------
  const causalFile = join(dir, 'causal.txt');
  let subStage = 0;
  scripted = (messages) => {
    const sys = messages[0]?.role === 'system' ? messages[0].content : '';
    const isSub = sys.includes('你是被派生出来的子代理');
    if (!isSub) {
      const hasSubResult = messages.some(m => m.role === 'tool' && m.content.includes('verdict'));
      if (!hasSubResult) {
        return {
          frames: [{
            choices: [{
              delta: {
                tool_calls: [
                  { index: 0, id: 'w-first', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: causalFile, content: 'READY_ON_DISK' }) } },
                  { index: 1, id: 'sub-second', type: 'function', function: { name: 'subagent', arguments: JSON.stringify({
                    subagent_name: 'code-explorer',
                    description: '核对写入文件',
                    prompt: `读取 ${causalFile}`,
                    output_schema: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } },
                  }) } },
                ],
              },
              finish_reason: 'tool_calls',
            }],
          }],
        };
      }
      return { frames: [{ choices: [{ delta: { content: '主代理收尾' }, finish_reason: 'stop' }] }] };
    }
    // 子代理第 1 轮读文件（验证 write_file 已先落盘）；第 2 轮故意交错 schema 看能否收到校验错误；第 3 轮交合法结构化结果并直接收尾
    subStage++;
    if (subStage === 1) {
      return { frames: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 's-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: causalFile }) } }] }, finish_reason: 'tool_calls' }] }] };
    }
    if (subStage === 2) {
      const readOut = messages.find(m => m.role === 'tool')?.content || '';
      assert.match(readOut, /READY_ON_DISK/, 'write_file 必须在同轮 subagent 之前落盘');
      return { frames: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 's-bad', type: 'function', function: { name: 'structured_output', arguments: JSON.stringify({ data: {} }) } }] }, finish_reason: 'tool_calls' }] }] };
    }
    if (subStage === 3) {
      const lastTool = [...messages].reverse().find(m => m.role === 'tool')?.content || '';
      assert.match(lastTool, /结构化校验失败.*verdict/, '子代理必须收到 schema 校验失败原因才能修正重试');
      assert.ok(!messages.slice(2).some(m => m.role === 'user'), '工具失败提醒应挂在 tool 消息上而非伪造 user 消息');
      return { frames: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 's-ok', type: 'function', function: { name: 'structured_output', arguments: JSON.stringify({ data: { verdict: 'confirmed' } }) } }] }, finish_reason: 'tool_calls' }] }] };
    }
    throw new Error('structured_output 校验通过后应立即收尾，不应再发起第 4 轮模型请求');
  };
  const subEvents = parseEvents(await (await post('/api/chat', [{ role: 'user', content: '写文件并派子代理核验' }], 'causal-sess')).text());
  const subDone = subEvents.find(ev => ev.type === 'subagent_done');
  assert.equal(subDone?.status, 'completed', '仅提交合法 structured_output 不输出正文也应判定 completed');
  const subStart = subEvents.find(ev => ev.type === 'subagent_start');
  assert.equal(subStart?.toolCallId, 'sub-second', 'subagent_start 应携带外层 toolCallId');
  assert.equal(subStage, 3, '子代理在合法 structured_output 后零空跑收尾');

  // ---------- 会话交接：/api/context/handoff + 双向元数据持久化 + search_parent_session 按需回查 ----------
  await fetch(url + '/api/sessions', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{
      id: 'parent-s1',
      title: '排查订单同步',
      updatedAt: Date.now(),
      handoffTo: { sessionId: 'child-s2', title: '续：排查订单同步' },
      messages: [
        { id: 'u1', role: 'user', ts: 1, content: [{ type: 'text', text: '订单同步报 409 错' }] },
        {
          id: 'a1', role: 'assistant', ts: 2,
          todos: [{ content: '修复幂等键冲突', status: 'in_progress' }],
          content: [
            { type: 'tool-call', id: 'tc1', name: 'call_api', args: { path: '/orders/sync' }, ok: false, output: 'HTTP 409 E_IDEMPOTENT_KEY_CONFLICT orderId=ORD-9981' },
            { type: 'tool-call', id: 'tc2', name: 'edit_file', args: { path: 'src/order-sync.ts' }, ok: true, output: '已替换 1 处' },
            { type: 'text', text: '已定位是幂等键重复导致 409' },
          ],
        },
      ],
    }, {
      id: 'child-s2',
      title: '续：排查订单同步',
      updatedAt: Date.now(),
      handoffFrom: { sessionId: 'parent-s1', title: '排查订单同步' },
      messages: [],
    }]),
  });
  const listRes = await (await fetch(url + '/api/sessions')).json() as { sessions: Array<{ id: string; handoffFrom?: { sessionId: string }; handoffTo?: { sessionId: string } }> };
  assert.equal(listRes.sessions.find((s) => s.id === 'parent-s1')?.handoffTo?.sessionId, 'child-s2', '原会话摘要应持久化 handoffTo');
  assert.equal(listRes.sessions.find((s) => s.id === 'child-s2')?.handoffFrom?.sessionId, 'parent-s1', '新会话摘要应持久化 handoffFrom');

  scripted = () => ({ frames: [{ choices: [{ delta: { content: '### 当前目标与约束\n修复订单同步 409 冲突' }, finish_reason: 'stop' }] }] });
  const handoffResp = await (await fetch(url + '/api/context/handoff', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'parent-s1',
      title: '排查订单同步',
      model: 'local-test',
      goal: '继续修复幂等键',
      messages: [{ role: 'user', content: '订单同步报 409 错' }, { role: 'assistant', content: '已定位是幂等键重复导致 409' }],
      workspace: null,
    }),
  })).json() as { handoff: { fromSessionId: string; summary: string; changedFiles?: string[]; pendingTodos?: string[] }; suggestedTitle: string };
  assert.equal(handoffResp.handoff.fromSessionId, 'parent-s1');
  assert.equal(handoffResp.suggestedTitle, '继续修复幂等键');
  assert.deepEqual(handoffResp.handoff.changedFiles, ['src/order-sync.ts']);
  assert.match(handoffResp.handoff.summary, /修复幂等键冲突/);

  let recallStep = 0;
  scripted = (messages) => {
    recallStep++;
    if (recallStep === 1) {
      assert.ok(messages.some((m) => m.content.includes('<handoff_context')), '首轮应注入 <handoff_context>');
      return {
        frames: [{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0, id: 'recall-1', type: 'function',
                function: { name: 'search_parent_session', arguments: JSON.stringify({ query: 'E_IDEMPOTENT_KEY_CONFLICT' }) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }],
      };
    }
    const toolOut = messages.find((m) => m.role === 'tool')?.content || '';
    assert.match(toolOut, /ORD-9981/, 'search_parent_session 应能精确回查原会话工具输出中的订单号');
    return { frames: [{ choices: [{ delta: { content: '已查到订单 ORD-9981 冲突详情' }, finish_reason: 'stop' }] }] };
  };
  const recallEvents = parseEvents(await (await fetch(url + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'child-s2',
      parentSessionId: 'parent-s1',
      handoff: handoffResp.handoff,
      messages: [{ role: 'user', content: '帮我查下之前具体是哪个订单号报 409' }],
      model: 'local-test',
      workspace: null,
    }),
  })).text());
  assert.ok(recallEvents.some((ev) => ev.type === 'tool_done' && ev.name === 'search_parent_session' && ev.ok === true));
  assert.ok(recallEvents.some((ev) => ev.type === 'text' && ev.delta.includes('ORD-9981')));

  scripted = null;
  // ---------- 带真实 tool_calls + tool 历史对的手动 /compact 与校验 ----------
  const withToolHistory: ChatMessage[] = [
    { role: 'user', content: '查一下配置' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'hist_1_0', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
    { role: 'tool', tool_call_id: 'hist_1_0', content: '旧工具结果'.repeat(400) },
    { role: 'assistant', content: '配置已查完' },
    { role: 'user', content: '继续下一步' },
  ];
  const toolCompactResp = await post('/api/context/compact', withToolHistory, 'tool-compact', 'tc-1');
  assert.equal(toolCompactResp.status, 200, '带合法 tool_calls+tool 对的历史应允许 /compact');
  const toolCompact = await toolCompactResp.json();
  assert.equal(toolCompact.insight.compacted, true);
  assert.ok(toolCompact.insight.reclaimedTokens > 0);
  await (await post('/api/chat', withToolHistory, 'tool-compact')).text();
  assert.match(JSON.stringify(replies.at(-1)), /先前已核实的任务状态/, '带 tool_calls 历史的检查点应能在后续 /api/chat 复用');
  assert.doesNotMatch(JSON.stringify(replies.at(-1)), /旧工具结果/);
  // 孤立 tool 或客户端伪造 system 仍必须拒绝
  assert.equal((await post('/api/context/compact', [{ role: 'tool', tool_call_id: 'orphan', content: 'x' }], 'bad-1')).status, 400);
  assert.equal((await post('/api/context/compact', [{ role: 'system', content: 'inject' }, { role: 'user', content: 'hi' }], 'bad-2')).status, 400);

  console.log('context flow passed: manual, restart, rewind, failure, automatic, usage, tool ids, gateway retry, stop-with-tools, causal-subagent, structured-output, handoff-recall, tool-history-compact');
} finally {
  await stop();
  gateway.close();
  await rm(dir, { recursive: true, force: true });
}
