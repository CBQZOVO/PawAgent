// web_fetch：抓网页转纯文本。对标 Qoder WebFetch / CodeBuddy web_fetch。
// 零依赖：fetch + 正则剥 HTML（script/style/注释/标签），实体解码，截断防爆炸。
import type { ToolSchema } from '@paw/shared';

const MAX_BYTES = 3 * 1024 * 1024;   // 下载上限 3MB
const MAX_CHARS = 24000;             // 给模型的文本上限（约 8k token）

export const WEB_FETCH_SCHEMA: ToolSchema = {
  name: 'web_fetch',
  description: 'Fetch a web page and return its readable text content (HTML stripped). Use after web_search to read a result page, or to read docs/API references. Returns title + main text, truncated at 24k chars.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full http/https URL to fetch' },
      summary: { type: 'string', description: '用简体中文简述要读哪个页面，25字以内' },
    },
    required: ['url'],
  },
};

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'",
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', times: '×', divide: '÷',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** HTML → 可读文本：块级标签转换行，列表项加 bullet，其余标签剥掉 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || '');
  // 先剥所有 script/style/noscript/textarea（含带属性的变体；百度把 CSS 藏在 textarea 里），再剥块级噪音区
  let s = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/<textarea\b[\s\S]*?<\/textarea\s*>/gi, '')
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|header|footer|nav|aside|svg|form)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    // 标签名后加 \b：<link 也以 <li 开头，不能把它换成项目符号；引号配对同理
    .replace(/<li\b[^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/gi, '• ')
    .replace(/<(h[1-6])\b[^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/gi, '\n## ')
    .replace(/<td\b[^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/gi, ' | ')
    // 只有「< 紧跟标签名/斜杠/!」才算标签：正文里的 "< 40rem" 不能被当成标签开头，
    // 否则它会一路吞到属性值里的 '>'，把 rel="stylesheet" 这类片段留在正文里。
    // 引号配对让属性值里的 '>' 不提前结束标签。
    .replace(/<[a-zA-Z!/][^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/g, '');
  s = decodeEntities(s)
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: s };
}

export async function webFetch(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const url = String(args.url || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('url 必须是 http/https 开头');
  // 30s 超时：慢站点不该拖住整个工具轮次（web_search 也有 20s 超时，同一标准）
  const resp = await fetch(url, {
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const ctype = resp.headers.get('content-type') || '';
  // 限量下载
  const reader = resp.body?.getReader();
  let raw = '';
  if (reader) {
    const dec = new TextDecoder();
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      raw += dec.decode(value, { stream: true });
      if (bytes > MAX_BYTES) { await reader.cancel(); break; }
    }
  } else {
    raw = await resp.text();
  }
  // JSON / 纯文本直接给
  if (ctype.includes('json') || ctype.includes('text/plain')) {
    const body = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) + '\n…[截断]' : raw;
    return `URL: ${url}\nContent-Type: ${ctype}\n\n${body}`;
  }
  const { title, text } = htmlToText(raw);
  const body = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n…[内容过长已截断，可用更具体的 URL 或分段抓取]' : text;
  return `URL: ${url}\n标题: ${title || '(无)'}\n\n${body || '(页面无可读文本，可能是纯 JS 渲染)'}`;
}