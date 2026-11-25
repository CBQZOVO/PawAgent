// 占位符 token 纯函数测试。
// 运行：pnpm --filter @paw/server exec tsx ../web/tests/composer-tokens.test.ts
import assert from 'node:assert/strict';
import { buildHighlightHtml, findTokens, removeTokenAt, removedTokenNames, tokenInside } from '../src/components/composer/tokens.js';

let pass = 0;
const test = (label: string, fn: () => void) => {
  try { fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

test('findTokens 找出所有 @"名" 及边界', () => {
  const t = findTokens('aa@"a.md"bb@"b.md"cc');
  assert.equal(t.length, 2);
  assert.equal(t[0].name, 'a.md');
  assert.equal(t[0].start, 2);
  assert.equal(t[0].rawEnd, 9); // @"a.md" 长度 7，2+7=9
  assert.equal(t[1].name, 'b.md');
});

test('tokenInside：光标落在 token 内部才算', () => {
  const t = findTokens('ab@"x.md"cd'); // @"x.md" 占 [2,9)
  assert.equal(tokenInside(t, 2), null);    // 左边界 @" 不算内部
  assert.equal(tokenInside(t, 3)?.name, 'x.md'); // 内部
  assert.equal(tokenInside(t, 8)?.name, 'x.md');
  assert.equal(tokenInside(t, 9), null);    // 右边界后
});

test('removeTokenAt 整删占位符', () => {
  const t = findTokens('ab@"x.md"cd')[0];
  assert.equal(removeTokenAt('ab@"x.md"cd', t), 'abcd');
});

test('removedTokenNames 找出被删掉的占位符名', () => {
  assert.deepEqual(removedTokenNames('a@"x.md"b@"y.md"', 'ab@"y.md"'), ['x.md']);
  assert.deepEqual(removedTokenNames('@"x.md"@"y.md"', ''), ['x.md', 'y.md']);
  // 同名多个：删一个只报一个
  assert.deepEqual(removedTokenNames('@"x.md"@"x.md"', '@"x.md"'), ['x.md']);
});

test('buildHighlightHtml 把 @"名" 包成 chip-token，其余转义', () => {
  const html = buildHighlightHtml('hi@"a.md"<b>&');
  assert.ok(html.includes('<span class="chip-token">@"a.md"</span>'));
  assert.ok(html.includes('&lt;b&gt;')); // < 被转义
  assert.ok(html.includes('&amp;'));     // & 被转义
});

test('buildHighlightHtml 空文本也补换行占位', () => {
  assert.equal(buildHighlightHtml(''), '\n');
});

console.log(`\n${pass} passed`);
