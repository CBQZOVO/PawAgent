// 调度规则 + 消息组装的纯函数测试（零依赖，tsx 直跑）
// 运行：pnpm --filter @paw/server test
import assert from 'node:assert/strict';
import { assistantFinalText, assistantHistoryMessages, assistantHistoryText, toolStepSummary, type ChatMessage, type ScheduledTask } from '@paw/shared';
import { cronMatches, biweeklyDue } from '../src/scheduler.js';
import { composeChatMessages } from '../src/chat-input.js';
import { normalizeQuestions } from '../src/tools/ask-user.js';

let pass = 0;
const test = (label: string, fn: () => void) => {
  try { fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

const d = (s: string) => new Date(s);

// ---------- cron ----------
test('*/15 每 15 分钟触发（0/15/30/45）', () => {
  const cron = '*/15 * * * *';
  assert.equal(cronMatches(cron, d('2026-11-20T10:00:00')), true);
  assert.equal(cronMatches(cron, d('2026-11-20T10:15:00')), true);
  assert.equal(cronMatches(cron, d('2026-11-20T10:14:00')), false);
  assert.equal(cronMatches(cron, d('2026-11-20T10:45:00')), true);
});

test('普通列举与范围仍正常', () => {
  assert.equal(cronMatches('0 9 * * 1-5', d('2026-11-20T09:00:00')), true);  // 周五
  assert.equal(cronMatches('0 9 * * 1-5', d('2026-11-21T09:00:00')), false); // 周六
  assert.equal(cronMatches('0 9 * 11 1', d('2026-11-16T09:00:00')), true);   // 11月周一
});

// ---------- biweekly ----------
const biTask = (createdAt: number, startDate?: string): ScheduledTask => ({
  id: 't1', name: '双周报', prompt: '写周报', model: 'm', skillIds: [],
  cron: '0 9 * * 1', repeat: 'biweekly', time: '09:00', startDate, endDate: undefined,
  wecomPush: false, enabled: true, createdAt,
});
test('双周：锚点周触发，下一周不触发，隔周再触发', () => {
  const t = biTask(new Date('2026-11-02T00:00:00').getTime()); // 锚点 11-02（周一）
  assert.equal(biweeklyDue(t, d('2026-11-02T09:00:00')), true);  // 第 0 周
  assert.equal(biweeklyDue(t, d('2026-11-09T09:00:00')), false); // 第 1 周
  assert.equal(biweeklyDue(t, d('2026-11-16T09:00:00')), true);  // 第 2 周
});
test('双周：锚点之前不触发；有 startDate 用 startDate 做锚点', () => {
  const t = biTask(new Date('2026-11-02T00:00:00').getTime(), '2026-11-05');
  assert.equal(biweeklyDue(t, d('2026-11-02T09:00:00')), false); // 锚点 11-05 之前
  assert.equal(biweeklyDue(t, d('2026-11-05T09:00:00')), true);
});

test('工具步骤：read_file 未传 summary 时按路径生成描述', () => {
  assert.equal(toolStepSummary('read_file', { path: '/tmp/a/project.ts' }), '读取 project.ts');
  assert.equal(toolStepSummary('search_content', { pattern: 'model.yaml' }), '搜索 model.yaml');
  assert.equal(toolStepSummary('read_file', {}, '用户自填'), '用户自填');
});

// ---------- composeChatMessages ----------
const base = [{ role: 'user' as const, content: '帮我看看' }];

test('技能 + 附件同时使用：技能全文在、附件正文不进模型', () => {
  const r = composeChatMessages({
    messages: base,
    skillBlocks: [{ id: 'report', content: 'SKILL 全文指令' }],
    attachments: [{ name: '数据.csv', content: 'a,b,c', size: 5, mime: 'text/csv', kind: 'file' }],
    canSeeImages: true,
  });
  const content = r.messages[r.messages.length - 1].content;
  assert.ok(content.includes('<skill name="report">'), '技能全文应注入');
  assert.ok(content.includes('SKILL 全文指令'), '技能正文不能被附件覆盖');
  assert.ok(content.includes('<file name="数据.csv"'), '附件清单应注入');
  assert.ok(!content.includes('\na,b,c\n'), '附件正文不应进入模型');
  assert.ok(content.includes('document_text'), '应提示模型用解析工具');
  assert.deepEqual(r.imageUrls, []);
});

test('右键引用：文件、文件夹、代码片段三种都能注入，name 保留行号/目录标记', () => {
  const r = composeChatMessages({
    messages: base,
    skillBlocks: [],
    attachments: [
      { name: 'src/App.tsx', content: 'export default function App() {}', size: 32, mime: 'text/typescript', kind: 'file' },
      { name: 'src/components/', content: '（文件夹，共 2 项）\nApp.tsx\nhooks/', size: 34, mime: 'text/plain', kind: 'file' },
      { name: 'src/App.tsx:36-42', content: 'const a = 1;', size: 12, mime: 'text/typescript', kind: 'file' },
    ],
    canSeeImages: true,
  });
  const content = r.messages[r.messages.length - 1].content;
  assert.ok(content.includes('<file name="src/App.tsx" mime="text/typescript"'), '整文件要带正确 mime');
  assert.ok(content.includes('<file name="src/components/"'), '文件夹引用保留末尾斜杠');
  assert.ok(content.includes('<file name="src/App.tsx:36-42"'), '片段引用保留行号范围');
  assert.ok(content.includes('（文件夹，共 2 项）'), '文件夹清单要真的进去');
  assert.ok(content.includes('const a = 1;'), '片段正文要真的进去');
  assert.deepEqual(r.imageUrls, [], '纯文本引用不该产生 image part');
});

test('能读图的模型：图片走 image_url，文本只留引用', () => {
  const r = composeChatMessages({
    messages: base,
    skillBlocks: [],
    attachments: [{ name: 'a.png', content: 'data:image/png;base64,XYZ', size: 3, mime: 'image/png', kind: 'image' }],
    canSeeImages: true,
  });
  assert.deepEqual(r.imageUrls, ['data:image/png;base64,XYZ']);
  assert.ok(r.messages[r.messages.length - 1].content.includes('@image#1:a.png'));
  assert.ok(!r.messages[r.messages.length - 1].content.includes('base64'), 'base64 不应拼进文本');
});

test('不能读图的模型：识别文字追加进正文，图片不再走 image_url', () => {
  const r = composeChatMessages({
    messages: base,
    skillBlocks: [],
    attachments: [{ name: 'a.png', content: 'data:image/png;base64,XYZ', size: 3, mime: 'image/png', kind: 'image' }],
    imageDescriptions: ['@image#1: 一只猫'],
    canSeeImages: false,
  });
  assert.deepEqual(r.imageUrls, []);
  assert.ok(r.messages[r.messages.length - 1].content.includes('一只猫'));
});

test('图片落盘后：@ 引用直接用真实路径，编号与 image part 顺序严格一致', () => {
  const img = (name: string, data: string, localPath: string) => ({
    name, content: `data:image/png;base64,${data}`, size: 1, mime: 'image/png', kind: 'image' as const, localPath,
  });
  // 正文里 b 先被引用 → b 是第 1 张图；不能按附件数组顺序编号
  const r = composeChatMessages({
    messages: [{ role: 'user', content: '先看 @"b.png" 再看 @"a.png"' }],
    skillBlocks: [],
    attachments: [img('a.png', 'AAA', '/store/xxx-a.png'), img('b.png', 'BBB', '/store/xxx-b.png')],
    canSeeImages: true,
  });
  const content = r.messages[r.messages.length - 1].content;
  assert.deepEqual(r.imageUrls, ['data:image/png;base64,BBB', 'data:image/png;base64,AAA'], 'image part 按正文出现顺序');
  assert.ok(content.includes('先看 @image#1:/store/xxx-b.png 再看 @image#2:/store/xxx-a.png'), '引用原位替换成真实路径，编号跟 image part 对上');
  assert.ok(!content.includes('base64'), 'base64 不应拼进文本');
});

test('文件附件落盘后：@ 引用同样用真实路径，元信息块保留', () => {
  const r = composeChatMessages({
    messages: base,
    skillBlocks: [],
    attachments: [{ name: '日志.gz', content: '[二进制文件：日志.gz]', size: 100, mime: 'application/gzip', kind: 'file', localPath: '/store/xxx-日志.gz' }],
    canSeeImages: true,
  });
  const content = r.messages[r.messages.length - 1].content;
  assert.ok(content.includes('@"/store/xxx-日志.gz"'), '引用是本机真实路径');
  assert.ok(content.includes('local_path="/store/xxx-日志.gz"'), '元信息块里的路径一致');
});

test('历史消息里的 @ 占位改写成落盘真实路径（最后一条 user 消息除外）', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: '看这张 @"截图1.png" 和 @image:分组.png' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '这次是 @"新建.txt"' },
  ];
  const r = composeChatMessages({
    messages: history,
    skillBlocks: [],
    attachments: [{ name: '新建.txt', content: '内容', size: 2, mime: 'text/plain', kind: 'file' }],
    persistedPaths: { '截图1': '/store/aa-截图1.png', '分组': '/store/bb-分组.png', '新建': '/store/cc-新建.txt' },
    canSeeImages: true,
  });
  assert.ok(!r.messages[0].content.includes('@image:'), '@image: 占位应被改写');
  assert.ok(!r.messages[0].content.includes('@"截图1.png"'), '原文件名占位应被改写');
  assert.ok(r.messages[0].content.includes('@"/store/aa-截图1.png"'), '文件名引用 → 真实路径');
  assert.ok(r.messages[0].content.includes('@"/store/bb-分组.png"'), '@image: 引用 → 真实路径');
  // 最后一条 user 没有落盘路径（附件没传 localPath），占位保持原样
  assert.ok(r.messages[2].content.includes('@"新建.txt"'), '最后一条 user 走本轮附件逻辑');
});

