// Markdown 预览管道测试：原始 HTML 要渲染出来，危险内容要清掉。
// 走真实 unified 管道（remark-parse → gfm → remark-rehype → raw → sanitize → html），
// 与组件里 react-markdown 的配置一致，不依赖浏览器。
// 运行：pnpm --filter @paw/web test
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import { mdSchema, resolveWorkspaceSrc } from '../src/lib/markdown-schema.js';
import { normalizeLatexDelimiters, remarkMathGuard } from '../src/lib/markdown-math.js';

let pass = 0;
let total = 0;
const test = (label: string, fn: () => void) => {
  total++;
  try { fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

const render = (md: string) => String(unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkMathGuard)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, mdSchema)
  .use(rehypeKatex)
  .use(rehypeStringify)
  .processSync(normalizeLatexDelimiters(md)));

test('<div align="center"> 渲染成真实元素，不是纯文本', () => {
  const html = render('<div align="center">\n<h1>B2BCommerce</h1>\n一套商城。\n</div>');
  assert.match(html, /<div align="center">/);
  assert.match(html, /<h1>B2BCommerce<\/h1>/);
  assert.ok(!html.includes('&#x3C;div'), 'div 不该被转义成文本');
});

test('横幅 <a><img></a> 包在 div 里正常出图', () => {
  const html = render('<div align="center">\n  <a href="https://ant.design">\n    <img src="https://x.com/banner.png">\n  </a>\n</div>');
  assert.match(html, /<img src="https:\/\/x\.com\/banner\.png"/);
  assert.match(html, /<a href="https:\/\/ant\.design">/);
});

test('<img width="24px"> 尺寸属性保留（图标表格常用）', () => {
  const html = render('<img src="https://x.com/edge.png" alt="Edge" width="24px" height="24px" />');
  assert.match(html, /width="24px"/);
  assert.match(html, /height="24px"/);
});

test('<br> 换行生效', () => {
  const html = render('| a<br>b |\n| - |\n| c |');
  assert.match(html, /<br>/);
});

test('<details><summary> 折叠块可用', () => {
  const html = render('<details>\n<summary>点我展开</summary>\n\n内容\n\n</details>');
  assert.match(html, /<details>/);
  assert.match(html, /<summary>点我展开<\/summary>/);
});

test('<p align="center"> 居中也保留', () => {
  assert.match(render('<p align="center">居中文字</p>'), /<p align="center">/);
});

test('GFM 表格 / 任务列表 / 删除线仍正常', () => {
  const html = render('| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] 完成\n- [ ] 待办\n\n~~删掉~~');
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /<del>删掉<\/del>/);
});

test('script 标签被剥掉', () => {
  const html = render('<script>alert(1)</script>\n\n正常文字');
  assert.ok(!html.includes('<script'), 'script 必须清除');
  assert.ok(!html.includes('alert(1)'), 'script 内容也要清掉');
  assert.match(html, /正常文字/);
});

test('on* 事件属性被剥掉', () => {
  const html = render('<img src="https://x.com/a.png" onerror="alert(1)">');
  assert.ok(!html.includes('onerror'), 'onerror 必须清除');
  assert.match(html, /<img src="https:\/\/x\.com\/a\.png"/);
});

test('javascript: 链接被清掉', () => {
  const html = render('<a href="javascript:alert(1)">点我</a>');
  assert.ok(!html.toLowerCase().includes('javascript:'), 'javascript: 协议必须清除');
});

test('iframe / style 等危险标签被剥掉', () => {
  const html = render('<iframe src="https://evil.com"></iframe><style>body{display:none}</style>正文');
  assert.ok(!html.includes('<iframe'));
  assert.ok(!html.includes('<style'));
  assert.match(html, /正文/);
});

test('代码块语言 class 保留（供着色用）', () => {
  assert.match(render('```ts\nconst a = 1;\n```'), /class="language-ts"/);
});

test('相对图片路径 → 工作区只读接口', () => {
  const url = resolveWorkspaceSrc('./img/logo.png', '/ws/proj', '/ws/proj/docs/readme.md');
  assert.equal(url, `/api/fs/raw?root=${encodeURIComponent('/ws/proj')}&path=${encodeURIComponent('/ws/proj/docs/./img/logo.png')}`);
});

test('绝对 URL 与 data: 原样透传', () => {
  assert.equal(resolveWorkspaceSrc('https://x.com/a.png', '/ws', '/ws/a.md'), 'https://x.com/a.png');
  assert.equal(resolveWorkspaceSrc('data:image/png;base64,AAA', '/ws', '/ws/a.md'), 'data:image/png;base64,AAA');
});

test('Markdown 预览支持行内/块级 KaTeX 且不影响安全过滤', () => {
  const html = render('<script>alert(1)</script>\n\n公式 $E = mc^2$ 与：\n\n$$\n\\sum_{i=1}^n x_i\n$$\n\n金额 $100-$200 保留');
  assert.ok(!html.includes('<script'), 'script 仍被剥离');
  assert.match(html, /class="katex-display"/);
  assert.equal((html.match(/class="katex"/g) || []).length, 2);
  assert.ok(html.includes('$100-$200'), '金额区间不被误伤');
});

console.log(`\n${pass}/${total} 通过`);