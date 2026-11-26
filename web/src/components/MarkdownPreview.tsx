import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { mdSchema, resolveWorkspaceSrc } from '../lib/markdown-schema';
import { normalizeLatexDelimiters, remarkMathGuard } from '../lib/markdown-math';
import 'katex/dist/katex.min.css';

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkMathGuard];
// 顺序要紧：先 raw 把 HTML 变成真实节点，再 sanitize 过滤危险标签，最后由 KaTeX 渲染公式节点
const REHYPE_PLUGINS: any[] = [rehypeRaw, [rehypeSanitize, mdSchema], [rehypeKatex, { strict: false }]];

/**
 * Markdown 预览（GitHub 风格排版 + LaTeX 公式）。
 *
 * 原始 HTML 必须解析：GitHub README 里 `<div align="center">` 包横幅、
 * `<img width="24px">` 排图标表、`<br>` 换行都是常规写法。
 * react-markdown 默认丢掉这些标签、把它们当纯文本吐出来 —— 所以加 rehype-raw，
 * 紧跟 rehype-sanitize 按 GitHub 白名单过滤（见 lib/markdown-schema），
 * 最后由 rehype-katex 渲染经白名单放行的 math-inline / math-display 节点。
 */
export default function MarkdownPreview({ content, root, filePath }: {
  content: string;
  root: string;
  filePath: string;
}) {
  return (
    <div className="md-preview">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={{
          a: ({ href, children, ...rest }) => {
            const external = !!href && /^(https?:|mailto:)/i.test(href);
            return external
              ? <a {...rest} href={href} target="_blank" rel="noreferrer noopener">{children}</a>
              : <span className="md-local-link" title={href}>{children}</span>;
          },
          img: ({ src, alt, ...rest }) => (
            <img {...rest} className="md-img" alt={alt || ''} loading="lazy"
              src={resolveWorkspaceSrc(typeof src === 'string' ? src : undefined, root, filePath)} />
          ),
        }}
      >
        {normalizeLatexDelimiters(content)}
      </ReactMarkdown>
    </div>
  );
}