test('历史里多张同名附件（image.png）按出现顺序一一对应各自落盘路径', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: '第一张 @"image.png"' },
    { role: 'assistant', content: '收到1' },
    { role: 'user', content: '第二张 @"image.png"' },
    { role: 'assistant', content: '收到2' },
    { role: 'user', content: '对比一下' },
  ];
  const r = composeChatMessages({
    messages: history,
    skillBlocks: [],
    attachments: [],
    persistedPaths: { image: ['/store/111-image.png', '/store/222-image.png'] },
    canSeeImages: true,
  });
  assert.ok(r.messages[0].content.includes('@"/store/111-image.png"'), '第 1 轮指向第 1 张图');
  assert.ok(r.messages[2].content.includes('@"/store/222-image.png"'), '第 2 轮指向第 2 张图');
});

test('图片没有落盘路径时：引用保留原文件名（行为与之前一致）', () => {
  const r = composeChatMessages({
    messages: base,
    skillBlocks: [],
    attachments: [{ name: 'a.png', content: 'data:image/png;base64,XYZ', size: 3, mime: 'image/png', kind: 'image' }],
    canSeeImages: true,
  });
  assert.ok(r.messages[r.messages.length - 1].content.includes('@image#1:a.png'));
});

test('技能 + 图片 + 文件三件套：顺序追加，互不覆盖', () => {
  const r = composeChatMessages({
    messages: base,
    skillBlocks: [{ id: 's1', content: '技能正文' }],
    attachments: [
      { name: 'b.png', content: 'data:image/png;base64,Y', size: 1, mime: 'image/png', kind: 'image' },
      { name: 'c.txt', content: '文本内容', size: 4, mime: 'text/plain', kind: 'file' },
    ],
    imageDescriptions: ['@image#1: 描述'],
    canSeeImages: false,
  });
  const content = r.messages[r.messages.length - 1].content;
  assert.ok(content.includes('技能正文'));
  assert.ok(content.includes('<file name="c.txt"'));
  assert.ok(!content.includes('\n文本内容\n'), '普通附件正文不应进入模型');
  assert.ok(content.includes('描述'));
  assert.deepEqual(r.imageUrls, []);
});


