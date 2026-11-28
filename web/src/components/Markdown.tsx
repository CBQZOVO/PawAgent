import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { normalizeLatexDelimiters, remarkMathGuard } from '../lib/markdown-math';
import { mermaidComponents } from './MermaidBlock';
import 'katex/dist/katex.min.css';

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkMathGuard];
// strict: false 允许公式里直接出现中文（如 \frac{检出相关}{检出总数}）而不刷控制台警告
const REHYPE_PLUGINS: any[] = [[rehypeKatex, { strict: false }]];

/**
 * 聊天消息的 Markdown 渲染（GFM 表格/任务列表 + LaTeX 公式 + Mermaid 图）。
 *
 * 公式语法：行内 `$...$` / `\(...\)`，独立块 `$$...$$` / `\[...\]`。
 * 由 normalizeLatexDelimiters 归一化后交给 remark-math + rehype-katex 渲染。
 * remarkMathGuard 夹在中间：金额、shell 变量这类普通文本里的 $ 不当公式渲染（见 lib/markdown-math）。
 * KaTeX 的样式和字体随 katex.min.css 一起打包（Vite 自动处理字体文件）。
 * 三处消息渲染（正文 / 历史回放 / 交接摘要）共用这一份配置，别再各自写一遍。
 */
const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={mermaidComponents}>
      {normalizeLatexDelimiters(children)}
    </ReactMarkdown>
  );
});

export default Markdown;
