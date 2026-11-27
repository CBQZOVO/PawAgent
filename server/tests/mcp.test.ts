// MCP 配置读写、校验、覆盖/屏蔽 WorkBuddy 导入项、重命名与删除测试。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let pass = 0;
let total = 0;
const test = async (label: string, fn: () => Promise<void> | void) => {
  total++;
  try { await fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

const root = await mkdtemp(path.join(tmpdir(), 'paw-mcp-test-'));
const pawFile = path.join(root, '.paw', 'mcp.json');
const legacyFile = path.join(root, 'paw-mcp.json');
const wbFile = path.join(root, 'workbuddy-mcp.json');
process.env.PAW_MCP_CONFIG = pawFile;
process.env.PAW_LEGACY_MCP_CONFIG = legacyFile;
process.env.PAW_WORKBUDDY_MCP_CONFIG = wbFile;

const { validateMcpInput, upsertMcpServer, importMcpServers, deleteMcpServer, mcpServerViews } = await import('../src/mcp.js');

const readPaw = async () => JSON.parse(await readFile(pawFile, 'utf-8')) as { mcpServers: Record<string, Record<string, unknown>> };

try {
  await writeFile(wbFile, JSON.stringify({
    mcpServers: {
      legacy: { command: 'python3', args: ['srv.py'] },
    },
  }), 'utf-8');
  await writeFile(legacyFile, JSON.stringify({
    mcpServers: {
      'migrated-crm': {
        type: 'http',
        url: 'http://127.0.0.1:3000/mcp',
        headers: { 'X-Ecc-Current-Tenant': '10000' },
      },
    },
  }), 'utf-8');

  await test('validateMcpInput 拒绝非法名称与不合法配置', () => {
    assert.throws(() => validateMcpInput('', { type: 'http', url: 'http://127.0.0.1:3000/mcp' }), /不能为空/);
    assert.throws(() => validateMcpInput('bad__name', { type: 'http', url: 'http://127.0.0.1:3000/mcp' }), /双下划线/);
    assert.throws(() => validateMcpInput('crm', { type: 'http', url: 'ftp://example.com' }), /http/);
    assert.throws(() => validateMcpInput('sse-bad', { type: 'sse', url: '' }), /SSE/);
    assert.throws(() => validateMcpInput('fs', { type: 'stdio', command: '' }), /启动命令/);
  });

  await test('upsertMcpServer 新增 HTTP/SSE/STDIO 配置（含 headers 与 description）并持久化到 ~/.paw/mcp.json', async () => {
    const httpView = await upsertMcpServer('crm-harness', {
      type: 'http',
      url: 'http://127.0.0.1:3000/mcp',
      headers: {
        'Accept-Language': 'zh-CHS',
        Authorization: 'Bearer tok',
        'X-Ecc-Current-Tenant': '10000',
      },
      description: 'CRM 远程工具',
    }, undefined, { connect: false });
    assert.equal(httpView.transport, 'HTTP');
    assert.equal(httpView.source, '~/.paw/mcp.json');
    assert.equal(httpView.config.headers?.['X-Ecc-Current-Tenant'], '10000');
    assert.equal(httpView.config.description, 'CRM 远程工具');

    const sseView = await upsertMcpServer('events', {
      type: 'sse',
      url: 'http://127.0.0.1:3002/sse',
      headers: { Authorization: 'Bearer sse-tok' },
    }, undefined, { connect: false });
    assert.equal(sseView.transport, 'SSE');
    assert.equal(sseView.config.headers?.Authorization, 'Bearer sse-tok');

    const stdioView = await upsertMcpServer('fs', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { DEBUG: '1' },
    }, undefined, { connect: false });
    assert.equal(stdioView.transport, 'STDIO');
    assert.deepEqual(stdioView.config.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);

    const saved = await readPaw();
    assert.equal(saved.mcpServers['crm-harness'].url, 'http://127.0.0.1:3000/mcp');
    assert.equal(saved.mcpServers.events.type, 'sse');
    assert.equal(saved.mcpServers.fs.command, 'npx');
  });

  await test('upsertMcpServer 重命名会清理旧名称', async () => {
    await upsertMcpServer('crm2', { type: 'http', url: 'http://127.0.0.1:3001/mcp' }, 'crm-harness', { connect: false });
    const saved = await readPaw();
    assert.equal(saved.mcpServers['crm-harness'], undefined);
    assert.equal(saved.mcpServers.crm2.url, 'http://127.0.0.1:3001/mcp');
    assert.ok(!mcpServerViews().some((v) => v.name === 'crm-harness'));
    assert.ok(mcpServerViews().some((v) => v.name === 'crm2'));
  });

  await test('deleteMcpServer 删除 Paw 项直接移除，删除 WorkBuddy 项写 disabled 屏蔽', async () => {
    await deleteMcpServer('crm2');
    await deleteMcpServer('legacy');
    const saved = await readPaw();
    assert.equal(saved.mcpServers.crm2, undefined);
    assert.deepEqual(saved.mcpServers.legacy, { disabled: true });
    // WorkBuddy 原文件保持不变
    const wbAfter = JSON.parse(await readFile(wbFile, 'utf-8')) as { mcpServers: Record<string, unknown> };
    assert.ok(wbAfter.mcpServers.legacy);
  });
  await test('importMcpServers 批量导入多条 mcpServers（含 disabled: true/false）', async () => {
    const views = await importMcpServers({
      'batch-http': {
        type: 'http',
        url: 'http://127.0.0.1:3000/mcp',
        headers: { 'Accept-Language': 'zh-CHS', 'X-Ecc-Current-Tenant': '10000' },
      },
      'batch-dms': {
        command: '/opt/anaconda3/bin/python',
        args: ['/tmp/dms.py'],
        env: {},
      },
      'batch-oms': {
        command: '/opt/anaconda3/bin/python',
        args: ['/tmp/oms.py'],
        env: {},
        disabled: true,
      },
      'batch-tfs': {
        command: '/opt/anaconda3/bin/python',
        args: ['/tmp/tfs.py'],
        env: {},
        disabled: false,
      },
    }, { connect: false });
    assert.equal(views.length, 4);
    assert.equal(views.find((v) => v.name === 'batch-oms')?.status, 'disabled');
    assert.equal(views.find((v) => v.name === 'batch-tfs')?.config.disabled, undefined);
    const saved = await readPaw();
    assert.equal(saved.mcpServers['batch-http'].url, 'http://127.0.0.1:3000/mcp');
    assert.equal(saved.mcpServers['batch-oms'].disabled, true);
    assert.equal(saved.mcpServers['batch-tfs'].disabled, undefined);
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\nmcp.test: ${pass}/${total} passed`);
