/**
 * 文件扩展名工具 + 图标配色。
 * 语法着色原先在这里（单遍 tokenizer 输出 HTML），换 Monaco 后已删除——
 * 代码高亮现在全由 Monaco 自己的 language 服务负责（见 CodeEditor / MONACO_LANG）。
 */

export function extOf(path: string): string {
  const base = (path.split(/[\\/]/).pop() || '').toLowerCase();
  if (base === 'dockerfile') return 'sh';
  if (base === 'makefile') return 'sh';
  if (base.startsWith('.') && !base.slice(1).includes('.')) return base.slice(1);
  return base.split('.').pop() || '';
}

/** 文件图标颜色：用 IDE 外壳的 --gh-* 变量，跟 Monaco 主题各自独立 */
export function fileHue(ext: string): string {
  if (['ts', 'tsx'].includes(ext)) return 'var(--gh-link)';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'var(--gh-focus)';
  if (ext === 'json' || ext === 'jsonc') return 'var(--gh-tab-accent)';
  if (ext === 'py') return 'var(--gh-link)';
  if (['css', 'scss', 'less'].includes(ext)) return 'var(--gh-term-cyan)';
  if (['html', 'svg', 'xml', 'vue'].includes(ext)) return 'var(--gh-term-red)';
  if (['md', 'markdown'].includes(ext)) return 'var(--gh-fg-muted)';
  if (['sh', 'bash', 'zsh'].includes(ext)) return 'var(--gh-term-green)';
  if (['yaml', 'yml', 'toml', 'ini'].includes(ext)) return 'var(--gh-term-yellow)';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'icns', 'ico', 'psd'].includes(ext)) return 'var(--gh-term-magenta)';
  if (['lock', 'log'].includes(ext)) return 'var(--gh-ln)';
  return 'var(--gh-fg-muted)';
}
