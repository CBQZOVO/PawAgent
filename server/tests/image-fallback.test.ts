// 附件落盘 + @ 引用真实路径 + 视觉兜底模型选择的测试（临时目录 + 假 fetch，不碰真实的 ~/.paw 和网关）
// 运行：pnpm --filter @paw/server test
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Attachment, ChatMessage } from '@paw/shared';
import { listSessionAttachments, nameKey, parseImageDataUrl, persistAttachments } from '../src/attachments.js';
import { resolveVisionModel } from '../src/vision.js';
import { streamChat } from '../src/gateway/client.js';

let pass = 0;
let total = 0;
const test = async (label: string, fn: () => Promise<void> | void) => {
  total++;
  try { await fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const img = (name: string, bytes = PNG, mime = 'image/png'): Attachment => ({
  name, content: `data:${mime};base64,${bytes.toString('base64')}`, size: bytes.length, mime, kind: 'image',
});

// ---------- parseImageDataUrl ----------
await test('data URL 解析：图片正常解析，非图片 / 空 base64 返回 null', () => {
  assert.deepEqual(parseImageDataUrl(img('a.png').content)?.bytes, PNG);
  assert.equal(parseImageDataUrl(img('a.png').content)?.mime, 'image/png');
  assert.equal(parseImageDataUrl('data:text/plain;base64,SGk='), null, '非图片');
  assert.equal(parseImageDataUrl('data:image/png;base64,'), null, '空内容');
  assert.equal(parseImageDataUrl('hello'), null, '不是 data URL');
});

// ---------- persistAttachments ----------
await test('图片落盘：写出真实文件、localPath 指向它、文件名带内容哈希', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'paw-att-'));
  try {
    const a = img('截图1.png');
    const b = img('another-name.png');          // 与 a 内容相同、名字不同 → 各存一份（名字对模型和人都有用）
    const c = img('third.png', Buffer.from([9, 9, 9]));
    const doc: Attachment = { name: 'notes.txt', content: 'hello', size: 5, mime: 'text/plain', kind: 'file' };
    const broken: Attachment = { name: 'bad.png', content: 'data:image/png;base64,', size: 0, mime: 'image/png', kind: 'image' };

    const n = await persistAttachments([a, b, c, doc, broken], { sessionId: 'sess-1', dir });
    assert.equal(n, 4, '三张图 + 一个文本附件落盘');

    // 文件名 = 内容哈希前 12 位 + 原名：内容相同的图哈希相同，重发时据此去重
    assert.equal(path.basename(a.localPath!).slice(0, 12), path.basename(b.localPath!).slice(0, 12), '同内容同哈希');
    assert.ok(path.basename(a.localPath!).endsWith('-截图1.png'), '保留原文件名');

    const files = (await readdir(path.join(dir, 'sess-1'))).sort();
    assert.equal(files.length, 4, '四个不同文件');
    assert.ok(files.every((f) => /\.png$/.test(f) || /\.txt$/.test(f)), '扩展名按真实 MIME / 原扩展名');
    assert.deepEqual(await readFile(a.localPath!), PNG, '文件内容与原图逐字节一致');
    assert.ok((await readFile(doc.localPath!)).toString().includes('hello'), '文本附件也落盘');
    assert.equal(broken.localPath, undefined, '空图片跳过');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('文件附件落盘：带来源路径的拷贝原件，纯文本的写文本；同一份重发不重复写', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'paw-att-'));
  const srcDir = await mkdtemp(path.join(tmpdir(), 'paw-src-'));
  try {
    // 二进制文件（前端读不出内容，只有占位文本）：靠来源路径拷贝
    const srcBin = path.join(srcDir, '日志.log.gz');
    const bin = Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3, 4]);
    await writeFile(srcBin, bin);
    const gz: Attachment = { name: '日志.log.gz', content: '[二进制文件：日志.log.gz]', size: bin.length, mime: 'application/gzip', kind: 'file', localPath: srcBin };
    // 纯文本文件（粘贴的文本附件，无来源路径）：写文本
    const txt: Attachment = { name: '说明.md', content: '# 说明', size: 4, mime: 'text/markdown', kind: 'file' };

    assert.equal(await persistAttachments([gz, txt], { sessionId: 's', dir }), 2);
    assert.deepEqual(await readFile(gz.localPath!), bin, '二进制原件逐字节一致');
    assert.ok((await readFile(txt.localPath!)).toString().includes('# 说明'));

    // 同一份重发：哈希相同 → 同一个文件，不重写（mtime 不变）
    const again: Attachment = { ...gz };
    await persistAttachments([again], { sessionId: 's', dir });
    assert.equal(again.localPath, gz.localPath, '重发拿到同一个路径');
    const st1 = await stat(gz.localPath!);
    const onceMore: Attachment = { ...gz };
    await persistAttachments([onceMore], { sessionId: 's', dir });
    assert.equal((await stat(gz.localPath!)).mtimeMs, st1.mtimeMs, '已存在的文件不重写');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(srcDir, { recursive: true, force: true });
  }
});

