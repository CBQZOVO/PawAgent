import assert from 'node:assert/strict';
import type { ChatMessage } from '@paw/shared';
import { compactMessages, inspectContext } from '../src/agent/context.js';
import type { streamChat } from '../src/gateway/client.js';

const cfg = { baseUrl: '', apiKey: '', model: '' };
const originalWindow = process.env.PAW_CONTEXT_WINDOW_TOKENS;
const call = (id: string): ChatMessage => ({ role: 'assistant', content: '', tool_calls: [{ id, name: 'read', arguments: '{}' }] });
const result = (id: string, content: string): ChatMessage => ({ role: 'tool', content, tool_call_id: id });
try {
  process.env.PAW_CONTEXT_WINDOW_TOKENS = '800';
  const estimate = inspectContext([{ role: 'user', content: '问题' }], [], ['data:image/...']);
  assert.equal(estimate.windowTokens, 1_000_000);
  assert.equal(estimate.thresholdTokens, 800_000);
  assert.equal(estimate.estimatedTokens, estimate.byCategory.user + 1024);
  const messages: ChatMessage[] = [
    { role: 'system', content: '原始规则' }, { role: 'user', content: '最新问题' },
    call('a'), result('a', '文件内容😀'.repeat(150_001)), call('b'), result('b', '新结果'),
  ];
  let requests = 0;
  const stream: typeof streamChat = async function* (_, input, tools) {
    assert.deepEqual(tools, []);
    assert.ok(inspectContext(input, []).estimatedTokens <= 800_000);
    if (requests++) assert.ok(input[1].content.includes('记录摘要'));
    yield { content: '记录摘要', finishReason: 'stop' };
  };
  const compact = await compactMessages(cfg, messages, [], { stream });
  assert.ok(requests > 1);
  assert.deepEqual(compact.messages, [...messages.slice(0, 2), { role: 'assistant', content: compact.summary }, ...messages.slice(4)]);
  assert.equal(compact.cut, 4);
  assert.ok(compact.insight.estimatedTokens < compact.beforeTokens);
  assert.equal((await compactMessages(cfg, messages, [], { historyEnd: 3, stream })).messages, messages);
  const interrupted: typeof streamChat = async function* () { yield { content: '半截摘要' }; };
  assert.equal((await compactMessages(cfg, messages, [], { stream: interrupted })).messages, messages);
  const abort = new AbortController();
  const cancelled: typeof streamChat = async function* () { abort.abort(); yield { content: '片段', finishReason: 'stop' }; };
  await assert.rejects(compactMessages(cfg, messages, [], { signal: abort.signal, stream: cancelled }), { name: 'AbortError' });
  const failing: typeof streamChat = async function* () { throw new Error('断网'); };
  const failed = await compactMessages(cfg, messages, [], { stream: failing });
  assert.equal(failed.messages, messages);
  assert.equal(failed.failure, '断网');
  await assert.rejects(compactMessages(cfg, messages, [], { manual: true, stream: failing }), /断网/);
  await assert.rejects(compactMessages(cfg, messages, [], { manual: true, stream: interrupted }), /缺少结束标记/);
  const empty: typeof streamChat = async function* () { yield { finishReason: 'stop' }; };
  await assert.rejects(compactMessages(cfg, messages, [], { manual: true, stream: empty }), /空摘要/);
  const short: ChatMessage[] = [{ role: 'user', content: '任务' }, { role: 'assistant', content: '旧记录'.repeat(60) }, { role: 'user', content: '继续' }];
  assert.equal((await compactMessages(cfg, short, [], { stream })).messages, short);
  requests = 0;
  assert.equal((await compactMessages(cfg, short, [], { manual: true, historyEnd: 2, stream })).cut, 2);
  const boundary = short.map(message => ({ ...message }));
  boundary[2].content += '字'.repeat(799_999 - inspectContext(boundary, []).estimatedTokens);
  assert.equal((await compactMessages(cfg, boundary, [], { stream })).messages, boundary);
  boundary[2].content += '字';
  requests = 0;
  assert.equal((await compactMessages(cfg, boundary, [], { stream })).cut, 2);
  const noGain: typeof streamChat = async function* () { yield { content: '历史摘要'.repeat(20), finishReason: 'stop' }; };
  const tiny: ChatMessage[] = [{ role: 'user', content: '旧' }, { role: 'user', content: '新' }];
  assert.equal((await compactMessages(cfg, tiny, [], { manual: true, stream: noGain })).messages, tiny);
  console.log('context tests passed');
} finally {
  if (originalWindow === undefined) delete process.env.PAW_CONTEXT_WINDOW_TOKENS;
  else process.env.PAW_CONTEXT_WINDOW_TOKENS = originalWindow;
}
