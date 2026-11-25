// 工具统一入口：所有内置与扩展工具均通过 pawPlugins（PluginRegistry）声明式接入，
// 此处只负责白名单强校验、subagent 深度守卫以及外部 MCP 工具转发。
import type { ToolSchema, ToolResult } from '@paw/shared';
import { mcpToolSchemas, executeMcpTool } from '../mcp.js';
import { loadSubagents } from '../agent/agents.js';
import { runSubagentTool } from '../agent/subagent.js';
import { configurePluginsGateway, pawPlugins } from '../plugins/index.js';
import { WEB_SEARCH_SCHEMA } from '../plugins/web.js';
import { READ_FILE_SCHEMA } from '../plugins/workspace-fs.js';
import { RUN_COMMAND_SCHEMA } from '../plugins/shell.js';

export function configureTools(cfg: { baseUrl: string; apiKey: string }): void {
  configurePluginsGateway(cfg);
}

/** 向后兼容导出 */
export const TOOL_SCHEMAS: ToolSchema[] = [
  WEB_SEARCH_SCHEMA,
  READ_FILE_SCHEMA,
  RUN_COMMAND_SCHEMA,
];

export async function getAllToolSchemas(
  workspace?: string | null,
  opts?: { hasParentSession?: boolean },
): Promise<ToolSchema[]> {
  const defs = await loadSubagents(workspace);
  const subagentSchema: ToolSchema[] = defs.length ? [{
    name: 'subagent',
    description: '把一个独立子任务交给子代理，它在自己的上下文里跑完只回报结论（不占你的上下文）。适合：大范围探查、几个方向并行研究、你只要结论不要全文的事。不适合：读一两个已知文件、改一处代码、需要跟用户来回确认的事。默认看不到当前对话（任务描述必须自包含）；fork=true 可继承上下文。同一轮发起多个 subagent 调用会并行执行（最多4个），互相独立的任务请一次发多个调用而不是逐个等。',
    parameters: {
      type: 'object',
      properties: {
        subagent_name: { type: 'string', enum: defs.map((d) => d.name), description: '要调用的子代理名' },
        description: { type: 'string', description: '3-5 个词的短名，用于界面显示' },
        prompt: { type: 'string', description: '完整、自包含的任务说明：要做什么、在哪做（路径）、交付什么、已知的线索' },
        thoroughness: { type: 'string', enum: ['quick', 'medium', 'very thorough'], description: '探查彻底程度（quick / medium / very thorough），仅作为深度提示，不限制轮次预算。默认 medium' },
        fork: { type: 'boolean', description: 'true=继承主对话已完成的上下文（适合"基于刚才的讨论去深挖"）；默认 false=独立上下文，任务描述必须自包含' },
        output_schema: { type: 'object', description: '可选 JSON Schema：要求子代理最终用 structured_output 工具提交结构化结果（适合需要机器可读产出的任务）' },
        summary: { type: 'string', description: '用简体中文简述本次派活的目的，20字以内' },
      },
      required: ['subagent_name', 'prompt'],
    },
  }] : [];
  return [
    ...pawPlugins.getSchemas({
      workspace,
      parentSessionId: opts?.hasParentSession ? '__present__' : undefined,
    }),
    ...subagentSchema,
    ...mcpToolSchemas(),
  ];
}

export interface ToolContext {
  signal?: AbortSignal;
  workspace?: string | null;
  depth?: number;
  allowedTools?: string[];
  sessionId?: string;
  parentSessionId?: string;
  connectionCode?: string;
  gateway?: { baseUrl: string; apiKey: string; model: string };
  emit?: (ev: import('@paw/shared').AgentEvent) => void;
  parentMessages?: import('@paw/shared').ChatMessage[];
  outputSchema?: Record<string, unknown>;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  toolCallId: string,
  ctx: ToolContext = {},
): Promise<ToolResult> {
  // 白名单硬校验：schema 里不出现只是第一层，模型幻觉点名也执行不了
  if (ctx.allowedTools && !ctx.allowedTools.includes(name)) {
    return { tool_call_id: toolCallId, content: `工具 ${name} 不在本次运行的白名单里，已被拒绝`, isError: true };
  }
  if (name === 'subagent') {
    if ((ctx.depth || 0) >= 1) {
      return { tool_call_id: toolCallId, content: '子代理不能再派生子代理（防递归）', isError: true };
    }
    if (!ctx.gateway) {
      return { tool_call_id: toolCallId, content: 'subagent 缺少网关配置', isError: true };
    }
    return await runSubagentTool(args as never, toolCallId, {
      cfg: ctx.gateway,
      workspace: ctx.workspace,
      parentSignal: ctx.signal,
      parentSessionId: ctx.sessionId,
      emit: ctx.emit,
      parentMessages: ctx.parentMessages,
    });
  }
  if (pawPlugins.hasTool(name)) {
    const res = await pawPlugins.execute(name, args, toolCallId, {
      signal: ctx.signal,
      workspace: ctx.workspace,
      depth: ctx.depth ?? 0,
      allowedTools: ctx.allowedTools,
      sessionId: ctx.sessionId,
      parentSessionId: ctx.parentSessionId,
      connectionCode: ctx.connectionCode,
      gateway: ctx.gateway,
      emit: ctx.emit ?? (() => {}),
      parentMessages: ctx.parentMessages,
      outputSchema: ctx.outputSchema,
    });
    if (res) return res;
  }
  if (name.includes('__')) {
    const r = await executeMcpTool(name, args, ctx.signal);
    if (r) return { ...r, tool_call_id: toolCallId };
  }
  return { tool_call_id: toolCallId, content: `Unknown tool: ${name}`, isError: false };
}