await test('IDE 右键引用的工作区文件/文件夹/片段跳过落盘，避免改错副本', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'paw-att-'));
  try {
    const refs: Attachment[] = [
      { name: 'src/App.tsx', content: 'export default function App() {}', size: 32, mime: 'text/typescript', kind: 'file' },
      { name: 'src/components/', content: 'App.tsx', size: 7, mime: 'text/plain', kind: 'file' },
      { name: 'App.tsx:10-20', content: 'const a = 1;', size: 12, mime: 'text/typescript', kind: 'file' },
    ];
    assert.equal(await persistAttachments(refs, { sessionId: 's', dir }), 0, '工作区引用不写盘');
    assert.ok(refs.every((r) => r.localPath === undefined), '不改写为附件副本路径');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('来源文件不存在时跳过，不抛错；没有附件时什么都不做', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'paw-att-'));
  try {
    const ghost: Attachment = { name: 'x.bin', content: '[二进制文件：x.bin]', size: 1, mime: 'application/octet-stream', kind: 'file', localPath: '/nonexistent/x.bin' };
    assert.equal(await persistAttachments([ghost], { sessionId: 's', dir }), 0);
    assert.equal(ghost.localPath, '/nonexistent/x.bin', '保持原样');
    assert.equal(await persistAttachments([], { dir }), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- listSessionAttachments / nameKey ----------
await test('会话附件清单：从目录还原原名→路径映射，按落盘时间排序，会话之间互不可见', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'paw-att-'));
  try {
    const a = img('我的截图.png');
    await persistAttachments([a, img('分 组.png', Buffer.from([1]))], { sessionId: 'sessA', dir });
    // 落盘时间可能同毫秒，手动错开
    await new Promise((r) => setTimeout(r, 5));
    const b = img('b.png', Buffer.from([2]));
    await persistAttachments([b], { sessionId: 'sessA', dir });
    await persistAttachments([img('c.png', Buffer.from([3]))], { sessionId: 'sessB', dir });

    const list = await listSessionAttachments('sessA', dir);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((s) => s.key), ['我的截图', '分_组', 'b'], 'key = nameKey(原名)，空格归一化为下划线');
    assert.ok(list[2].at >= list[0].at, '按落盘时间升序');
    assert.equal(nameKey('我的截图.PNG'), '我的截图', 'nameKey 不区分大小写、忽略扩展名');

    // 原名 → 路径索引能解析回真实文件
    const byKey = Object.fromEntries(list.map((s) => [s.key, s.path]));
    assert.deepEqual(await readFile(byKey['我的截图']), PNG);
    assert.equal((await listSessionAttachments('sessB', dir)).length, 1, '会话隔离');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- resolveVisionModel ----------
const realFetch = globalThis.fetch;
/** 让某个 baseUrl 的 /v1/models 返回指定模型（ids 为空则返回 500）；每个用例用不同 baseUrl 绕开模块级缓存 */
const stubModels = (host: string, ids: string[]) => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.ok(url.startsWith(`http://${host}`) && url.endsWith('/v1/models'), `意外的请求：${url}`);
    return new Response(JSON.stringify(ids ? { data: ids.map((id) => ({ id })) } : {}), { status: ids ? 200 : 500 });
  }) as typeof fetch;
};
const gw = (host: string) => ({ baseUrl: `http://${host}`, apiKey: 'k' });

try {
  await test('视觉模型选择：主模型能读图就用主模型，不跨模型', async () => {
    stubModels('c1', ['glm-5.3-flashx']);
    assert.equal(await resolveVisionModel(gw('c1'), 'hy4flash-free'), 'hy4flash-free');
  });

  await test('视觉模型选择：主模型不能读图时，按优先级挑网关现有模型', async () => {
    stubModels('c2', ['claude-opus-5-5', 'glm-5.3-flashx']);
    assert.equal(await resolveVisionModel(gw('c2'), 'glm-5.4'), 'glm-5.3-flashx', '不选贵旗舰');
    stubModels('c2b', ['claude-sonnet-5-5']);
    assert.equal(await resolveVisionModel(gw('c2b'), 'glm-5.4'), 'claude-sonnet-5-5', '首选都不在时退到白名单里现有的');
  });

  await test('视觉模型选择：网关列表拿不到时退到首选名（让上游报明确错误）', async () => {
    stubModels('c3', []);
    assert.equal(await resolveVisionModel(gw('c3'), 'glm-5.4'), 'glm-5.3-flashx');
  });
} finally {
  globalThis.fetch = realFetch;
}

// ---------- streamChat：图片挂到最后一条 user 消息（跨轮次也不丢） ----------
await test('streamChat：模型调过工具后（数组末尾是 tool 消息），图片仍挂在 user 消息上', async () => {
  const bodies: any[] = [];
  const sse = 'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: [DONE]\n\n';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const messages: ChatMessage[] = [
      { role: 'user', content: '看这张图' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'run_command', arguments: '{}' }] },
      { role: 'tool', tool_call_id: 't1', content: '结果' },
    ];
    const cfg = { baseUrl: 'http://gw-img', apiKey: 'k', model: 'm' };
    for await (const _ of streamChat(cfg, messages, [], ['data:image/png;base64,XYZ'])) { /* 消费完即可 */ }
    assert.equal(bodies.length, 1);
    const sent = bodies[0].messages;
    assert.equal(sent[1].role, 'assistant', 'tool_calls 保持原位');
    assert.ok(Array.isArray(sent[0].content), 'user 消息转成多模态数组');
    assert.equal(sent[0].content.filter((p: any) => p.type === 'image_url').length, 1, '图片挂在 user 消息上');
    assert.equal(sent[0].content[0].type, 'text', '文本 part 在前');
    assert.equal(sent[2].content, '结果', 'tool 消息不受影响');
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${pass}/${total} 通过`);
