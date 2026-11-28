// 本地 Office 预览测试：只验证 URL 构造与不可用回退，不启动真正的 230MB 引擎。
// 运行：pnpm --filter @paw/server exec tsx tests/office-preview.test.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPreviewUrl, downloadOfficeBinary, getOfficeDownloadProgress, getOfficeStatus, installOfficeEngine, resolveOfficeBinary } from '../src/office-engine.js';

let pass = 0;
let total = 0;
const test = async (label: string, fn: () => Promise<void> | void) => {
  total++;
  try { await fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

const freePort = () => 42000 + Math.floor(Math.random() * 20000);
const root = await mkdtemp(path.join(tmpdir(), 'paw-office-test-'));
const saved = {
  port: process.env.PAW_OFFICE_PORT,
  bin: process.env.PAW_OFFICE_BIN,
  data: process.env.PAW_DATA_DIR,
  url: process.env.PAW_OFFICE_URL,
};

try {
  const doc = path.join(root, '季度报告.docx');
  const xlsx = path.join(root, 'data.xlsx');
  const csv = path.join(root, 'data.csv');
  const pptx = path.join(root, 'slides.pptx');
  const pdf = path.join(root, 'manual.pdf');
  const xmind = path.join(root, '脑图.xmind');
  for (const f of [doc, xlsx, csv, pptx, pdf, xmind]) await writeFile(f, 'x');

  const parse = (url: string) => {
    const u = new URL(url);
    return { u, p: u.searchParams, type: u.pathname.split('/')[2] };
  };
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');

  await test('doc 编辑：类型/公共参数/类型参数/editorSdkUrl 全部对齐 WorkBuddy', () => {
    const { u, p, type } = parse(buildPreviewUrl(doc, 'edit', 39177));
    assert.equal(u.protocol, 'http:');
    assert.equal(u.hostname, '127.0.0.1');
    assert.equal(u.port, '39177');
    assert.equal(type, 'doc');
    assert.equal(u.pathname, '/static/doc/pc.html');
    assert.equal(p.get('title'), '季度报告.docx');
    assert.equal(p.get('localFilePath'), doc);
    assert.equal(p.get('globalPadId'), md5(doc));
    assert.equal(p.get('local_edit'), '1');
    assert.equal(p.get('client'), 'sdk_local');
    assert.equal(p.get('mode'), 'edit');
    assert.equal(p.get('toolbar'), 'show');
    assert.equal(p.get('outline'), 'show');
    assert.equal(p.get('statusbar'), 'show');
    assert.equal(p.get('editorSdkUrl'), 'http://127.0.0.1:39177');
  });

  await test('sheet/slide/pdf/mind 类型映射与参数', () => {
    const s = parse(buildPreviewUrl(xlsx, 'edit', 39177));
    assert.equal(s.type, 'sheet');
    assert.equal(s.p.get('client'), 'sdk_local_pure');
    assert.equal(s.p.get('mode'), 'edit');
    assert.equal(parse(buildPreviewUrl(csv)).type, 'sheet');

    const slide = parse(buildPreviewUrl(pptx, 'edit', 39177));
    assert.equal(slide.type, 'slide');
    assert.equal(slide.p.get('client'), 'sdk_local_wb');
    assert.equal(slide.p.get('hideTitlebar'), '1');
    assert.equal(slide.p.get('mode'), null); // slide 编辑态不加 mode

    const pdfUrl = parse(buildPreviewUrl(pdf, 'edit', 39177));
    assert.equal(pdfUrl.type, 'pdf');
    assert.equal(pdfUrl.p.get('local_edit'), null);
    assert.equal(pdfUrl.p.get('client'), null);

    const mind = parse(buildPreviewUrl(xmind, 'edit', 39177));
    assert.equal(mind.type, 'mind');
    assert.equal(mind.p.get('client'), 'sdk_local_wb');
    assert.equal(mind.p.get('mode'), 'edit');
  });

  await test('readonly 用只读参数覆盖 edit 参数', () => {
    const d = parse(buildPreviewUrl(doc, 'readonly', 39177)).p;
    assert.equal(d.get('mode'), 'readonly');
    assert.equal(d.get('toolbar'), 'hide');
    assert.equal(d.get('statusbar'), 'hide');
    assert.equal(d.get('outline'), 'show'); // 未覆盖的保留

    const s = parse(buildPreviewUrl(xlsx, 'readonly', 39177)).p;
    assert.equal(s.get('mode'), 'readonly');
    assert.equal(s.get('client'), 'sdk_local_pure');

    const slide = parse(buildPreviewUrl(pptx, 'readonly', 39177)).p;
    assert.equal(slide.get('client'), 'sdk_local_wb_preview');
    assert.equal(slide.get('hideTitlebar'), '1');

    const mind = parse(buildPreviewUrl(xmind, 'readonly', 39177)).p;
    assert.equal(mind.get('client'), 'sdk_local_wb_preview');
    assert.equal(mind.get('mode'), 'readonly');
  });

  await test('不支持的扩展名抛明确错误', () => {
    assert.throws(() => buildPreviewUrl(path.join(root, 'notes.txt')), /不支持的 Office 文件类型/);
  });

  await test('二进制缺失：返回不可用 + needsDownload，不抛异常也不下载', async () => {
    const port = freePort();
    process.env.PAW_OFFICE_PORT = String(port);
    process.env.PAW_OFFICE_BIN = path.join(root, 'does-not-exist', 'editor_sdk');
    process.env.PAW_DATA_DIR = path.join(root, 'data-missing');
    const status = await getOfficeStatus();
    assert.equal(status.available, false);
    assert.equal(status.port, port);
    assert.equal(status.needsDownload, true);
    assert.match(status.error || '', /未安装/);
    assert.equal(resolveOfficeBinary(), process.env.PAW_OFFICE_BIN);
  });

  await test('mock 二进制：spawn 参数正确（端口/no_auth/tmp_dir）', async () => {
    const port = freePort();
    const argsFile = path.join(root, 'spawn-args.txt');
    const fake = path.join(root, 'fake-editor_sdk');
    await writeFile(fake, '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_ARGS_FILE"\n', { mode: 0o755 });
    await chmod(fake, 0o755);
    process.env.PAW_OFFICE_PORT = String(port);
    process.env.PAW_OFFICE_BIN = fake;
    process.env.PAW_DATA_DIR = path.join(root, 'data-fake');
    process.env.FAKE_ARGS_FILE = argsFile;

    const status = await getOfficeStatus();
    assert.equal(status.available, false);
    assert.match(status.error || '', /退出|错误/);

    const args = (await readFile(argsFile, 'utf-8')).trim().split('\n');
    assert.ok(args.includes(`--port=${port}`), `端口参数缺失：${args}`);
    assert.ok(args.includes('--no_auth'), `no_auth 缺失：${args}`);
    assert.ok(args.some((a) => a.startsWith(`--tmp_dir=${path.join(root, 'data-fake')}`)), `tmp_dir 缺失：${args}`);
    assert.ok(args.some((a) => a.startsWith(`--log_dir=${path.join(root, 'data-fake')}`)), `log_dir 缺失：${args}`);
  });

  await test('端口已有引擎时复用，不重复 spawn', async () => {
    const port = freePort();
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/static/doc/pc.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html></html>');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    try {
      process.env.PAW_OFFICE_PORT = String(port);
      process.env.PAW_OFFICE_BIN = path.join(root, 'never-spawned');
      const status = await getOfficeStatus();
      assert.equal(status.available, true);
      assert.equal(status.port, port);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  await test('状态缓存不可信：端口失联后重新探测并就绪', async () => {
    const port = freePort();
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/static/doc/pc.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html></html>');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    try {
      process.env.PAW_OFFICE_PORT = String(port);
      process.env.PAW_OFFICE_BIN = path.join(root, 'never-spawned');
      assert.equal((await getOfficeStatus()).available, true);
      await new Promise<void>((r) => server.close(() => r()));
      const status = await getOfficeStatus();
      assert.equal(status.available, false, '失联后必须报告不可用，不能沿用旧缓存');
      assert.match(status.error || '', /未安装|不存在|超时|退出|错误/);
    } finally {
      if (server.listening) await new Promise<void>((r) => server.close(() => r()));
    }
  });

  await test('resolveOfficeBinary 固定指向 ~/.paw/office，不使用包内二进制', async () => {
    delete process.env.PAW_OFFICE_BIN;
    const dir = path.join(root, 'data-path');
    process.env.PAW_DATA_DIR = dir;
    const name = process.platform === 'win32' ? 'editor_sdk.exe' : 'editor_sdk';
    assert.equal(resolveOfficeBinary(), path.join(dir, 'office', name));
  });

  await test('未确认时 getOfficeStatus 不下载、不落盘', async () => {
    const port = freePort();
    const dlDir = path.join(root, 'data-nodl');
    delete process.env.PAW_OFFICE_BIN;
    process.env.PAW_OFFICE_PORT = String(port);
    process.env.PAW_DATA_DIR = dlDir;
    process.env.PAW_OFFICE_URL = 'http://127.0.0.1:1/editor_sdk'; // 若被误下载必然失败并留下痕迹

    const status = await getOfficeStatus();
    assert.equal(status.available, false);
    assert.equal(status.needsDownload, true);
    assert.equal(existsSync(path.join(dlDir, 'office', 'editor_sdk')), false);
  });

  await test('用户确认后：installOfficeEngine 下载到 PAW_DATA_DIR/office/editor_sdk，重复调用不重下', async () => {
    const port = freePort();
    const dlDir = path.join(root, 'data-install');
    let downloads = 0;
    const dlServer = createServer((_req, res) => {
      downloads++;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('#!/bin/sh\nexit 0\n');
    });
    await new Promise<void>((r) => dlServer.listen(0, '127.0.0.1', r));
    const addr = dlServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    try {
      delete process.env.PAW_OFFICE_BIN;
      process.env.PAW_OFFICE_PORT = String(port);
      process.env.PAW_DATA_DIR = dlDir;
      process.env.PAW_OFFICE_URL = `http://127.0.0.1:${addr.port}/editor_sdk`;

      const status = await installOfficeEngine();
      assert.equal(status.available, false); // mock 脚本立刻退出
      const expectedBin = path.join(dlDir, 'office', 'editor_sdk');
      assert.equal(status.binary, expectedBin);
      assert.match(await readFile(expectedBin, 'utf-8'), /#!\/bin\/sh/);

      await installOfficeEngine();
      assert.equal(downloads, 1, '已安装时不应重复下载');
    } finally {
      await new Promise<void>((r) => dlServer.close(() => r()));
    }
  });

  await test('下载进行中并发调用 getOfficeStatus：复用同一次下载，不误报 needsDownload', async () => {
    const port = freePort();
    const dlDir = path.join(root, 'data-concurrent-dl');
    let downloads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const dlServer = createServer(async (_req, res) => {
      downloads++;
      await gate;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('#!/bin/sh\nexit 0\n');
    });
    await new Promise<void>((r) => dlServer.listen(0, '127.0.0.1', r));
    const addr = dlServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    try {
      delete process.env.PAW_OFFICE_BIN;
      process.env.PAW_OFFICE_PORT = String(port);
      process.env.PAW_DATA_DIR = dlDir;
      process.env.PAW_OFFICE_URL = `http://127.0.0.1:${addr.port}/editor_sdk`;

      const pInstall = installOfficeEngine();
      const pStatus = getOfficeStatus();
      release();
      const [s1, s2] = await Promise.all([pInstall, pStatus]);
      assert.equal(downloads, 1, '并发只应下载一次');
      assert.notEqual(s2.needsDownload, true, '下载中并发查询不应误报 needsDownload');
      assert.deepEqual(s1, s2);
    } finally {
      await new Promise<void>((r) => dlServer.close(() => r()));
    }
  });

  await test('下载进度：流式累计字节数，完成后 downloading=false 且对齐 Content-Length', async () => {
    const chunk1 = Buffer.from('#!/bin/sh\n');
    const chunk2 = Buffer.from('echo ok\n');
    const body = Buffer.concat([chunk1, chunk2]);
    let sendRest!: () => void;
    const gate = new Promise<void>((r) => { sendRest = r; });
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
      });
      res.write(chunk1);
      void gate.then(() => res.end(chunk2));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    let pending: Promise<string> | null = null;
    try {
      const dest = path.join(root, 'progress', 'editor_sdk');
      pending = downloadOfficeBinary(dest, `http://127.0.0.1:${addr.port}/editor_sdk`);
      let mid = getOfficeDownloadProgress();
      for (let i = 0; i < 80 && (!mid.downloading || mid.downloaded < chunk1.length); i++) {
        await new Promise((r) => setTimeout(r, 25));
        mid = getOfficeDownloadProgress();
      }
      assert.equal(mid.downloading, true);
      assert.equal(mid.total, body.length);
      assert.ok(mid.downloaded >= chunk1.length, `中间进度未累计：${mid.downloaded}`);
      sendRest();
      await pending;
      const done = getOfficeDownloadProgress();
      assert.equal(done.downloading, false);
      assert.equal(done.downloaded, body.length);
      assert.equal(done.total, body.length);
    } finally {
      sendRest();
      await pending?.catch(() => undefined);
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  await test('运行时按需下载：从指定 URL 流式落盘并赋予可执行权限', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('#!/bin/sh\necho ok\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('server address unavailable');
      const dest = path.join(root, 'downloaded', 'editor_sdk');
      await downloadOfficeBinary(dest, `http://127.0.0.1:${addr.port}/editor_sdk`);
      const content = await readFile(dest, 'utf-8');
      assert.equal(content, '#!/bin/sh\necho ok\n');
      const st = await stat(dest);
      assert.equal((st.mode & 0o111) !== 0, true, '下载后的二进制必须带可执行位');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  console.log(`\n${pass}/${total} 通过`);
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.FAKE_ARGS_FILE;
  await rm(root, { recursive: true, force: true });
}
