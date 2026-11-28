// 内置 web_search：deepseek / kimi / ddg 三 Provider，纯 fetch 零额外依赖。
//
// 配置优先级：环境变量 > ~/.paw/search-config.json > 网关 Key > 默认(deepseek)
//   SEARCH_PROVIDER=deepseek|kimi|ddg
//   DEEPSEEK_SEARCH_KEY=sk-...（或 ~/.paw/search-key.txt）
//   KIMI_SEARCH_KEY=sk-...（或 MOONSHOT_API_KEY；缺省复用 api.moonshot.cn 网关 Key）
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LEGACY_DIRS, dataFile } from '../paths.js';

// 搜索渠道选择与密钥均放 ~/.paw，重装不丢
const CONFIG_FILE = dataFile('search-config.json', LEGACY_DIRS);
const FALLBACK_KEY_FILE = dataFile('search-key.txt');

const DEEPSEEK_API = 'https://api.deepseek.com/v1/tools/search';
const KIMI_API = 'https://api.moonshot.cn/v1/tools/search';
const DDG_HTML = 'https://duckduckgo.com/html/?q=';
const MAX_RESULTS = 10;
const TIMEOUT_MS = 20000;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type SearchProviderName = 'deepseek' | 'kimi' | 'ddg';

interface SearchConfig {
  provider: SearchProviderName;
  deepseekKey?: string;
  kimiKey?: string;
}

/** 国内站 Key：已登录 Kimi 网关时直接复用，省一次手工配置 */
async function kimiKeyFromGateway(): Promise<string | undefined> {
  try {
    const cfg = JSON.parse(await readFile(dataFile('gateway-config.json'), 'utf-8')) as {
      GATEWAY_URL?: string; baseUrl?: string; GATEWAY_KEY?: string; apiKey?: string;
    };
    const base = String(cfg.GATEWAY_URL || cfg.baseUrl || '').toLowerCase();
    if (base.includes('api.moonshot.cn')) return cfg.GATEWAY_KEY || cfg.apiKey || undefined;
  } catch {
    /* 没配置 Kimi 网关 */
  }
  return undefined;
}

/** 读配置：env > search-config.json > 默认 */
export async function loadSearchConfig(): Promise<SearchConfig> {
  let fileCfg: Partial<SearchConfig> = {};
  try {
    fileCfg = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
  } catch {
    /* 无配置文件用默认 */
  }
  const raw = process.env.SEARCH_PROVIDER || fileCfg.provider || 'deepseek';
  const provider: SearchProviderName = raw === 'kimi' ? 'kimi' : raw === 'ddg' ? 'ddg' : 'deepseek';
  let key = process.env.DEEPSEEK_SEARCH_KEY || fileCfg.deepseekKey;
  if (!key) {
    try {
      key = (await readFile(FALLBACK_KEY_FILE, 'utf-8')).trim();
    } catch {
      /* ddg 不需要 key */
    }
  }
  const kimiKey = process.env.KIMI_SEARCH_KEY || process.env.MOONSHOT_API_KEY || fileCfg.kimiKey || await kimiKeyFromGateway();
  return { provider, deepseekKey: key, kimiKey };
}

/** 读 search-config.json（不存在/损坏当空） */
async function readRawSearchConfig(): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function writeRawSearchConfig(cfg: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600).catch(() => undefined);
}

/** 保存 provider 切换（写 search-config.json，供 /api/search-config 用） */
export async function saveSearchProvider(provider: SearchProviderName): Promise<void> {
  const cfg = await readRawSearchConfig();
  cfg.provider = provider;
  await writeRawSearchConfig(cfg);
}

/** 保存搜索渠道 key：传空串即清除该渠道的 key */
export async function saveSearchKeys(patch: { deepseekKey?: string; kimiKey?: string }): Promise<void> {
  const cfg = await readRawSearchConfig();
  if (patch.deepseekKey !== undefined) {
    if (patch.deepseekKey) cfg.deepseekKey = patch.deepseekKey;
    else delete cfg.deepseekKey;
  }
  if (patch.kimiKey !== undefined) {
    if (patch.kimiKey) cfg.kimiKey = patch.kimiKey;
    else delete cfg.kimiKey;
  }
  await writeRawSearchConfig(cfg);
}

