// IDE 文件服务测试：大目录搜索、大文件部分预览、路径越界防护。
// 用临时目录造真实场景（不依赖用户工作区），运行：pnpm --filter @paw/server test
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listTree, readWorkspaceFile, readWorkspaceImage } from '../src/fs-api.js';

let pass = 0;
let total = 0;
const test = async (label: string, fn: () => Promise<void> | void) => {
  total++;
  try { await fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

const root = await mkdtemp(path.join(tmpdir(), 'paw-fs-test-'));
try {
  // 造一个 900 项的扁平目录（模拟 CRM/igix 的 6300 子目录）
  const big = path.join(root, 'modules');
  await mkdir(big);
  for (let i = 0; i < 900; i++) {
    await mkdir(path.join(big, `mod-${String(i).padStart(4, '0')}-core`));
  }
  await writeFile(path.join(root, 'small.txt'), 'hello\nworld\n');
  // 1.5MB 的多行文件（现在应完整返回，不再截断）
  const manyLines = Array.from({ length: 30000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  await writeFile(path.join(root, 'huge.log'), manyLines);
  // 1.2MB 的单行文件（生成产物，如 ngsummary.json）：同样完整返回
  await writeFile(path.join(root, 'oneline.json'), '{"k":"' + 'a'.repeat(1_200_000) + '"}');
  // 二进制
  await writeFile(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]));
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'node_modules', 'x.js'), 'x');

  await test('目录树跳过 node_modules', async () => {
    const r = await listTree(root, '.');
    assert.ok(!('error' in r));
    if ('error' in r) return;
    assert.ok(!r.entries.some((e) => e.name === 'node_modules'));
  });

  await test('大目录截断到 400 并报告真实总数', async () => {
    const r = await listTree(root, './modules');
    if ('error' in r) throw new Error(r.error);
    assert.equal(r.entries.length, 400);
    assert.equal(r.truncated, true);
    assert.equal(r.total, 900, 'total 必须是真实项数，否则前端没法提示');
  });

  await test('大目录搜索能命中字母序 400 名之后的项（核心修复）', async () => {
    const r = await listTree(root, './modules', 'mod-0850');
    if ('error' in r) throw new Error(r.error);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].name, 'mod-0850-core');
    assert.equal(r.truncated, false);
    // 不搜索时这一项根本不在返回里
    const plain = await listTree(root, './modules');
    if ('error' in plain) throw new Error(plain.error);
    assert.ok(!plain.entries.some((e) => e.name === 'mod-0850-core'));
  });

  await test('搜索大小写不敏感 + 无匹配返回空', async () => {
    const a = await listTree(root, './modules', 'MOD-0001');
    if ('error' in a) throw new Error(a.error);
    assert.equal(a.entries.length, 1);
    const b = await listTree(root, './modules', 'no-such-thing');
    if ('error' in b) throw new Error(b.error);
    assert.equal(b.entries.length, 0);
    assert.equal(b.total, 0);
  });

  await test('小文件完整读取', async () => {
    const r = await readWorkspaceFile(root, './small.txt');
    if ('error' in r) throw new Error(r.error);
    assert.equal(r.content, 'hello\nworld\n');
    assert.equal(r.truncated, false);
    assert.equal(r.notice, undefined);
  });

  await test('1.5MB / 3 万行文件完整返回（不再截到 4000 行）', async () => {
    const r = await readWorkspaceFile(root, './huge.log');
    if ('error' in r) throw new Error(r.error);
    assert.equal(r.lines, 30000);
    assert.equal(r.truncated, false);
    assert.equal(r.notice, undefined);
    assert.ok(r.content.trimEnd().endsWith('line 29999 ' + 'x'.repeat(40)));
  });

  await test('超 20 万行截断到 20 万行并给出说明', async () => {
    await writeFile(path.join(root, 'toomany.txt'),
      Array.from({ length: 210_000 }, (_, i) => `l${i}`).join('\n'));
    const r = await readWorkspaceFile(root, './toomany.txt');
    if ('error' in r) throw new Error(r.error);
    assert.equal(r.lines, 200_000);
    assert.equal(r.truncated, true);
    assert.ok(r.notice?.includes('210000'), '提示里要给出真实总行数');
  });

  await test('超 8MB 只预览前 8MB 并说明（不是拒绝）', async () => {
    await writeFile(path.join(root, 'toobig.log'), ('y'.repeat(79) + '\n').repeat(110_000)); // 8.8MB
    const r = await readWorkspaceFile(root, './toobig.log');
    if ('error' in r) throw new Error(r.error);
    assert.ok(r.content.length > 7 * 1024 * 1024, '必须真的读到 8MB 左右');
    assert.equal(r.truncated, true);
    assert.ok(r.notice?.includes('8MB'));
  });

  await test('1.2MB 单行文件完整返回（大文件不再拒绝）', async () => {
    const r = await readWorkspaceFile(root, './oneline.json');
    if ('error' in r) throw new Error(r.error);
    assert.equal(r.lines, 1);
    assert.equal(r.truncated, false);
    assert.ok(r.content.length > 1_200_000);
  });

  await test('二进制文件识别', async () => {
    const r = await readWorkspaceFile(root, './bin.dat');
    if ('error' in r) throw new Error(r.error);
    assert.equal(r.binary, true);
  });

  await test('目录当文件读 → 报错', async () => {
    const r = await readWorkspaceFile(root, './modules');
    assert.ok('error' in r);
  });

  await test('路径穿越被拦（../../etc/passwd）', async () => {
    const a = await readWorkspaceFile(root, '../../../etc/passwd');
    assert.ok('error' in a);
    assert.equal((a as { error: string }).error, '路径越界');
    const b = await listTree(root, '../../..');
    assert.ok('error' in b);
    const c = await readWorkspaceImage(root, '../../../etc/passwd');
    assert.ok('error' in c);
  });

  await test('不存在的文件 → 报错而非崩溃', async () => {
    const r = await readWorkspaceFile(root, './nope.txt');
    assert.ok('error' in r);
  });

  await test('图片接口只放行图片扩展名', async () => {
    const r = await readWorkspaceImage(root, './small.txt');
    assert.ok('error' in r);
    await writeFile(path.join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const ok = await readWorkspaceImage(root, './pic.png');
    assert.ok(!('error' in ok));
    if ('error' in ok) return;
    assert.equal(ok.mime, 'image/png');
  });

  console.log(`\n${pass}/${total} 通过`);
} finally {
  await rm(root, { recursive: true, force: true });
}