// ---------- 子代理 ----------
import { AsyncQueue } from '../src/agent/queue.js';
import { loadSubagents } from '../src/agent/agents.js';
import { executeTool } from '../src/tools/index.js';

const atest = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

await atest('系统提示包含证据纪律：没证据不许说完成', async () => {
  const { loadPersonaPrompt } = await import('../src/persona.js');
  const prompt = await loadPersonaPrompt(null);
  assert.match(prompt, /evidence_discipline/);
  assert.match(prompt, /对应的工具结果/);
  assert.match(prompt, /禁止表演式回填/);
  assert.match(prompt, /execution_playbook/);
  assert.match(prompt, /list_dir、search_file/);
});

await atest('AsyncQueue：push 后消费、close 后正常结束', async () => {
  const q = new AsyncQueue<number>();
  q.push(1); q.push(2); q.close();
  const got: number[] = [];
  for await (const v of q) got.push(v);
  assert.deepEqual(got, [1, 2]);
});

await atest('AsyncQueue：先等待后 push 也能收到', async () => {
  const q = new AsyncQueue<string>();
  const consuming = (async () => { const out: string[] = []; for await (const v of q) out.push(v); return out; })();
  setTimeout(() => { q.push('a'); q.close(); }, 10);
  assert.deepEqual(await consuming, ['a']);
});

await atest('内置 code-explorer 定义可加载，白名单不含 subagent/run_command', async () => {
  const defs = await loadSubagents(null);
  const ce = defs.find((d) => d.name === 'code-explorer');
  assert.ok(ce, '应有内置 code-explorer');
  assert.ok(ce!.tools.includes('search_content'));
  assert.ok(!ce!.tools.includes('subagent'), '不能递归');
  assert.ok(!ce!.tools.includes('run_command'), '只读子代理不给 shell');
});

await atest('内置 code-review 使用主模型，权限仅限读取代码和差异', async () => {
  const reviewer = (await loadSubagents(null)).find((d) => d.name === 'code-review');
  assert.ok(reviewer);
  assert.equal(reviewer.model, undefined);
  assert.deepEqual([...reviewer.tools].sort(), ['git_diff', 'git_status', 'read_file', 'search_content']);
});

await atest('白名单硬校验：子代理点名 run_command 被拒绝', async () => {
  const r = await executeTool('run_command', { cmd: 'echo hi' }, 'tc1', { allowedTools: ['read_file'] });
  assert.equal(r.isError, true);
  assert.match(r.content, /白名单/);
});

await atest('深度守卫：depth=1 时 subagent 被拒绝（防递归）', async () => {
  const r = await executeTool('subagent', { subagent_name: 'code-explorer', prompt: 'x' }, 'tc2', {
    depth: 1, gateway: { baseUrl: 'http://x', apiKey: 'k', model: 'm' },
  });
  assert.equal(r.isError, true);
  assert.match(r.content, /递归/);
});

await atest('未知子代理名：报错并列出可用清单', async () => {
  const r = await executeTool('subagent', { subagent_name: 'nope', prompt: 'x' }, 'tc3', {
    gateway: { baseUrl: 'http://x', apiKey: 'k', model: 'm' }, workspace: null,
  });
  assert.equal(r.isError, true);
  assert.match(r.content, /code-explorer/);
});

