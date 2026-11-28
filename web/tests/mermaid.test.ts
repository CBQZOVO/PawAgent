// Mermaid 代码块识别测试：只走纯 unified 管道 + 纯函数，不依赖浏览器和 mermaid 运行时。
// 运行：pnpm --filter @paw/web test
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { containsMermaidBlock, detectMermaidLabel, isMermaidLanguage, isSafeMermaidSvg, textFromChildren } from '../src/lib/markdown-mermaid.js';
import { extractMessageDeliverables, formatFileSize } from '../src/lib/deliverables.js';

let pass = 0;
let total = 0;
const test = (label: string, fn: () => void) => {
  total++;
  try { fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

const render = (md: string) => String(unified()
  .use(remarkParse)
  .use(remarkRehype)
  .use(rehypeStringify)
  .processSync(md));

test('```mermaid 代码块保留 language-mermaid 类名并被识别（不区分大小写）', () => {
  const html = render('```mermaid\ngraph TD\nA-->B\n```');
  assert.match(html, /<code class="language-mermaid">/);
  assert.ok(isMermaidLanguage('language-mermaid'));
  assert.ok(isMermaidLanguage('language-Mermaid'));
  assert.ok(isMermaidLanguage(['foo', 'language-MERMAID']));
});

test('普通代码块与其它语言不误判', () => {
  const html = render('```js\nconsole.log(1)\n```');
  assert.match(html, /<code class="language-js">/);
  assert.ok(!isMermaidLanguage('language-js'));
  assert.ok(!isMermaidLanguage(undefined));
  assert.ok(!isMermaidLanguage('mermaid')); // 必须是 language- 前缀，避免误伤普通文本
});

test('containsMermaidBlock 只认完整代码块，普通工具输出不误判', () => {
  assert.ok(containsMermaidBlock('前文\n```mermaid\nflowchart TD\nA-->B\n```\n后文'));
  assert.ok(!containsMermaidBlock('```js\nconsole.log(1)\n```'));
  assert.ok(!containsMermaidBlock('```mermaid\n未闭合的代码'));
  assert.ok(!containsMermaidBlock(undefined));
});

test('textFromChildren 从 pre 的子节点取出完整代码', () => {
  const child = { props: { className: 'language-mermaid', children: 'graph TD\nA-->B' } };
  assert.equal(textFromChildren(child), 'graph TD\nA-->B');
  assert.equal(textFromChildren(['前缀', child]), '前缀graph TD\nA-->B');
  assert.equal(textFromChildren(null), '');
});

test('isSafeMermaidSvg 拦截脚本与事件属性，但不误杀普通单词（如 config=、content=、response=）', () => {
  assert.ok(isSafeMermaidSvg('<svg viewBox="0 0 100 50"><text>config=prod content=ok response=200</text></svg>'));
  assert.ok(!isSafeMermaidSvg('<div>not svg</div>'));
  assert.ok(!isSafeMermaidSvg('<svg><script>alert(1)</script></svg>'));
  assert.ok(!isSafeMermaidSvg('<svg onload="alert(1)"></svg>'));
  assert.ok(!isSafeMermaidSvg('<svg><g onclick=alert(1)></g></svg>'));
  assert.ok(!isSafeMermaidSvg('<svg><a href="javascript:alert(1)">x</a></svg>'));
});

test('detectMermaidLabel 正确识别常见图类型并忽略注释行', () => {
  assert.equal(detectMermaidLabel('%% comment\nflowchart TD\nA-->B'), '流程图');
  assert.equal(detectMermaidLabel('sequenceDiagram\nA->>B: hi'), '时序图');
  assert.equal(detectMermaidLabel('erDiagram\nUSER ||--o{ ORDER : places'), 'ER 图');
  assert.equal(detectMermaidLabel('mindmap\n  root'), '思维导图');
  assert.equal(detectMermaidLabel('unknownDiagram\n  a'), 'Mermaid');
});

test('extractMessageDeliverables 提取工具写入与正文绝对路径产物，过滤 /tmp 临时脚本并去重', () => {
  const list = extractMessageDeliverables({
    id: 'm1',
    role: 'assistant',
    ts: 1,
    content: [
      { type: 'tool-call', id: 't1', name: 'write_file', args: { path: '/tmp/patch.py' }, ok: true },
      { type: 'tool-call', id: 't2', name: 'write_file', args: { path: '/Users/bollo/work/导出说明.txt' }, ok: true },
      { type: 'text', text: '改完了，新文件在这：\n`/Users/bollo/.paw/attachments/04ejd59h/计科2314-徐子瑞-修改稿3.docx` (2.9MB)' },
    ],
  });
  assert.deepEqual(list.map((x) => x.name), ['计科2314-徐子瑞-修改稿3.docx', '导出说明.txt']);
  assert.equal(list[0].source, 'text');
  assert.equal(list[1].source, 'tool');
  assert.equal(formatFileSize(3072), '3 KB');
  assert.equal(formatFileSize(2_900_000), '2.8 MB');
});

console.log(`${pass}/${total} 通过`);
