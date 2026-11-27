import type { PawPlugin, ToolSchema } from '@paw/kernel';
import { webSearch, webSearchDescription } from '../tools/web-search.js';
import { WEB_FETCH_SCHEMA, webFetch } from '../tools/web-fetch.js';
import type { ServerToolExecCtx } from './types.js';

export const WEB_SEARCH_SCHEMA: ToolSchema = {
  name: 'web_search',
  description: webSearchDescription(),
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only these domains' },
      blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude these domains' },
      summary: { type: 'string', description: '用简体中文简述本次调用的目的，25字以内，便于用户了解进展。' },
    },
    required: ['query'],
  },
};

export const OPEN_BROWSER_SCHEMA: ToolSchema = {
  name: 'open_browser',
  description: 'Open an http/https URL in Paw\'s right-hand built-in browser panel so the user can view or interact with the web page directly (e.g. local dev server http://localhost:3000, documentation, V2EX, dashboards). Use this whenever the user asks to open/show a webpage or open the built-in browser.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Target webpage URL (http:// or https://, or bare domain / localhost:port)' },
      title: { type: 'string', description: 'Optional tab title' },
      summary: { type: 'string', description: '用简体中文简述打开什么页面，20字以内' },
    },
    required: ['url'],
  },
};

function normalizeHttpUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s);
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `${local ? 'http' : 'https'}://${s}`;
  try {
    const u = new URL(candidate);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export const webPlugin: PawPlugin<ServerToolExecCtx> = {
  name: 'web',
  tools: [
    {
      schema: WEB_SEARCH_SCHEMA,
      meta: { readOnly: true },
      execute: (args, _id, ctx) => webSearch(args, ctx.signal),
    },
    {
      schema: WEB_FETCH_SCHEMA,
      meta: { readOnly: true, prunable: true },
      execute: (args, _id, ctx) => webFetch(args, ctx.signal),
    },
    {
      schema: OPEN_BROWSER_SCHEMA,
      meta: { readOnly: true },
      execute: async (args, _id, ctx) => {
        const url = normalizeHttpUrl(String(args.url ?? ''));
        if (!url) throw new Error('无效的网址：仅支持 http:// 或 https:// 页面地址');
        const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined;
        ctx.emit({ type: 'open_browser', url, ...(title ? { title } : {}) });
        return `已在右侧内置浏览器打开：${url}`;
      },
    },
  ],
};