// ---------- 高效工具集：编辑/后台/抓取/记忆/待办/git ----------
import { mkdtemp, readFile as fsRead, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { htmlToText } from '../src/tools/web-fetch.js';

const tmp = await mkdtemp(path.join(tmpdir(), 'paw-tools-'));

await atest('write_file：创建文件（自动建父目录）', async () => {
  const r = await executeTool('write_file', { path: 'a/b/hello.txt', content: 'line1\nline2\n' }, 'w1', { workspace: tmp });
  assert.equal(r.isError, false);
  assert.match(r.content, /已创建/);
  assert.equal(await fsRead(path.join(tmp, 'a/b/hello.txt'), 'utf-8'), 'line1\nline2\n');
});

await atest('edit_file：精确替换 + 行号摘要', async () => {
  const r = await executeTool('edit_file', { path: 'a/b/hello.txt', old_string: 'line2', new_string: 'LINE-TWO' }, 'e1', { workspace: tmp });
  assert.equal(r.isError, false);
  assert.match(r.content, /第 2 行/);
  assert.equal(await fsRead(path.join(tmp, 'a/b/hello.txt'), 'utf-8'), 'line1\nLINE-TWO\n');
});

await atest('edit_file：old_string 不唯一时拒绝（除非 replace_all）', async () => {
  await executeTool('write_file', { path: 'dup.txt', content: 'x\nx\n' }, 'w2', { workspace: tmp });
  const r = await executeTool('edit_file', { path: 'dup.txt', old_string: 'x', new_string: 'y' }, 'e2', { workspace: tmp });
  assert.equal(r.isError, true);
  assert.match(r.content, /不唯一/);
  const r2 = await executeTool('edit_file', { path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true }, 'e3', { workspace: tmp });
  assert.equal(r2.isError, false);
  assert.match(r2.content, /2 处/);
});

await atest('edit_file：找不到 old_string 报错提示先 read_file', async () => {
  const r = await executeTool('edit_file', { path: 'a/b/hello.txt', old_string: '不存在的内容', new_string: 'x' }, 'e4', { workspace: tmp });
  assert.equal(r.isError, true);
  assert.match(r.content, /read_file/);
});

await atest('写文件工具：必填参数缺失直接报错，不清空文件、不建 undefined 路径', async () => {
  const target = path.join(tmp, 'a/b/hello.txt');
  const before = await fsRead(target, 'utf-8');
  const noContent = await executeTool('write_file', { path: 'a/b/hello.txt' }, 'w3', { workspace: tmp });
  assert.equal(noContent.isError, true);
  assert.equal(await fsRead(target, 'utf-8'), before, '缺 content 不能把已有文件清空');
  const noPath = await executeTool('write_file', { content: 'x' }, 'w4', { workspace: tmp });
  assert.equal(noPath.isError, true);
  await assert.rejects(fsRead(path.join(tmp, 'undefined')));
  const noOld = await executeTool('edit_file', { path: 'a/b/hello.txt', new_string: 'X', replace_all: true }, 'e5', { workspace: tmp });
  assert.equal(noOld.isError, true);
  assert.equal(await fsRead(target, 'utf-8'), before, '缺 old_string 不能把文件改坏');
});

await atest('delete_file：移入废纸篓可恢复，拒绝目录', async () => {
  const r = await executeTool('delete_file', { path: 'dup.txt' }, 'd1', { workspace: tmp });
  assert.equal(r.isError, false);
  assert.match(r.content, /废纸篓/);
  const r2 = await executeTool('delete_file', { path: 'a' }, 'd2', { workspace: tmp });
  assert.equal(r2.isError, true);
  assert.match(r2.content, /不删目录/);
});

await atest('read_file：行号前缀 + offset/limit 范围', async () => {
  const r = await executeTool('read_file', { path: 'a/b/hello.txt', offset: 2, limit: 1 }, 'r1', { workspace: tmp });
  assert.equal(r.isError, false);
  assert.match(r.content, /^2\tLINE-TWO/);
});

await atest('run_command 后台：job_id → get_terminal_output → kill_job', async () => {
  const r = await executeTool('run_command', { cmd: 'echo start; sleep 5; echo end', background: true }, 'b1', { workspace: tmp });
  assert.equal(r.isError, false);
  const jobId = r.content.match(/job-[\w-]+/)?.[0];
  assert.ok(jobId, '应返回 job_id');
  const out = await executeTool('get_terminal_output', { job_id: jobId, wait_seconds: 2 }, 'b2', {});
  assert.match(out.content, /start/);
  assert.match(out.content, /running/);
  const killed = await executeTool('kill_job', { job_id: jobId }, 'b3', {});
  assert.match(killed.content, /终止/);
  const list = await executeTool('list_jobs', {}, 'b4', {});
  assert.match(list.content, /killed|exited/);
});

await atest('run_command 后台：停止信号会杀掉本轮启动的 detached 进程', async () => {
  const ctrl = new AbortController();
  const r = await executeTool('run_command', { cmd: 'echo running; sleep 30', background: true }, 'ab1', { workspace: tmp, signal: ctrl.signal });
  const jobId = r.content.match(/job-[\w-]+/)?.[0];
  assert.ok(jobId, '应返回 job_id');
  ctrl.abort();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const out = await executeTool('get_terminal_output', { job_id: jobId }, 'ab2', {});
  assert.match(out.content, /killed/);
});

await atest('run_command daemon=true：单轮停止信号不会误杀常驻服务，kill_job 可正常终止', async () => {
  const ctrl = new AbortController();
  const r = await executeTool('run_command', { cmd: 'echo daemon-ready; sleep 30', daemon: true }, 'dm1', { workspace: tmp, signal: ctrl.signal });
  assert.equal(r.isError, false);
  const jobId = r.content.match(/job-[\w-]+/)?.[0];
  assert.ok(jobId);
  assert.match(r.content, /pid=\d+/);
  ctrl.abort(); // 模拟用户停止本轮对话
  await new Promise((resolve) => setTimeout(resolve, 250));
  const list = await executeTool('list_jobs', {}, 'dm2', {});
  assert.match(list.content, new RegExp(`\\[${jobId}\\] running .*pid=\\d+ · daemon`));
  await executeTool('kill_job', { job_id: jobId }, 'dm3', {});
});

await atest('run_command 前台含后台子进程持有管道时不卡满 30s 超时', async () => {
  const t0 = Date.now();
  const r = await executeTool('run_command', { cmd: 'sleep 5 >/dev/null 2>&1 & echo launched; wait_pid=$!; kill $wait_pid 2>/dev/null || true' }, 'fg1', { workspace: tmp, signal: undefined });
  assert.equal(r.isError, false);
  assert.match(r.content, /launched/);
  assert.ok(Date.now() - t0 < 3000, '应在 3s 内返回');
});

test('assistantHistoryText：保留脚本路径、daemon job_id、中断与未复述的子代理摘要', () => {
  const plain = assistantHistoryText({ content: [{ type: 'text', text: '普通回答' }] });
  assert.equal(plain, '普通回答');
  const rich = assistantHistoryText({
    stopped: true,
    content: [
      { type: 'text', text: '先起服务再探查' },
      { type: 'tool-call', id: '1', name: 'write_file', args: { path: '/tmp/rag_service.py' }, ok: true },
      { type: 'tool-call', id: '2', name: 'run_command', args: { cmd: 'python rag_service.py', daemon: true }, ok: true, output: '常驻服务已启动: job-9-abc (pid=12345)' },
      { type: 'tool-call', id: '3', name: 'subagent', args: { description: '读RAG DTO' }, ok: true, output: 'KnowHttpResponse 字段为 request_id 下划线' },
    ],
  });
  assert.match(rich, /write_file\(\/tmp\/rag_service\.py\)/);
  assert.match(rich, /job-9-abc/);
  assert.match(rich, /pid=12345/);
  assert.match(rich, /request_id 下划线/);
  assert.match(rich, /本轮被用户中途停止/);
});

test('assistantFinalText & assistantHistoryMessages：剥离中间过程与伪造记录，最近轮次保留真实 tool_calls 对', () => {
  const msg = {
    content: [
      { type: 'text' as const, text: '先跑一下生产端点。' },
      { type: 'tool-call' as const, id: 't1', name: 'run_command', args: { cmd: 'python3 verify.py', background: true }, ok: true, output: '后台任务已启动: job-1-abc (pid=1234)' },
      { type: 'text' as const, text: '再看看日志。' },
      { type: 'tool-call' as const, id: 't2', name: 'write_file', args: { path: '/tmp/a.txt', content: 'x'.repeat(500) }, ok: true, output: '已写入 /tmp/a.txt' },
      { type: 'text' as const, text: '最终结论：全部通过。\n\n[本轮工具记录：run_command(bg job-9-fake)]' },
    ],
  };

  // 只取最后一个工具之后的最终结论，且剥掉泄漏的 [本轮工具记录：...]
  assert.equal(assistantFinalText(msg), '最终结论：全部通过。');

  // 较早轮次：仅保留最终结论，不含 [本轮工具记录] 和中间独白
  const older = assistantHistoryMessages(msg, { includeToolCalls: false, turnIndex: 1 });
  assert.equal(older.length, 1);
  assert.equal(older[0].role, 'assistant');
  assert.equal(older[0].content, '最终结论：全部通过。');
  assert.ok(!older[0].content.includes('先跑一下'));
  assert.ok(!older[0].content.includes('本轮工具记录'));

  // 最近轮次：保留配对的 assistant(tool_calls) + tool + assistant(final)
  const recent = assistantHistoryMessages(msg, { includeToolCalls: true, turnIndex: 7 });
  assert.equal(recent.length, 4);
  assert.equal(recent[0].role, 'assistant');
  assert.equal(recent[0].tool_calls?.length, 2);
  assert.deepEqual(recent[0].tool_calls?.map((c) => c.id), ['hist_7_0', 'hist_7_1']);
  assert.doesNotThrow(() => JSON.parse(recent[0].tool_calls![1].arguments));
  assert.equal(recent[1].role, 'tool');
  assert.equal(recent[1].tool_call_id, 'hist_7_0');
  assert.match(recent[1].content, /job-1-abc/);
  assert.equal(recent[2].role, 'tool');
  assert.equal(recent[2].tool_call_id, 'hist_7_1');
  assert.equal(recent[3].role, 'assistant');
  assert.equal(recent[3].content, '最终结论：全部通过。');
});

await atest('web_fetch：htmlToText 剥标签/实体/脚本', async () => {
  const { title, text } = htmlToText('<html><head><title>T&amp;T</title><script>bad()</script></head><body><h1>标题</h1><p>你好&nbsp;世界</p><ul><li>甲</li><li>乙</li></ul></body></html>');
  assert.equal(title, 'T&T');
  assert.ok(!text.includes('bad()'));
  assert.match(text, /标题/);
  assert.match(text, /你好 世界/);
  assert.match(text, /• 甲/);
});

await atest('web_fetch：正文里的 < 和属性值里的 > 不再吞掉后续内容', async () => {
  const { text } = htmlToText('<html><body><p>宽度 < 40rem) <link href="a>b" rel="stylesheet" data-target="desk" /> 正常</p></body></html>');
  assert.match(text, /宽度 < 40rem\)/);
  assert.match(text, /正常/);
  assert.ok(!text.includes('rel="stylesheet"'));
});

