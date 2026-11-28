import { validateSchema, type PawPlugin } from '@paw/kernel';
import { TODO_TOOL_SCHEMA, executeTodoWrite } from '../tools/todo.js';
import { SKILL_TOOL_SCHEMAS, executeSkillTool } from '../tools/skills.js';
import { ASK_USER_SCHEMA } from '../tools/ask-user.js';
import { SEARCH_PARENT_SESSION_SCHEMA, executeSearchParentSession } from '../tools/parent-session.js';
import { RENDER_MERMAID_SCHEMA, executeRenderMermaid } from '../tools/mermaid.js';
import type { ServerToolExecCtx } from './types.js';

export const corePlugin: PawPlugin<ServerToolExecCtx> = {
  name: 'core',
  tools: [
    {
      schema: TODO_TOOL_SCHEMA,
      meta: { readOnly: true },
      execute: (args) => executeTodoWrite(args),
    },
    {
      schema: RENDER_MERMAID_SCHEMA,
      meta: { readOnly: true },
      execute: (args, toolCallId) => executeRenderMermaid(args, toolCallId),
    },
    ...SKILL_TOOL_SCHEMAS.map((schema) => ({
      schema,
      meta: { mutating: schema.name === 'create_skill' },
      execute: (args: Record<string, unknown>) => executeSkillTool(schema.name, args),
    })),
    {
      schema: ASK_USER_SCHEMA,
      execute: (_args, toolCallId) => ({
        tool_call_id: toolCallId,
        content: 'ask_user 只在主对话可用：当前是无人值守的执行路径，没有人能回答你。请基于已有信息自行判断，或把不确定之处写进最终结论。',
        isError: true,
      }),
    },
    {
      schema: SEARCH_PARENT_SESSION_SCHEMA,
      meta: { readOnly: true, prunable: true },
      available: (ctx) => Boolean(ctx.parentSessionId),
      execute: (args, _id, ctx) => executeSearchParentSession(args, ctx.parentSessionId),
    },
    {
      // structured_output 由内核在白名单包含它时动态注入 schema，此处仅注册执行器（默认不出现在普通工具列表）
      schema: {
        name: 'structured_output',
        description: '提交最终结构化结果',
        parameters: { type: 'object', properties: { data: { type: 'object' } }, required: ['data'] },
      },
      available: () => false,
      execute: (args, toolCallId, ctx) => {
        if (ctx.outputSchema) {
          const errs = validateSchema(args.data, ctx.outputSchema);
          if (errs.length) {
            return {
              tool_call_id: toolCallId,
              content: `结构化校验失败：${errs.join('；')}。请修正 data 后重新调用 structured_output。`,
              isError: true,
            };
          }
        }
        return '结构化结果已接收 ✓';
      },
    },
  ],
};
