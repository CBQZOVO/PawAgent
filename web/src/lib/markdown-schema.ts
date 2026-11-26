import { defaultSchema } from 'rehype-sanitize';

/**
 * Markdown 预览的 HTML 白名单。
 *
 * 基线是 GitHub 自己那套（hast-util-sanitize defaultSchema）：
 * script / on* 事件 / javascript: 协议一律清掉。
 * 在此之上补 GitHub README 的常见写法：div/p 居中、img 尺寸、figure 等。
 * 单独成模块是为了能脱离 React 直接跑管道测试。
 */
export const mdSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'figure', 'figcaption', 'mark', 'abbr', 'center'],
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div || []), 'align'],
    p: [...(defaultSchema.attributes?.p || []), 'align'],
    img: [...(defaultSchema.attributes?.img || []), 'width', 'height', 'loading', 'align'],
    a: [...(defaultSchema.attributes?.a || []), 'target', 'rel'],
    source: [...(defaultSchema.attributes?.source || []), 'src', 'type', 'media'],
    code: [...(defaultSchema.attributes?.code || []), ['className', /^language-./, 'math-inline', 'math-display']],
    span: [...(defaultSchema.attributes?.span || []), 'className'],
  },
};

/** 工作区内的相对资源路径 → 服务端只读接口（越界校验在服务端） */
export function resolveWorkspaceSrc(src: string | undefined, root: string, filePath: string): string | undefined {
  if (!src) return undefined;
  if (/^(https?:|data:)/i.test(src)) return src;
  const baseDir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  const joined = src.startsWith('/') ? src : [baseDir, src].filter(Boolean).join('/');
  return `/api/fs/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(joined)}`;
}