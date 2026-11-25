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
  ],
};