await atest('memory：save → search → 更新 → delete 全链路', async () => {
  const saved = await executeTool('memory_save', { title: '测试记忆-工具集', content: 'Paw 工具集测试专用条目', tags: '测试' }, 'm1', {});
  assert.equal(saved.isError, false);
  const id = saved.content.match(/mem-[\w-]+/)?.[0];
  assert.ok(id);
  const found = await executeTool('memory_search', { query: '工具集测试' }, 'm2', {});
  assert.match(found.content, /Paw 工具集测试专用条目/);
  const upd = await executeTool('memory_save', { id, title: '测试记忆-工具集', content: '更新后的内容' }, 'm3', {});
  assert.match(upd.content, /已更新/);
  const del = await executeTool('memory_delete', { id }, 'm4', {});
  assert.match(del.content, /已删除/);
  const gone = await executeTool('memory_search', { query: '更新后的内容' }, 'm5', {});
  assert.match(gone.content, /没有匹配/);
});

await atest('memory：workspace 维度隔离（项目记忆互不可见）', async () => {
  const saved = await executeTool('memory_save', { title: '测试记忆-项目隔离', content: '项目A专属内容xyz' }, 'w1', { workspace: '/tmp/paw-test-projA' });
  const idA = saved.content.match(/mem-[\w-]+/)?.[0];
  assert.ok(idA);
  // 项目 B 搜不到项目 A 的记忆
  const inB = await executeTool('memory_search', { query: '项目A专属' }, 'w2', { workspace: '/tmp/paw-test-projB' });
  assert.match(inB.content, /没有匹配/);
  // 项目 A 自己能搜到
  const inA = await executeTool('memory_search', { query: '项目A专属' }, 'w3', { workspace: '/tmp/paw-test-projA' });
  assert.match(inA.content, /项目A专属内容xyz/);
  await executeTool('memory_delete', { id: idA }, 'w4', {});
});

