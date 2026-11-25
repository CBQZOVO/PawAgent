// MCP 接入：把外部 MCP server 的工具并入 Paw 工具注册表。
// 支持两种传输：stdio（~/.workbuddy/mcp.json 里那批单位 Python server）
// 和 Streamable HTTP（~/paw-mcp.json，如 CRM crm-harness-mcp）。
// 用官方 @modelcontextprotocol/sdk，启动时连接+发现 tools，执行时转发。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ToolSchema, ToolResult } from '@paw/shared';

interface ServerCfg {
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** 来自哪个配置文件（只给页面展示） */
  source?: string;
}

interface ConnectedServer {
  name: string;
  client: Client;
  tools: Map<string, { schema: ToolSchema; originalName: string }>;
}

/** 页面展示用：配置过的所有 server 都留一份，连接失败的也保留 */
export interface McpServerView {
  name: string;
  status: 'connecting' | 'connected' | 'failed';
  transport: 'HTTP' | 'STDIO';
  source: string;
  target: string;
  toolCount: number;
  error?: string;
}

const servers: ConnectedServer[] = [];
const serverViews = new Map<string, McpServerView>();
const prefix = (server: string, tool: string) => `${server}__${tool}`; // 命名空间，避免重名

/** 加载 MCP 配置：WorkBuddy 的 stdio servers + Paw 自己的 HTTP servers */
async function loadConfigs(): Promise<Record<string, ServerCfg>> {
  const out: Record<string, ServerCfg> = {};
  // 1. WorkBuddy stdio servers（只收 stdio，跳过 WorkBuddy 内部 http 代理）
  try {
    const d = JSON.parse(await readFile(path.join(os.homedir(), '.workbuddy', 'mcp.json'), 'utf-8'));
    for (const [name, cfg] of Object.entries(d.mcpServers || {})) {
      const c = cfg as ServerCfg;
      if (c.command) out[name] = { ...c, type: 'stdio', source: '~/.workbuddy/mcp.json' };
    }
  } catch { /* 没有配置就跳过 */ }
  // 2. Paw 自己的（支持 http/stdio，覆盖同名）
  try {
    const d = JSON.parse(await readFile(path.join(os.homedir(), 'paw-mcp.json'), 'utf-8'));
    for (const [name, cfg] of Object.entries(d.mcpServers || {})) {
      out[name] = { ...(cfg as ServerCfg), source: '~/paw-mcp.json' };
    }
  } catch { /* 没有就跳过 */ }
  return out;
}

/** 启动时连接所有 MCP server，发现工具（失败的不阻塞其他） */
export async function initMcp(): Promise<void> {
  const configs = await loadConfigs();
  await Promise.all(Object.entries(configs).map(async ([name, cfg]) => {
    // 先登记配置，连不连得上都会留在列表里。
    const view: McpServerView = {
      name,
      status: 'connecting',
      transport: cfg.type === 'http' || cfg.url ? 'HTTP' : 'STDIO',
      source: cfg.source || '',
      target: cfg.url || [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' ') || '',
      toolCount: 0,
    };
    serverViews.set(name, view);
    try {
      const client = new Client({ name: 'paw', version: '0.1.0' });
      if (cfg.type === 'http' || cfg.url) {
        const transport = new StreamableHTTPClientTransport(new URL(cfg.url!), {
          requestInit: { headers: cfg.headers },
        });
        await client.connect(transport);
      } else {
        const transport = new StdioClientTransport({
          command: cfg.command!, args: cfg.args || [], env: cfg.env,
        });
        await client.connect(transport);
      }
      const listed = await client.listTools();
      const tools = new Map<string, { schema: ToolSchema; originalName: string }>();
      for (const t of listed.tools) {
        const p = t.inputSchema as ToolSchema['parameters'];
        tools.set(prefix(name, t.name), {
          schema: {
            name: prefix(name, t.name),
            description: `[${name}] ${t.description || t.name}`,
            parameters: p?.properties ? p : { type: 'object', properties: {} },
          },
          originalName: t.name,
        });
      }
      servers.push({ name, client, tools });
      view.status = 'connected';
      view.toolCount = tools.size;
      console.log(`  MCP ${name}: ${tools.size} 个工具`);
    } catch (e) {
      view.status = 'failed';
      view.error = (e as Error).message.slice(0, 200);
      console.warn(`  MCP ${name} 连接失败，跳过：${view.error}`);
    }
  }));
}

/** 把所有 MCP 工具转成 Paw 的 ToolSchema（给模型看） */
export function mcpToolSchemas(): ToolSchema[] {
  return servers.flatMap((s) => [...s.tools.values()].map((t) => t.schema));
}

const MCP_CALL_TIMEOUT_MS = 60_000;
const MAX_MCP_OUTPUT_CHARS = 100_000;

/** 执行一个 MCP 工具；name 带 server__ 前缀，找不到返回 null（交给内置工具处理） */
export async function executeMcpTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult | null> {
  const sep = name.indexOf('__');
  if (sep < 0) return null;
  const serverName = name.slice(0, sep);
  const server = servers.find((s) => s.name === serverName);
  const tool = server?.tools.get(name);
  if (!server || !tool) return null;
  const timeoutSig = AbortSignal.timeout(MCP_CALL_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
  try {
    const r = await server.client.callTool({ name: tool.originalName, arguments: args }, undefined, { signal: combined });
    const contents = (r.content || []) as { type: string; text?: string }[];
    let text = contents
      .filter((c) => c.type === 'text')
      .map((c) => c.text || '')
      .join('\n');
    if (text.length > MAX_MCP_OUTPUT_CHARS) {
      text = text.slice(0, MAX_MCP_OUTPUT_CHARS) + `\n…[MCP 输出过大已截断，原始 ${text.length} 字符]`;
    }
    return { tool_call_id: name, content: text || '(工具无文本输出)', isError: !!r.isError };
  } catch (e) {
    const msg = timeoutSig.aborted && !signal?.aborted
      ? `MCP 工具响应超时（${MCP_CALL_TIMEOUT_MS / 1000}s）`
      : (e as Error).message;
    return { tool_call_id: name, content: `MCP 工具调用失败：${msg}`, isError: true };
  }
}

/** 所有配置过的 server（含失败项，给 API 展示） */
export function mcpServerViews(): McpServerView[] {
  return [...serverViews.values()];
}

/** 已连接 server 的名字（兼容旧调用方） */
export function mcpServerNames(): string[] {
  return servers.map((s) => s.name);
}
