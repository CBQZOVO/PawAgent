/**
 * Mermaid 代码块的纯识别逻辑：不 import mermaid / React，方便在 node 里跑管道测试。
 * react-markdown 会把 ```mermaid 渲染成 <pre><code class="language-mermaid">...</code></pre>，
 * 我们在 pre 这一层拦截，避免 <pre> 里塞 <div> 的非法嵌套。
 */

export const MERMAID_CLASS = 'language-mermaid';

/** 工具输出/问题文本是不是含完整 mermaid 代码块：只有它才交给 Markdown 渲染，其余保持原样纯文本 */
export function containsMermaidBlock(text: string | undefined): boolean {
  return typeof text === 'string' && /```mermaid[^\n]*\n[\s\S]*?```/i.test(text);
}

/** className 可能是字符串或字符串数组（rehype 传进来两种都有）；不区分大小写，与 containsMermaidBlock 一致 */
export function isMermaidLanguage(className: unknown): boolean {
  if (typeof className === 'string') {
    return className.split(/\s+/).some((c) => c.toLowerCase() === MERMAID_CLASS);
  }
  if (Array.isArray(className)) {
    return className.some((c) => typeof c === 'string' && c.toLowerCase() === MERMAID_CLASS);
  }
  return false;
}

/**
 * SVG 安全兜底校验（mermaid strict 模式之上的二次检查）：
 * - 必须以 <svg 开头；
 * - 禁止 <script>、javascript: 协议；
 * - 禁止标签内 on* 事件属性（注意必须带空白/引号前导边界，避免误杀节点文字里的 config=、content=、response=）。
 */
export function isSafeMermaidSvg(svg: string): boolean {
  const out = svg.trimStart();
  if (!out.startsWith('<svg')) return false;
  if (/<script\b/i.test(out)) return false;
  if (/(?:^|[\s"'/])on[a-z]+\s*=/i.test(out)) return false;
  if (/\bjavascript\s*:/i.test(out)) return false;
  return true;
}

const DIAGRAM_LABELS: ReadonlyArray<[RegExp, string]> = [
  [/^(?:flowchart|graph)\b/i, '流程图'],
  [/^sequenceDiagram\b/i, '时序图'],
  [/^classDiagram\b/i, '类图'],
  [/^stateDiagram(?:-v2)?\b/i, '状态图'],
  [/^erDiagram\b/i, 'ER 图'],
  [/^gantt\b/i, '甘特图'],
  [/^pie\b/i, '饼图'],
  [/^mindmap\b/i, '思维导图'],
  [/^gitGraph\b/i, 'Git 图'],
  [/^timeline\b/i, '时间轴'],
  [/^journey\b/i, '旅程图'],
  [/^xychart-beta\b/i, '图表'],
];

/** 从源码首条有效指令推断中文图类型标签，供卡片顶栏展示 */
export function detectMermaidLabel(code: string): string {
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;
    for (const [re, label] of DIAGRAM_LABELS) {
      if (re.test(line)) return label;
    }
    break;
  }
  return 'Mermaid';
}

/** 从 React 子节点里递归取纯文本；只认 props.children，不碰其它属性 */
export function textFromChildren(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromChildren).join('');
  if (node && typeof node === 'object') {
    const props = (node as { props?: { children?: unknown } }).props;
    if (props && 'children' in props) return textFromChildren(props.children);
  }
  return '';
}