await atest('worklog：插入 → 按日/按项目查询 → worklog_search 可读', async () => {
  const { insertWorkLog, listWorkLogs, deleteWorkLog } = await import('../src/tools/worklog.js');
  const id = insertWorkLog({ workspace: '/tmp/paw-test-projA', title: '测试日志条目', content: '工作日志测试内容abc', day: '2026-11-24' });
  try {
    const logs = listWorkLogs({ day: '2026-11-24', days: 1 });
    assert.ok(logs.some((l) => l.id === id && l.title === '测试日志条目'));
    const scoped = listWorkLogs({ workspace: '/tmp/paw-test-projA', day: '2026-11-24', days: 1 });
    assert.ok(scoped.some((l) => l.id === id));
    const other = listWorkLogs({ workspace: '/tmp/paw-test-projB', day: '2026-11-24', days: 1 });
    assert.ok(!other.some((l) => l.id === id));
    const { executeWorklogTool } = await import('../src/tools/worklog.js');
    const out = await executeWorklogTool('worklog_search', { date: '2026-11-24', query: '测试内容abc' });
    assert.match(out, /测试日志条目/);
    assert.match(out, /paw-test-projA/);
  } finally {
    deleteWorkLog(id);
  }
});

await atest('todo_write：支持并行多项 in_progress，且声明为 readOnly 不阻塞只读并发', async () => {
  const { pawPlugins } = await import('../src/plugins/index.js');
  assert.equal(pawPlugins.isReadOnly('todo_write'), true, 'todo_write 应标记为 readOnly 以免拆散同轮只读并发');
  const r = await executeTool('todo_write', { todos: [
    { content: '步骤一', status: 'completed' },
    { content: '并行分支A', status: 'in_progress' },
    { content: '并行分支B', status: 'in_progress' },
  ] }, 't1', {});
  assert.equal(r.isError, false);
  assert.match(r.content, /1\/3 完成/);
});

await atest('git_status/git_log：在 git 仓库里能跑', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFile: writeFs } = await import('node:fs/promises');
  const tmpRepo = await mkdtemp(path.join(tmpdir(), 'paw-git-test-'));
  try {
    execFileSync('git', ['init'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Paw Test'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo, stdio: 'ignore' });
    await writeFs(path.join(tmpRepo, 'README.md'), 'hello\n');
    execFileSync('git', ['add', 'README.md'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpRepo, stdio: 'ignore' });
    const st = await executeTool('git_status', {}, 'g1', { workspace: tmpRepo });
    assert.equal(st.isError, false);
    const lg = await executeTool('git_log', { count: 3 }, 'g2', { workspace: tmpRepo });
    assert.equal(lg.isError, false);
    assert.match(lg.content, /[0-9a-f]{7} /);
  } finally {
    await rm(tmpRepo, { recursive: true, force: true });
  }
});

// ---------- 子代理二期：fork / 结构化校验 / 并行 ----------
import { validateSchemaForTest, forkContextForTest } from '../src/agent/subagent.js';

await atest('validateSchema：required 缺失 / 类型错 / 枚举 / 嵌套数组', async () => {
  const schema = {
    type: 'object',
    required: ['files', 'verdict'],
    properties: {
      files: { type: 'array', items: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, line: { type: 'integer' } } } },
      verdict: { type: 'string', enum: ['ok', 'bad'] },
    },
  };
  assert.deepEqual(validateSchemaForTest({ files: [{ path: 'a.ts', line: 3 }], verdict: 'ok' }, schema), []);
  const errs = validateSchemaForTest({ files: [{ line: 'x' }], verdict: 'maybe' }, schema);
  assert.ok(errs.some((e) => e.includes('path')));
  assert.ok(errs.some((e) => e.includes('integer')));
  assert.ok(errs.some((e) => e.includes('枚举')));
});

await atest('forkContext：跳过 system、角色标注、保尾截断', async () => {
  const short = forkContextForTest([
    { role: 'system', content: '人设秘密' },
    { role: 'user', content: '问题A' },
    { role: 'assistant', content: '回答B' },
  ]);
  assert.ok(!short.includes('人设秘密'));
  assert.match(short, /\[用户\] 问题A/);
  assert.match(short, /\[主代理\] 回答B/);
  const long = forkContextForTest([
    { role: 'user', content: '早期问题' },
    { role: 'assistant', content: 'y'.repeat(60000) },
    { role: 'assistant', content: '最近的回答B' },
  ]);
  assert.ok(long.length < 50000, '应截断到上限内');
  assert.match(long, /前文已截断/);
  assert.match(long, /最近的回答B/, '保尾：最近内容必须在');
  assert.ok(!long.includes('早期问题'), '截断丢的是前文');
});

await atest('structured_output：白名单外不可见；schema 注册进 getAllToolSchemas 需 allowedTools', async () => {
  const { getAllToolSchemas } = await import('../src/tools/index.js');
  const all = await getAllToolSchemas(null);
  assert.ok(!all.some((t) => t.name === 'structured_output'), '主代理不应看到 structured_output');
});

// ---------- Agent 效率与鲁棒性回归测试 ----------
import { writeFile as fsWrite } from 'node:fs/promises';
import { canonicalToolKey, parseToolArguments } from '../src/agent/loop.js';
import { isPrunableTool, pruneToolResult } from '../src/tools/prune.js';

test('parseToolArguments & canonicalToolKey：拒绝非对象 JSON，且防重签名忽略 summary 与字段顺序', () => {
  assert.equal(parseToolArguments('null').bad, true);
  assert.equal(parseToolArguments('[1,2]').bad, true);
  assert.equal(parseToolArguments('"str"').bad, true);
  assert.equal(parseToolArguments('{broken').bad, true);
  assert.deepEqual(parseToolArguments('{"a":1}'), { args: { a: 1 }, bad: false });

  const k1 = canonicalToolKey('read_file', '{"path":"src/a.ts","offset":1,"summary":"第一次读"}');
  const k2 = canonicalToolKey('read_file', '{"summary":"再读一遍确认","offset":1,"path":"src/a.ts"}');
  assert.equal(k1, k2, '仅 summary 或字段顺序不同应视为相同工具调用');
});

