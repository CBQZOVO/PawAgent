// call_api 集成测试：自定义请求头（SSE Accept）+ 大请求体文件（body_file）
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 必须在 import connections 之前设置 PAW_DATA_DIR，避免碰真实 ~/.paw
const dataDir = mkdtempSync(path.join(tmpdir(), 'paw-call-api-data-'));
const workDir = mkdtempSync(path.join(tmpdir(), 'paw-call-api-work-'));
process.env.PAW_DATA_DIR = dataDir;

const { saveConnections, setSecret } = await import('../src/connections.js');
const { callApiSchema, executeCallApi } = await import('../src/tools/connections.js');

let pass = 0;
const atest = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

let lastReq: {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
} | null = null;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(Buffer.from(c)));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    lastReq = { method: req.method, url: req.url, headers: req.headers, body };

    if (req.url === '/add/kbDocSse') {
      if (!String(req.headers.accept || '').includes('text/event-stream')) {
        res.writeHead(406, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Acceptable' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: progress\ndata: {"step":"parsing"}\n\n');
      res.end('event: done\ndata: {"ok":true}\n\n');
      return;
    }

    if (req.url === '/dfs/doc') {
      const parsed = JSON.parse(body.toString('utf-8')) as { fileName: string; fileContent: number[] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        fileName: parsed.fileName,
        byteCount: parsed.fileContent.length,
        contentType: req.headers['content-type'],
      }));
      return;
    }

    if (req.url === '/upload') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        size: body.length,
        head: [...body.subarray(0, 4)],
        contentType: req.headers['content-type'],
      }));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const addr = server.address();
assert.ok(addr && typeof addr === 'object');
const baseUrl = `http://127.0.0.1:${addr.port}`;

saveConnections([
  {
    code: 'mock_sys',
    name: 'Mock System',
    baseUrl,
    auth: { type: 'bearer' },
  },
]);
await setSecret('mock_sys', 'real-secret-token');

try {
  await atest('schema 暴露 headers 和 body_file 参数', async () => {
    const schema = callApiSchema();
    assert.ok(schema);
    const props = (schema!.parameters as { properties: Record<string, unknown> }).properties;
    assert.ok(props.headers, '应暴露 headers');
    assert.ok(props.body_file, '应暴露 body_file');
  });

  await atest('SSE 接口：不带 Accept: text/event-stream 返回 406，带上 headers 后成功收到事件流', async () => {
    await assert.rejects(
      () => executeCallApi({ connection: 'mock_sys', method: 'POST', path: '/add/kbDocSse', body: { id: 1 } }),
      /406/,
    );
    const out = await executeCallApi({
      connection: 'mock_sys',
      method: 'POST',
      path: '/add/kbDocSse',
      headers: {
        Accept: 'text/event-stream',
        Authorization: 'Bearer attacker-token',
      },
      body: { id: 1 },
    });
    assert.match(out, /200/);
    assert.match(out, /event: done/);
    assert.equal(lastReq?.headers.authorization, 'Bearer real-secret-token', '敏感头 Authorization 不应被覆盖');
  });

  await atest('大请求体：通过 body_file 发送含大 fileContent 字节数组的 JSON', async () => {
    const bytes = Array.from({ length: 65536 }, (_, i) => i % 256);
    const payloadPath = path.join(workDir, 'dfs-payload.json');
    writeFileSync(payloadPath, JSON.stringify({ fileName: 'report.pdf', fileContent: bytes }), 'utf-8');

    const out = await executeCallApi(
      { connection: 'mock_sys', method: 'POST', path: '/dfs/doc', body_file: 'dfs-payload.json' },
      { workspace: workDir },
    );
    assert.match(out, /200/);
    assert.match(out, /"byteCount":65536/);
    assert.match(out, /"contentType":"application\/json"/);
  });

  await atest('二进制 body_file：按原字节发送并默认 application/octet-stream', async () => {
    const binPath = path.join(workDir, 'sample.bin');
    writeFileSync(binPath, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]));

    const out = await executeCallApi(
      { connection: 'mock_sys', method: 'POST', path: '/upload', body_file: binPath },
      { workspace: workDir },
    );
    assert.match(out, /"size":6/);
    assert.match(out, /"head":\[37,80,68,70\]/);
    assert.match(out, /"contentType":"application\/octet-stream"/);
  });

  await atest('校验：body 与 body_file 互斥、不存在文件报错、拒绝发送 secrets.json', async () => {
    const payloadPath = path.join(workDir, 'dfs-payload.json');
    await assert.rejects(
      () => executeCallApi({ connection: 'mock_sys', method: 'POST', path: '/dfs/doc', body: {}, body_file: payloadPath }),
      /不能同时传入/,
    );
    await assert.rejects(
      () => executeCallApi({ connection: 'mock_sys', method: 'POST', path: '/dfs/doc', body_file: path.join(workDir, 'missing.json') }),
      /不存在/,
    );
    await assert.rejects(
      () => executeCallApi({ connection: 'mock_sys', method: 'POST', path: '/dfs/doc', body_file: path.join(dataDir, 'secrets.json') }),
      /凭据文件/,
    );
  });
} finally {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n${pass} 项通过`);
