// highlight.ts 现在只剩扩展名/图标配色工具：语法着色早已交给 Monaco，
// 旧的 highlightLine tokenizer 连同实现一起删除，针对它的测试也一并移除。
// 这里只测模块里还在被生产代码使用的那部分（extOf / fileHue）。
import assert from 'node:assert/strict';
import { extOf, fileHue } from '../src/lib/highlight.js';

let pass = 0;
let total = 0;
const test = (label: string, fn: () => void) => {
  total++;
  try { fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

test('extOf 识别常见文件与无扩展名配置', () => {
  assert.equal(extOf('/a/b/c.tsx'), 'tsx');
  assert.equal(extOf('/a/Dockerfile'), 'sh');
  assert.equal(extOf('/a/Makefile'), 'sh');
  assert.equal(extOf('/a/.gitignore'), 'gitignore');
  assert.equal(extOf('/a/.eslintrc.json'), 'json');
});

test('fileHue 给不同扩展名分配配色变量', () => {
  assert.equal(fileHue('ts'), 'var(--gh-link)');
  assert.equal(fileHue('py'), 'var(--gh-link)');
  assert.equal(fileHue('css'), 'var(--gh-term-cyan)');
  assert.equal(fileHue('png'), 'var(--gh-term-magenta)');
  assert.equal(fileHue('unknown'), 'var(--gh-fg-muted)');
});

console.log(`\n${pass}/${total} 通过`);