await atest('edit_file：兼容 CRLF 文件并保留原文件 \\r\\n 行尾格式', async () => {
  const crlfFile = path.join(tmp, 'crlf.txt');
  await fsWrite(crlfFile, 'alpha\r\nbeta\r\ngamma\r\n', 'utf-8');
  const r = await executeTool('edit_file', {
    path: 'crlf.txt',
    old_string: 'alpha\nbeta',
    new_string: 'alpha\nBETA_NEW',
  }, 'crlf1', { workspace: tmp });
  assert.equal(r.isError, false);
  const updated = await fsRead(crlfFile, 'utf-8');
  assert.equal(updated, 'alpha\r\nBETA_NEW\r\ngamma\r\n', '应成功替换且保持 CRLF 行尾');
});

await atest('read_file：拦截二进制文件并提示改用 document_text', async () => {
  const binFile = path.join(tmp, 'sample.bin');
  await fsWrite(binFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  const r = await executeTool('read_file', { path: 'sample.bin' }, 'bin1', { workspace: tmp });
  assert.equal(r.isError, true);
  assert.match(r.content, /二进制|document_text/);
});

await atest('search_content：并发搜索命中并跳过二进制文件，支持 AbortSignal 取消', async () => {
  await fsWrite(path.join(tmp, 'code1.ts'), 'const targetToken = 42;\n', 'utf-8');
  await fsWrite(path.join(tmp, 'image.png'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const r = await executeTool('search_content', { pattern: 'targetToken' }, 'sc1', { workspace: tmp });
  assert.equal(r.isError, false);
  assert.match(r.content, /code1\.ts:1: const targetToken = 42;/);

  const aborted = new AbortController();
  aborted.abort();
  const rAbort = await executeTool('search_content', { pattern: 'targetToken' }, 'sc2', { workspace: tmp, signal: aborted.signal });
  assert.equal(rAbort.isError, true);
});

test('pruneToolResult：覆盖 git_diff/web_fetch/MCP 工具并按工具给出准确提示；大输出全文落盘可读回', () => {
  assert.equal(isPrunableTool('git_diff'), true);
  assert.equal(isPrunableTool('web_fetch'), true);
  assert.equal(isPrunableTool('crm__list_orders'), true);
  assert.equal(isPrunableTool('search_parent_session'), true);
  assert.equal(isPrunableTool('todo_write'), false);

  const prevDataDir = process.env.PAW_DATA_DIR;
  process.env.PAW_DATA_DIR = tmp; // 落盘指向测试临时目录，别污染真实 ~/.paw
  try {
    const big = 'A'.repeat(20_000);
    const prunedRead = pruneToolResult(big, 1, 'read_file');
    assert.match(prunedRead, /offset\/limit/);
    const m = prunedRead.match(/完整输出已保存到 (.+?\.txt)（/);
    assert.ok(m, '裁剪提示应包含全文落盘路径');
    assert.equal(readFileSync(m[1], 'utf-8'), big, '落盘文件应保存未裁剪的全文');
    const prunedGit = pruneToolResult(big, 3, 'git_diff');
    assert.match(prunedGit, /file 参数/);
  } finally {
    if (prevDataDir === undefined) delete process.env.PAW_DATA_DIR;
    else process.env.PAW_DATA_DIR = prevDataDir;
  }
});

// ---------- 会话交接（Session Handoff）与 search_parent_session ----------
import { extractDeterministicState, generateHandoffBrief } from '../src/agent/handoff.js';
import { formatHandoffBlock, type HandoffContext, type ViewMessage } from '@paw/shared';

test('extractDeterministicState：精确提取改动文件、未完待办、常驻服务与环境配置', () => {
  const msgs: ViewMessage[] = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '开工' }], ts: 1, skillIds: ['s1'], connectionCode: 'erp' },
    {
      id: 'a1', role: 'assistant', model: 'qwen4-max', ts: 2,
      todos: [
        { content: '改后端', status: 'completed' },
        { content: '补测试', status: 'in_progress' },
        { content: '发版', status: 'pending' },
      ],
      content: [
        { type: 'tool-call', id: 't1', name: 'edit_file', args: { path: 'server/src/index.ts' }, ok: true },
        { type: 'tool-call', id: 't2', name: 'edit_file', args: { path: 'server/src/index.ts' }, ok: true },
        { type: 'tool-call', id: 't3', name: 'write_file', args: { path: 'bad.ts' }, ok: false },
      ],
    },
  ];
  const st = extractDeterministicState(msgs, ['job-1 (pid=99): pnpm dev']);
  assert.deepEqual(st.changedFiles, ['server/src/index.ts']);
  assert.deepEqual(st.pendingTodos, ['[进行中] 补测试', '发版']);
  assert.deepEqual(st.activeDaemons, ['job-1 (pid=99): pnpm dev']);
  assert.deepEqual(st.skillIds, ['s1']);
  assert.equal(st.connectionCode, 'erp');
  assert.equal(st.model, 'qwen4-max');
});

await atest('generateHandoffBrief & composeChatMessages：附加工程快照且交接块幂等注入', async () => {
  const res = await generateHandoffBrief({ baseUrl: '', apiKey: '', model: 'm' }, {
    sessionId: 'src-1',
    sessionTitle: '重构网关',
    chatMessages: [{ role: 'user', content: '修一下流式解析' }, { role: 'assistant', content: '已定位到 client.ts' }],
    viewMessages: [{
      id: 'a1', role: 'assistant', ts: 1,
      todos: [{ content: '跑回归测试', status: 'pending' }],
      content: [{ type: 'tool-call', id: 'e1', name: 'edit_file', args: { path: 'server/src/gateway/client.ts' }, ok: true }],
    }],
    goal: '继续补单测',
    workspace: '/repo/paw',
    stream: async function* () {
      yield { content: '### 当前目标与约束\n修流式解析并补单测', finishReason: 'stop' };
    },
  });
  assert.equal(res.suggestedTitle, '继续补单测');
  assert.match(res.handoff.summary, /server\/src\/gateway\/client\.ts/);
  assert.match(res.handoff.summary, /跑回归测试/);
  assert.equal(res.inherited.workspace, '/repo/paw');

  const h: HandoffContext = res.handoff;
  const once = composeChatMessages({ messages: base, skillBlocks: [], attachments: [], handoff: h, canSeeImages: true });
  assert.match(once.messages[0].content, /<handoff_context/);
  // 若前端已通过 formatHandoffBlock 内联，不再重复注入
  const preInlined = [{ role: 'user' as const, content: formatHandoffBlock(h) + '\n\n继续' }];
  const twice = composeChatMessages({ messages: preInlined, skillBlocks: [], attachments: [], handoff: h, canSeeImages: true });
  assert.equal(twice.messages[0].content.match(/<handoff_context/g)?.length, 1);
});

