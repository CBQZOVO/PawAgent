import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { mdSchema, resolveWorkspaceSrc } from '../lib/markdown-schema';

/**
 * Markdown 预览（GitHub 风格排版）。
 *
 * 原始 HTML 必须解析：GitHub README 里 `<div align="center">` 包横幅、
 * `<img width="24px">` 排图标表、`<br>` 换行都是常规写法。
 * react-markdown 默认丢掉这些标签、把它们当纯文本吐出来 —— 所以加 rehype-raw，
 * 紧跟 rehype-sanitize 按 GitHub 白名单过滤（见 lib/markdown-schema）。
 */
export default function MarkdownPreview({ content, root, filePath }: {
  content: string;
  root: string;
  filePath: string;
}) {
  return (
    <div className="md-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // 顺序要紧：先 raw 把 HTML 变成真实节点，再 sanitize 过滤
        rehypePlugins={[rehypeRaw, [rehypeSanitize, mdSchema]]}
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
        {content}
      </ReactMarkdown>
    </div>
  );
}