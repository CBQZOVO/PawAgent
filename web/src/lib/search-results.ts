// 把 web_search 工具回填的文本解析成结构化结果，供前端渲染卡片。
// 文本由后端 formatResults 生成（deepseek/ddg 两个 provider 同一套格式）：
//   Search results for: <query>
//   ## 1. <title>
//   URL: <url>
//   Snippet: <snippet>
//   ...
//   Sources:
//   - [<title>](<url>)
export interface ParsedResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ParsedSearch {
  query: string;
  results: ParsedResult[];
}

export function parseSearchOutput(output: string): ParsedSearch | null {
  if (!output || !output.includes('Search results for:')) return null;
  const lines = output.split('\n');
  const query = (lines.find((l) => l.startsWith('Search results for:')) || '')
    .slice('Search results for:'.length)
    .trim();
  const results: ParsedResult[] = [];
  let cur: ParsedResult | null = null;
  for (const line of lines) {
    if (/^## \d+\. /.test(line)) {
      if (cur) results.push(cur);
      cur = { title: line.replace(/^## \d+\. /, ''), url: '', snippet: '' };
    } else if (cur && line.startsWith('URL: ')) {
      cur.url = line.slice(5).trim();
    } else if (cur && line.startsWith('Snippet: ')) {
      cur.snippet += (cur.snippet ? ' ' : '') + line.slice(9).trim();
    }
  }
  if (cur) results.push(cur);
  return results.length ? { query, results } : null;
}

/**
 * 从模型正文里拆出末尾的 Sources: 段（模型自己输出的 markdown 链接列表）。
 * 返回 { body, items }：body 正常渲染，items 渲染成可折叠来源条。
 */
export function extractSources(content: string): { body: string; items: ParsedResult[] } | null {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => /^sources:?\s*$/i.test(l.trim()));
  if (idx < 0) return null;
  const items: ParsedResult[] = [];
  const linkRe = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*$/;
  for (const line of lines.slice(idx + 1)) {
    const m = line.match(linkRe);
    if (m) {
      items.push({ title: m[1], url: m[2], snippet: '' });
    } else if (line.trim()) {
      break; // 离开 Sources 列表
    }
  }
  if (!items.length) return null;
  return { body: lines.slice(0, idx).join('\n').trimEnd(), items };
}

/** favicon：用 DuckDuckGo 的 icons 服务（国内可访问），加载失败前端回退到字母块 */
export function faviconUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return `https://icons.duckduckgo.com/ip3/${host}.ico`;
  } catch {
    return '';
  }
}
