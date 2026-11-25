import type { PawPlugin } from '@paw/kernel';
import { MEMORY_TOOL_SCHEMAS, executeMemoryTool } from '../tools/memory.js';
import { WORKLOG_TOOL_SCHEMAS, executeWorklogTool } from '../tools/worklog.js';
import type { ServerToolExecCtx } from './types.js';

export const memoryPlugin: PawPlugin<ServerToolExecCtx> = {
  name: 'memory',
  tools: [
    ...MEMORY_TOOL_SCHEMAS.map((schema) => ({
      schema,
      meta: { readOnly: schema.name === 'memory_search' },
      execute: (args: Record<string, unknown>, _id: string, ctx: ServerToolExecCtx) =>
        executeMemoryTool(schema.name, args, ctx.workspace),
    })),
    ...WORKLOG_TOOL_SCHEMAS.map((schema) => ({
      schema,
      meta: { readOnly: schema.name === 'worklog_search' },
      execute: (args: Record<string, unknown>) => executeWorklogTool(schema.name, args),
    })),
  ],
};