// ---------- 域名过滤（抄 Mano passesDomainFilter）----------
function extractHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function passesDomainFilter(url: string, allowed: string[], blocked: string[]): boolean {
  const host = extractHost(url);
  if (!host) return false;
  for (const d of blocked) {
    if (d && host.endsWith(d.trim().toLowerCase())) return false;
  }
  if (!allowed.length) return true;
  return allowed.some((d) => d && host.endsWith(d.trim().toLowerCase()));
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

// ---------- Provider: DeepSeek Search API ----------
async function searchDeepseek(query: string, allowed: string[], blocked: string[], key: string, signal?: AbortSignal): Promise<SearchHit[]> {
  if (!key) throw new Error('deepseek provider 需要 DEEPSEEK_SEARCH_KEY（或 key.txt）');
  const resp = await fetch(DEEPSEEK_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, count: MAX_RESULTS, need_content: false }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`DeepSeek search HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { results?: Array<Record<string, string>> };
  const out: SearchHit[] = [];
  for (const it of data.results || []) {
    const url = it.url || '';
    if (!passesDomainFilter(url, allowed, blocked)) continue;
    out.push({ title: it.title || '', url, snippet: (it.summary || '').slice(0, 600), date: it.date || '' });
  }
  return out;
}

// ---------- Provider: Kimi 联网搜索 Basic ----------
async function searchKimi(query: string, allowed: string[], blocked: string[], key: string, signal?: AbortSignal): Promise<SearchHit[]> {
  if (!key) throw new Error('kimi provider 需要 KIMI_SEARCH_KEY（或 Kimi 网关 Key）');
  const resp = await fetch(KIMI_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    // 服务端给 15s，比本地 20s 超时短，避免客户端先把请求掐断
    body: JSON.stringify({ text_query: query, limit: MAX_RESULTS, timeout_seconds: 15, include_content: false }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Kimi search HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { search_results?: Array<Record<string, string>> };
  const out: SearchHit[] = [];
  for (const it of data.search_results || []) {
    const url = it.url || '';
    if (!passesDomainFilter(url, allowed, blocked)) continue;
    out.push({ title: it.title || '', url, snippet: (it.snippet || '').slice(0, 600), date: it.date || '' });
  }
  return out;
}

// ---------- Provider: DuckDuckGo HTML（零 key）----------
function cleanHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** DDG /l/?uddg= 跳转 → 真实 URL（含 HTML 实体解码，Python 版踩过的坑） */
function ddgDecodeRedirect(href: string): string {
  try {
    let h = href
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'");
    if (h.startsWith('//')) h = 'https:' + h;
    const u = new URL(h, 'https://duckduckgo.com');
    if (u.pathname.startsWith('/l/')) {
      const real = u.searchParams.get('uddg');
      if (real) return real; // URLSearchParams 已做 percent-decode
    }
    return h;
  } catch {
    return href;
  }
}

async function searchDdg(query: string, allowed: string[], blocked: string[], signal?: AbortSignal): Promise<SearchHit[]> {
  const resp = await fetch(DDG_HTML + encodeURIComponent(query), {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`DDG HTTP ${resp.status}`);
  const page = await resp.text();
  const snippets: string[] = [];
  const snRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/g;
  let sm: RegExpExecArray | null;
  while ((sm = snRe.exec(page))) snippets.push(cleanHtml(sm[1] || sm[2] || ''));

  const out: SearchHit[] = [];
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = titleRe.exec(page))) {
    const url = ddgDecodeRedirect(m[1]);
    const title = cleanHtml(m[2]);
    const snippet = snippets[i] || '';
    i += 1;
    if (!passesDomainFilter(url, allowed, blocked)) continue;
    out.push({ title, url, snippet });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

// ---------- 结果格式化（对齐 Mano formatResults + Sources）----------
function formatResults(results: SearchHit[], query: string, summary?: string, error?: string): string {
  const lines: string[] = [];
  if (summary) lines.push(summary, '');
  lines.push('Search results for: ' + query, '');
  results.slice(0, MAX_RESULTS).forEach((r, idx) => {
    lines.push(`## ${idx + 1}. ${r.title || r.url}`);
    lines.push('URL: ' + r.url);
    if (r.snippet) lines.push('Snippet: ' + r.snippet.replace(/\n/g, ' '));
    lines.push('');
  });
  if (error) lines.push('Search errors: ' + error, '');
  if (!results.length) lines.push('No search results found for: ' + query);
  if (results.length) {
    lines.push('Sources:');
    for (const r of results.slice(0, MAX_RESULTS)) lines.push(`- [${r.title || r.url}](${r.url})`);
  }
  return lines.join('\n');
}

/** web_search 工具入口：args 对齐 Mano schema（query/allowed_domains/blocked_domains/summary） */
export async function webSearch(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  let query = typeof args.query === 'string' ? args.query : '';
  if (!query && Array.isArray(args.queries)) query = String(args.queries[0] || ''); // 兼容旧调用
  query = query.trim();
  if (!query) return 'Error: query must be a non-empty string.';

  const toArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);
  const allowed = toArr(args.allowed_domains);
  const blocked = toArr(args.blocked_domains);
  const summary = typeof args.summary === 'string' ? args.summary : undefined;

  const cfg = await loadSearchConfig();
  let results: SearchHit[] = [];
  let error: string | undefined;
  try {
    results =
      cfg.provider === 'ddg'
        ? await searchDdg(query, allowed, blocked, signal)
        : cfg.provider === 'kimi'
          ? await searchKimi(query, allowed, blocked, cfg.kimiKey || '', signal)
          : await searchDeepseek(query, allowed, blocked, cfg.deepseekKey || '', signal);
  } catch (e) {
    error = `${cfg.provider} search failed: ${(e as Error).message.slice(0, 200)}`;
  }
  return formatResults(results, query, summary, error);
}

/** 工具描述（动态注入当前月份，抄 Mano 防搜错年份） */
export function webSearchDescription(): string {
  const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return (
    'Search the web and use the results to inform responses.\n\n' +
    'Usage:\n' +
    '- Provides up-to-date information for current events and recent data\n' +
    '- Use for information beyond knowledge cutoff\n\n' +
    'Domain filtering:\n' +
    '- allowed_domains: only include results from these websites\n' +
    '- blocked_domains: exclude these websites\n\n' +
    "CRITICAL REQUIREMENT:\n- After answering, you MUST include a 'Sources:' section with all relevant " +
    'URLs as markdown hyperlinks [Title](https://...). This is MANDATORY.\n\n' +
    `IMPORTANT: use the correct year in queries. Current month is ${month}.`
  );
}