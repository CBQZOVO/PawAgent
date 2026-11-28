import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { mdSchema, resolveWorkspaceSrc } from '../lib/markdown-schema';
import { normalizeLatexDelimiters, remarkMathGuard } from '../lib/markdown-math';
import { mermaidComponents } from './MermaidBlock';
import 'katex/dist/katex.min.css';

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkMathGuard];
// 顺序要紧：先 raw 把 HTML 变成真实节点，再 sanitize 过滤危险标签，最后由 KaTeX 渲染公式节点
const REHYPE_PLUGINS: any[] = [rehypeRaw, [rehypeSanitize, mdSchema], [rehypeKatex, { strict: false }]];

/** 从渲染后的 DOM 收集 h1~h4 作为大纲——与正文渲染结果一一对应，不用正则重解析 */
function collectHeadings(root: HTMLElement | null): { level: number; text: string }[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll('h1, h2, h3, h4'))
    .map((el) => ({ level: Number(el.tagName[1]), text: el.textContent?.trim() || '' }));
}

/** 大纲侧栏：sticky 跟随滚动容器，点击跳转到对应标题；标题少于 3 个时不显示 */
function Outline({ content, bodyRef }: { content: string; bodyRef: React.RefObject<HTMLDivElement | null> }) {
  const [items, setItems] = useState<{ level: number; text: string }[]>([]);
  const [open, setOpen] = useState(true);
  // 依赖 content：文件切换后同一实例复用，必须随内容重新收集
  useEffect(() => {
    setItems(collectHeadings(bodyRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);
  const jump = (idx: number) => {
    const els = bodyRef.current?.querySelectorAll('h1, h2, h3, h4');
    els?.[idx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if (items.length < 3) return null;
  return (
    <nav className={'md-outline' + (open ? '' : ' collapsed')} aria-label="文档大纲">
      <div className="md-outline-head">
        {open ? <span>大纲</span> : null}
        <button type="button" onClick={() => setOpen((v) => !v)}
          title={open ? '收起大纲' : '展开大纲'} aria-label={open ? '收起大纲' : '展开大纲'}>
          {open ? <ChevronsRight size={13} /> : <ChevronsLeft size={13} />}
        </button>
      </div>
      {open && (
        <ul>
          {items.map((it, i) => (
            <li key={i} className={`lv${it.level}`} onClick={() => jump(i)} title={it.text}>{it.text}</li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/**
 * Markdown 预览（GitHub 风格排版 + LaTeX 公式 + Mermaid 图 + 可折叠大纲侧栏）。
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const components = useMemo<Components>(() => ({
    ...mermaidComponents,
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
  }), [root, filePath]);
  return (
    <div className="md-preview">
      <div className="md-flex">
        <div className="md-body" ref={bodyRef}>
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={components}
          >
            {normalizeLatexDelimiters(content)}
          </ReactMarkdown>
        </div>
        <Outline content={content} bodyRef={bodyRef} />
      </div>
    </div>
  );
}