await atest('getAllToolSchemas：仅在交接会话（hasParentSession）暴露 search_parent_session', async () => {
  const { getAllToolSchemas } = await import('../src/tools/index.js');
  const normal = await getAllToolSchemas(null);
  assert.ok(!normal.some((t) => t.name === 'search_parent_session'), '普通会话不应暴露 search_parent_session');
  const handed = await getAllToolSchemas(null, { hasParentSession: true });
  assert.ok(handed.some((t) => t.name === 'search_parent_session'), '交接会话应注册 search_parent_session');
});

test('normalizeQuestions：兼容对象型 options（label/description/text/value），杜绝 [object Object]', () => {
  const qs = normalizeQuestions([
    {
      question: '选择方案',
      multiSelect: true,
      options: [
        { label: '方案A', description: '走生产 ingpt' },
        { text: '方案B' },
        { value: '方案C', desc: '仅本地' },
        '纯字符串选项',
        '[object Object]',
      ],
    },
  ]);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].multiple, true);
  assert.deepEqual(qs[0].options, ['方案A — 走生产 ingpt', '方案B', '方案C — 仅本地', '纯字符串选项']);
});

await atest('循环流畅性回归：search_content 单大日志文件 + context_lines、read_file 目录降级、run_command 保留 stdout、open_browser、多子仓库 Git', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdir: mkdirFs, writeFile: writeFs } = await import('node:fs/promises');
  const box = await mkdtemp(path.join(tmpdir(), 'paw-fluency-'));
  try {
    // 1) search_content：>2MB 的单日志文件不静默跳过，且支持 context_lines
    const bigLog = path.join(box, 'app.log');
    const padLine = '2026-11-26 10:58:00 INFO normal heartbeat message padding text 0123456789\n';
    const bigBody = padLine.repeat(32_000) // ~2.3MB > 2MB
      + '2026-11-26 10:58:36 INFO before-context\n'
      + '2026-11-26 10:58:36 ERROR EsBidDocCheckService 获取查重结果明细失败\n'
      + '2026-11-26 10:58:36 WARN after-context-stack\n';
    await writeFs(bigLog, bigBody);
    const sc = await executeTool('search_content', {
      path: bigLog,
      pattern: '获取查重结果明细失败',
      context_lines: 1,
    }, 'sc-big', { workspace: box });
    assert.equal(sc.isError, false);
    assert.match(sc.content, /before-context/);
    assert.match(sc.content, /获取查重结果明细失败/);
    assert.match(sc.content, /after-context-stack/);

    // 2) read_file：传入目录不抛 EISDIR，直接降级返回目录列表
    const rdDir = await executeTool('read_file', { path: box }, 'rf-dir', { workspace: box });
    assert.equal(rdDir.isError, false);
    assert.match(rdDir.content, /app\.log/);

    // 3) run_command：非零退出且同时有 stdout 和 stderr 时，不得丢弃 stdout
    const rc = await executeTool('run_command', {
      cmd: 'echo "PROBE_STDOUT_OK"; echo "MINOR_STDERR_WARN" >&2; exit 1',
    }, 'rc-both', { workspace: box });
    assert.equal(rc.isError, true);
    assert.match(rc.content, /PROBE_STDOUT_OK/, '非零退出时必须保留 stdout 探测输出');
    assert.match(rc.content, /MINOR_STDERR_WARN/);

    // 4) open_browser：合法 http/https 发射事件，非法协议拒绝
    const emitted: unknown[] = [];
    const ob = await executeTool('open_browser', { url: 'v2ex.com', title: 'V2EX' }, 'ob-1', {
      emit: (ev) => emitted.push(ev),
    });
    assert.equal(ob.isError, false);
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], { type: 'open_browser', url: 'https://v2ex.com/', title: 'V2EX' });
    const obBad = await executeTool('open_browser', { url: 'javascript:alert(1)' }, 'ob-2', {});
    assert.equal(obBad.isError, true);

    // 5) 多子仓库工作区：git_log(file="subrepo-a/...") 自动定位子仓库；根目录 git_status 提示子仓库名
    const subRepo = path.join(box, 'subrepo-a');
    await mkdirFs(subRepo, { recursive: true });
    execFileSync('git', ['init'], { cwd: subRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Paw Test'], { cwd: subRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: subRepo, stdio: 'ignore' });
    await writeFs(path.join(subRepo, 'Service.java'), 'class Service {}\n');
    execFileSync('git', ['add', 'Service.java'], { cwd: subRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'add service'], { cwd: subRepo, stdio: 'ignore' });

    const subLog = await executeTool('git_log', { file: 'subrepo-a/Service.java', count: 5 }, 'gl-sub', { workspace: box });
    assert.equal(subLog.isError, false, '传入子仓库内文件路径时应自动路由到子 Git 仓库');
    assert.match(subLog.content, /add service/);

    const rootSt = await executeTool('git_status', {}, 'gs-root', { workspace: box });
    assert.equal(rootSt.isError, true);
    assert.match(rootSt.content, /subrepo-a/, '非 Git 聚合根目录应提示已发现的子 Git 仓库名称');
  } finally {
    await rm(box, { recursive: true, force: true });
  }
});

await rm(tmp, { recursive: true, force: true });

console.log(`\n${pass} 项通过`);
