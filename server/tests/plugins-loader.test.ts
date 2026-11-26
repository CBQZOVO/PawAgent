import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PluginRegistry } from '@paw/kernel';
import {
  loadExternalPluginsFromDir,
  updatePluginConfigEntry,
  type ServerToolExecCtx,
} from '../src/plugins/index.js';

const root = await mkdtemp(path.join(tmpdir(), 'paw-ext-plugins-'));
try {
  // 1. 工厂函数插件（带 package.json main 与 host.config 注入）
  const p1 = path.join(root, 'demo-alpha');
  await mkdir(p1);
  await writeFile(path.join(p1, 'package.json'), JSON.stringify({ name: 'demo-alpha', version: '1.2.3', main: 'entry.mjs' }));
  await writeFile(path.join(p1, 'entry.mjs'), `
    export default (host) => ({
      name: 'demo-alpha',
      pages: [
        { id: 'home', label: '测试页', icon: 'briefcase', order: 0, entry: 'ui/index.html' },
        { id: 'escape', label: '越界页', entry: '../../etc/passwd' },
      ],
      widgets: [
        { id: 'card', title: '数据卡', entry: 'ui/card.html?script=./dist/w.js', defaultHeight: 300, sameOrigin: true },
        { id: 'escape', entry: '../../etc/passwd' },
        { id: 'remote', entry: 'https://example.com/w.html', sameOrigin: true },
      ],
      routes(router) {
        router.get('/hello', async (c) => {
          const pingRes = await host.tools.execute('alpha_ping', {});
          return c.json({
            ok: true,
            token: host.config.token || '',
            ping: pingRes.content,
            hasMcp: typeof host.mcp.callTool === 'function',
            hasConnCall: typeof host.connections.call === 'function',
            hasMemory: typeof host.memory.list === 'function',
            hasWorklog: typeof host.worklog.list === 'function',
            hasSessions: typeof host.sessions.list === 'function',
            hasTasks: typeof host.tasks.list === 'function',
            hasSkills: typeof host.skills.list === 'function',
            hasNotify: typeof host.notify === 'function',
          });
        });
      },
      tools: [{
        schema: { name: 'alpha_ping', description: 'ping', parameters: { type: 'object', properties: {} } },
        meta: { readOnly: true },
        execute: () => 'pong:' + String(host.config.token || ''),
      }],
    });
  `);

  // 2. 被 plugins.json 禁用的插件
  const p2 = path.join(root, 'demo-disabled');
  await mkdir(p2);
  await writeFile(path.join(p2, 'index.mjs'), `export default { name: 'demo-disabled', tools: [] };`);

  // 3. 损坏插件（抛异常，不能拖垮其他插件）
  const p3 = path.join(root, 'demo-broken');
  await mkdir(p3);
  await writeFile(path.join(p3, 'index.mjs'), `throw new Error('boom during load');`);

  await writeFile(path.join(root, 'plugins.json'), JSON.stringify({
    'demo-alpha': { enabled: true, config: { token: 'secret-42' } },
    'demo-disabled': { enabled: false },
  }));

  const reg = new PluginRegistry<ServerToolExecCtx>();
  const report = await loadExternalPluginsFromDir(reg, root);

  assert.equal(report.loaded.length, 1);
  assert.equal(report.loaded[0].name, 'demo-alpha');
  assert.equal(report.loaded[0].version, '1.2.3');
  assert.deepEqual(report.loaded[0].tools, ['alpha_ping']);
  assert.equal(report.loaded[0].pages.length, 1, '越界页面入口应被过滤');
  assert.equal(report.loaded[0].pages[0].url, '/api/plugins/demo-alpha/ui/ui/index.html');
  assert.equal(report.loaded[0].pages[0].order, 0);
  const widgets = report.loaded[0].widgets;
  assert.equal(widgets.length, 2, '越界部件入口应被过滤');
  assert.equal(widgets[0].key, 'demo-alpha:card');
  assert.equal(widgets[0].url, '/api/plugins/demo-alpha/ui/ui/card.html?script=./dist/w.js', 'entry 的 query 要原样保留');
  assert.equal(widgets[0].defaultHeight, 300);
  assert.equal(widgets[0].sameOrigin, true);
  assert.equal(widgets[1].url, 'https://example.com/w.html');
  assert.equal(widgets[1].sameOrigin, false, '远程部件强制受限沙箱');
  const subRouter = report.routers?.get('demo-alpha');
  assert.ok(subRouter, '应注册插件专属路由');
  const routeRes = await subRouter!.fetch(new Request('http://localhost/hello'));
  assert.deepEqual(await routeRes.json(), {
    ok: true,
    token: 'secret-42',
    ping: 'pong:secret-42',
    hasMcp: true,
    hasConnCall: true,
    hasMemory: true,
    hasWorklog: true,
    hasSessions: true,
    hasTasks: true,
    hasSkills: true,
    hasNotify: true,
  });
  assert.deepEqual(report.skipped, ['demo-disabled']);
  assert.equal(report.disabled.length, 1);
  assert.equal(report.disabled[0].dir, 'demo-disabled');
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].error, /boom during load/);

  assert.equal(reg.isReadOnly('alpha_ping'), true);
  const res = await reg.execute('alpha_ping', {}, 'call-1', { depth: 0, emit: () => {} });
  assert.equal(res?.content, 'pong:secret-42');
  assert.equal(res?.isError, false);

  // 4. 更新配置并重新加载（禁用 alpha，启用 disabled，并修改 config）
  await updatePluginConfigEntry('demo-alpha', { enabled: false }, root);
  await updatePluginConfigEntry('demo-disabled', { enabled: true, config: { mode: 'on' } }, root);
  reg.unregister('demo-alpha');
  const report2 = await loadExternalPluginsFromDir(reg, root, undefined, { bustCache: true });
  assert.deepEqual(report2.loaded.map((p) => p.name), ['demo-disabled']);
  assert.deepEqual(report2.disabled.map((p) => p.dir), ['demo-alpha']);
  assert.equal(reg.hasTool('alpha_ping'), false);

  console.log('✓ 外部插件动态加载、启停配置、热重载与容错隔离测试通过');
} finally {
  await rm(root, { recursive: true, force: true });
}
