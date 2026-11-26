// 聊天消息 Markdown 的 LaTeX 公式渲染测试。
// 走真实 unified 管道（remark-parse → gfm → math → remark-rehype → katex → html），
// 与组件 components/Markdown.tsx 里 react-markdown 的插件配置一致，不依赖浏览器。
// 重点两类：公式要渲染出来；普通文本里的 $（金额、shell 变量）不能被误伤。
// 运行：pnpm --filter @paw/web test
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import { looksLikeMath, normalizeLatexDelimiters, remarkMathGuard } from '../src/lib/markdown-math.js';

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
  .use(remarkRehype)
  .use(rehypeKatex)
  .use(rehypeStringify)
  .processSync(normalizeLatexDelimiters(md)));

test('行内公式 $...$ 渲染成 KaTeX', () => {
  const html = render('回归的 $R^2$ 和 $\\beta_1$ 系数');
  assert.equal((html.match(/class="katex"/g) || []).length, 2, '应渲染出 2 个行内公式');
  assert.ok(html.includes('回归的'), '正文文字保留');
});

test('独立公式块 $$...$$ 渲染成 katex-display', () => {
  const html = render('公式：\n\n$$\nE = mc^2\n$$\n\n完。');
  assert.match(html, /class="katex-display"/);
});

test('金额里的 $ 不被误伤（原文一字不差）', () => {
  const html = render('预算 $100 到 $200 之间，单价 $5');
  assert.ok(!html.includes('katex'), '金额不是公式');
  assert.ok(html.includes('预算 $100 到 $200 之间，单价 $5'), '原文完整保留');
});

test('shell 变量 / 占位符里的 $ 不被误伤（原文一字不差）', () => {
  const html = render('参数是 $1 和 ${HOME}');
  assert.ok(!html.includes('katex'), 'shell 变量不是公式');
  assert.ok(html.includes('参数是 $1 和 ${HOME}'), '原文完整保留');
});

test('简单变量 $x$、$n$ 仍然渲染成公式', () => {
  const html = render('设 $x$ 为样本数，$n$ 为维度');
  assert.equal((html.match(/class="katex"/g) || []).length, 2);
});

test('带空格但含数学符号的仍是公式', () => {
  const html = render('$E = mc^2$ 与 $a + b$ 与 $p < 0.05$');
  assert.equal((html.match(/class="katex"/g) || []).length, 3);
});

test('公式里的中文必须包在 \\text{} 里', () => {
  assert.ok(looksLikeMath('\\text{收入}_{i,t}'), 'text 命令里的中文算公式');
  assert.ok(!looksLikeMath('100 到'), '裸中文不算公式');
  assert.ok(!looksLikeMath('x 和 '), '结尾空格 + 中文不算公式');
  assert.ok(!looksLikeMath('5 and'), '含空格且没有数学符号不算公式');
  assert.ok(!looksLikeMath('x '), '结尾空格不算公式');
});

test('代码块和行内代码里的 $ 不渲染', () => {
  const html = render('```sh\necho $HOME $PATH\n```\n\n行内 `$x$` 也是代码');
  assert.ok(!html.includes('katex'), '代码里不渲染公式');
  assert.ok(html.includes('echo $HOME $PATH'), '代码块内容原样保留');
});

test('数学环境常用命令可渲染（分数 / 求和 / 根号 / 矩阵）', () => {
  const html = render('$$\n\\frac{a}{b} \\sum_{i=1}^n x_i \\sqrt{y} \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}\n$$');
  assert.match(html, /class="katex-display"/);
  assert.ok(!html.includes('katex-error'), '不应有渲染错误');
});

test('公式写错时降级显示原文，不崩', () => {
  const html = render('$\\frac{a}{$');
  assert.match(html, /class="katex-error"/);
  assert.ok(html.includes('title="ParseError'), '错误原因放进 title 方便排查');
});

test('GFM 表格与公式可以混排', () => {
  const html = render('| 指标 | 值 |\n| - | - |\n| $R^2$ | 0.9 |\n');
  assert.match(html, /<table>/);
  assert.match(html, /class="katex"/);
});

test('无空格金额区间（$100-$200 / $5~$10）不被误伤', () => {
  const html = render('价格区间 $100-$200，促销价 $5~$10');
  assert.ok(!html.includes('katex'), '金额区间不是公式');
  assert.ok(html.includes('$100-$200') && html.includes('$5~$10'), '原文完整保留');
});

test('支持 LLM 常用的 \\(...\\) 与 \\[...\\] 公式语法，代码块与转义引用 \\[1\\] 不误伤', () => {
  const html = render('行内 \\(a^2 + b^2 = c^2\\) 与块级：\n\\[\\int_0^1 x^2 dx\\]\n\n参考文献 \\[1\\] 与行内代码 `\\(x\\)`：\n```tex\n\\[y\\]\n```');
  assert.match(html, /class="katex-display"/);
  assert.equal((html.match(/class="katex"/g) || []).length, 2, '仅渲染正文里的两个公式');
  assert.ok(html.includes('[1]'), '转义引用 \\[1\\] 不应变成居中公式');
  assert.ok(html.includes('\\(x\\)') && html.includes('\\[y\\]'), '代码里的转义原样保留');
});

console.log(`\n${pass}/${total} 通过`);
