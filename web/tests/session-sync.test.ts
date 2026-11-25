// 启动合并测试：服务端为真相源，本地新建保留，已删会话不复活。
// 运行：pnpm --filter @paw/web test
import assert from 'node:assert/strict';
import type { ContentBlock, Session, ViewMessage } from '@paw/shared';
import { applyEventsToMessage, applyToolDone, mergeSessions } from '../src/lib/session-sync.js';

let pass = 0;
const test = (label: string, fn: () => void) => {
  try { fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};
const s = (id: string): Session => ({ id, title: id, messages: [], updatedAt: 1 });

test('两边都有 → 服务端版本胜出', () => {
  const server = [{ ...s('a'), title: '服务端标题' }];
  const local = [s('a')];
  const merged = mergeSessions(server, local, new Set());
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, '服务端标题');
});

test('启动竞态：拉取完成前新建的会话不丢', () => {
  const server = [s('old')];
  const local = [s('fresh'), s('old')]; // fresh 是拉取返回前用户刚建的
  const merged = mergeSessions(server, local, new Set(['fresh']));
  assert.deepEqual(merged.map((x) => x.id), ['fresh', 'old']);
});

test('服务端已删除的会话：旧缓存不得复活', () => {
  const server = [s('a')];
  const local = [s('ghost'), s('a')]; // ghost 只存在于旧缓存
  const merged = mergeSessions(server, local, new Set());
  assert.deepEqual(merged.map((x) => x.id), ['a']);
});

test('成功拉到空列表 → 如实清空（除本次新建）', () => {
  const merged = mergeSessions([], [s('ghost'), s('fresh')], new Set(['fresh']));
  assert.deepEqual(merged.map((x) => x.id), ['fresh']);
});

test('并行子代理共用 tool_call id：外层 tool_done 不得覆盖对方卡片正文', () => {
  const blocks: ContentBlock[] = [
    { type: 'tool-call', id: 'same-id', name: 'subagent', summary: '探 ManoHarness', subagent: { id: 'sub-a', name: '探 ManoHarness', agentName: 'code-explorer', status: 'running', steps: [] } },
    { type: 'tool-call', id: 'same-id', name: 'subagent', summary: '探 crmdev', subagent: { id: 'sub-b', name: '探 crmdev', agentName: 'code-explorer', status: 'running', steps: [] } },
  ];
  const next = applyToolDone(blocks, { type: 'tool_done', id: 'same-id', name: 'subagent', ok: true, output: 'crmdev 的结论（后完成）' });
  const a = next[0] as Extract<ContentBlock, { type: 'tool-call' }>;
  assert.equal(a.output, undefined, '第一张卡片正文不能被覆盖');
  assert.equal(a.ok, true, '状态仍要更新');
});

test('普通工具：tool_done 照常写 output', () => {
  const blocks: ContentBlock[] = [{ type: 'tool-call', id: 't1', name: 'read_file', summary: '读文件' }];
  const next = applyToolDone(blocks, { type: 'tool_done', id: 't1', name: 'read_file', ok: true, output: '内容' });
  assert.equal((next[0] as Extract<ContentBlock, { type: 'tool-call' }>).output, '内容');
});

test('applyEventsToMessage：并行子代理乱序到达 subagent_start 时按 toolCallId 精确归位，内部步骤按 id 配对', () => {
  const init: ViewMessage = { id: 'm1', role: 'assistant', content: [], ts: 1 };
  const updated = applyEventsToMessage(init, [
    { type: 'reasoning', delta: '先拆两个探查' },
    { type: 'text', delta: '开始' },
    { type: 'text', delta: '并行探查：' },
    { type: 'tool_start', id: 'call-1', name: 'subagent', summary: '探后端' },
    { type: 'tool_start', id: 'call-2', name: 'subagent', summary: '探前端' },
    // 第二个子代理先返回 subagent_start：不能错挂到第一张卡片上
    { type: 'subagent_start', id: 'sub-2', toolCallId: 'call-2', name: '探前端', agentName: 'code-explorer', task: 'web' },
    { type: 'subagent_start', id: 'sub-1', toolCallId: 'call-1', name: '探后端', agentName: 'code-explorer', task: 'server' },
    // 子代理内部并行两个同名 read_file，第二个先失败返回
    { type: 'subagent_event', id: 'sub-1', event: { type: 'tool_start', id: 'in-1', name: 'read_file', summary: '读 a.ts' } },
    { type: 'subagent_event', id: 'sub-1', event: { type: 'tool_start', id: 'in-2', name: 'read_file', summary: '读 b.ts' } },
    { type: 'subagent_event', id: 'sub-1', event: { type: 'tool_done', id: 'in-2', name: 'read_file', ok: false, output: 'err' } },
    { type: 'subagent_event', id: 'sub-1', event: { type: 'tool_done', id: 'in-1', name: 'read_file', ok: true, output: 'ok' } },
    { type: 'subagent_done', id: 'sub-2', status: 'completed', summary: '前端结论', seconds: 2, rounds: 1 },
    { type: 'subagent_done', id: 'sub-1', status: 'completed', summary: '后端结论', seconds: 3, rounds: 2 },
  ]);

  assert.equal(updated.reasoning, '先拆两个探查');
  assert.equal(updated.content[0]?.type, 'text');
  if (updated.content[0]?.type === 'text') assert.equal(updated.content[0].text, '开始并行探查：');
  const card1 = updated.content[1] as Extract<ContentBlock, { type: 'tool-call' }>;
  const card2 = updated.content[2] as Extract<ContentBlock, { type: 'tool-call' }>;
  assert.equal(card1.subagent?.id, 'sub-1', 'call-1 应绑定 sub-1');
  assert.equal(card2.subagent?.id, 'sub-2', 'call-2 应绑定 sub-2');
  assert.equal(card1.output, '后端结论');
  assert.equal(card2.output, '前端结论');
  assert.equal(card1.subagent?.steps[0]?.ok, true, 'in-1 应保持成功');
  assert.equal(card1.subagent?.steps[1]?.ok, false, 'in-2 应精确标记失败');
});

console.log(`\n${pass}/7 通过`);
