// 部件 Bridge 路径边界：只允许本插件/本连接路由前缀下的相对路径。
import assert from 'node:assert/strict';
import { safeWidgetApiPath } from '../src/lib/widget-path.js';

let pass = 0;
const test = (label: string, fn: () => void) => {
  try { fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

test('普通相对路径与中文路径正常', () => {
  assert.equal(safeWidgetApiPath('/api/v1/items'), '/api/v1/items');
  assert.equal(safeWidgetApiPath('api/v1/items?status=open'), '/api/v1/items');
  assert.equal(safeWidgetApiPath('/订单/列表'), '/订单/列表');
});

test('点段、编码穿越、scheme、协议相对 URL 一律拒绝', () => {
  for (const bad of [
    '../../etc/passwd', '/api/../admin', '/%2e%2e/admin', '/api/%2E%2E/x',
    'https://evil.com/x', '//evil.com/x', 'javascript:alert(1)', 'data:text/html,x',
    '/api\\..\\x', '', '   ', null, undefined, 42,
  ]) {
    assert.equal(safeWidgetApiPath(bad), null, `应拒绝：${String(bad)}`);
  }
});

console.log(`\n${pass} 通过`);
