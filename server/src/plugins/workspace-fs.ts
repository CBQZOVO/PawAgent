import { readFile, stat } from 'node:fs/promises';
import type { PawPlugin, ToolSchema } from '@paw/kernel';
import { FS_TOOL_SCHEMAS, executeFsTool } from '../tools/fs.js';
import { EDIT_TOOL_SCHEMAS, executeEditTool } from '../tools/edit.js';
import { resolveToolPath } from '../workspace.js';
import { recordFileChange } from '../snapshots.js';
import type { ServerToolExecCtx } from './types.js';

export const READ_FILE_SCHEMA: ToolSchema = {
  name: 'read_file',
  description: 'Read a text file with line numbers. Absolute path, or relative to workspace root. For big files use offset/limit to read a range (default: first 2000 lines). Output lines are prefixed "N\t" — copy text AFTER the tab when using edit_file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path, or path relative to workspace root' },
      offset: { type: 'number', description: 'First line to read (1-based, default 1)' },
      limit: { type: 'number', description: 'Max lines to read (default 2000)' },
      summary: { type: 'string', description: '用简体中文简述要读什么，20字以内' },
    },
    required: ['path'],
  },
};

export const workspaceFsPlugin: PawPlugin<ServerToolExecCtx> = {
  name: 'workspace-fs',
  tools: [
    {
      schema: READ_FILE_SCHEMA,
      meta: { readOnly: true, prunable: true },
      execute: async (args, _id, ctx) => {
        const abs = await resolveToolPath(String(args.path), ctx.workspace);
        const st = await stat(abs).catch(() => null);
        if (st && st.size > 8 * 1024 * 1024) {
          throw new Error(`文件超过 8MB（${(st.size / 1024 / 1024).toFixed(1)}MB），read_file 不支持整读；请用 run_command 的 head/tail/grep 分段查看`);
        }
        const full = await readFile(abs, 'utf-8');
        if (full.includes('\u0000')) {
          throw new Error(`该文件包含二进制数据（${abs}），read_file 只用于纯文本代码/配置；Office/PDF/图片请改用 document_text 解析`);
        }
        const lines = full.split('\n');
        const offset = Math.max(1, Number(args.offset) || 1);
        const limit = Math.min(5000, Math.max(1, Number(args.limit) || 2000));
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
        const end = offset - 1 + slice.length;
        return numbered + (end < lines.length ? `\n…[共 ${lines.length} 行，已显示 ${offset}-${end}，用 offset=${end + 1} 继续读]` : '');
      },
    },
    ...FS_TOOL_SCHEMAS.map((schema) => ({
      schema,
      meta: { readOnly: true, prunable: true },
      execute: (args: Record<string, unknown>, _id: string, ctx: ServerToolExecCtx) =>
        executeFsTool(schema.name, args, ctx.workspace, ctx.signal),
    })),
    ...EDIT_TOOL_SCHEMAS.map((schema) => ({
      schema,
      meta: { mutating: true },
      execute: async (args: Record<string, unknown>, _id: string, ctx: ServerToolExecCtx) => {
        const abs = typeof args.path === 'string'
          ? await resolveToolPath(args.path, ctx.workspace).catch(() => null)
          : null;
        const before = abs ? await readFile(abs, 'utf-8').catch(() => null) : null;
        const content = await executeEditTool(schema.name, args, ctx.workspace);
        if (abs && ctx.sessionId) {
          const after = await readFile(abs, 'utf-8').catch(() => null);
          await recordFileChange(ctx.sessionId, abs, before, after);
        }
        return content;
      },
    })),
  ],
};
