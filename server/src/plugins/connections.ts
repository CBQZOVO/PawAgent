import type { PawPlugin } from '@paw/kernel';
import { callApiSchema, executeCallApi } from '../tools/connections.js';
import type { ServerToolExecCtx } from './types.js';

export const connectionsPlugin: PawPlugin<ServerToolExecCtx> = {
  name: 'connections',
  tools: [
    {
      schema: { name: 'call_api', description: 'Call configured external API connection', parameters: { type: 'object', properties: {} } },
      resolveSchema: () => callApiSchema(),
      meta: { prunable: true },
      execute: (args, _id, ctx) => executeCallApi(args, ctx),
    },
  ],
};
