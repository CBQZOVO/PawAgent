// MCP 接入：把外部 MCP server 的工具并入 Paw 工具注册表。
// 支持三种传输：stdio（~/.workbuddy/mcp.json 或 ~/.paw/mcp.json）、
// Streamable HTTP 与 SSE（~/.paw/mcp.json）。
// 用官方 @modelcontextprotocol/sdk，支持启动时连接、界面增删改与热重连。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ToolSchema, ToolResult } from '@paw/shared';
import { DATA_DIR } from './paths.js';

export interface McpServerConfig {
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  disabled?: boolean;
}

interface RawServerCfg {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  /** 为 true 时跳过连接；若同时无 url/command 则视为屏蔽 ~/.workbuddy/mcp.json 同名项的墓碑 */
  disabled?: boolean;
  /** 来自哪个配置文件（只给页面展示） */
  source?: string;
}

interface ConnectedServer {
  name: string;
  client: Client;
  tools: Map<string, { schema: ToolSchema; originalName: string; readOnly: boolean }>;
}

/** 页面展示用：配置过的所有 server 都留一份，连接失败与已禁用的也保留 */
export interface McpServerView {
  name: string;
  status: 'connecting' | 'connected' | 'failed' | 'disabled';
  transport: 'HTTP' | 'SSE' | 'STDIO';
  source: string;
  target: string;
  toolCount: number;
  error?: string;
  config: McpServerConfig;
}

const servers: ConnectedServer[] = [];
const serverViews = new Map<string, McpServerView>();
// 每个 MCP 服务名对应的连接代际号：每次重连/删除都会递增，旧连接异步返回后发现代际号过期就直接关闭丢弃，防止竞态覆盖
const connectGeneration = new Map<string, number>();
const prefix = (server: string, tool: string) => `${server}__${tool}`; // 命名空间，避免重名
const MCP_CONNECT_TIMEOUT_MS = 20_000; // 单个服务建立连接与拉取工具列表的超时上限，防止死进程拖挂服务

const PAW_MCP_SOURCE_LABEL = '~/.paw/mcp.json';

function legacyPawMcpPath(): string {
  return process.env.PAW_LEGACY_MCP_CONFIG
    ? path.resolve(process.env.PAW_LEGACY_MCP_CONFIG)
    : path.join(os.homedir(), 'paw-mcp.json');
}

/** Paw MCP 配置文件路径：~/.paw/mcp.json；首次使用若不存在且旧 ~/paw-mcp.json 存在，自动迁移一份过来 */
function pawMcpPath(): string {
  const target = process.env.PAW_MCP_CONFIG
    ? path.resolve(process.env.PAW_MCP_CONFIG)
    : path.join(DATA_DIR, 'mcp.json');
  if (!existsSync(target)) {
    const legacy = legacyPawMcpPath();
    if (legacy !== target && existsSync(legacy)) {
      try {
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(legacy, target);
        chmodSync(target, 0o600);
      } catch { /* 迁移失败则忽略，按空配置处理 */ }
    }
  }
  return target;
}

function workbuddyMcpPath(): string {
  return process.env.PAW_WORKBUDDY_MCP_CONFIG
    ? path.resolve(process.env.PAW_WORKBUDDY_MCP_CONFIG)
    : path.join(os.homedir(), '.workbuddy', 'mcp.json');
}

function normalizeConfig(cfg: RawServerCfg): McpServerConfig {
  const type: 'stdio' | 'http' | 'sse' =
    cfg.type === 'sse'
      ? 'sse'
      : cfg.type === 'http' || (!!cfg.url && cfg.type !== 'stdio')
        ? 'http'
        : 'stdio';
  const description = cfg.description?.trim() || undefined;
  const disabled = cfg.disabled ? true : undefined;
  if (type === 'http' || type === 'sse') {
    const out: McpServerConfig = { type, url: (cfg.url || '').trim() };
    if (cfg.headers && Object.keys(cfg.headers).length) out.headers = cfg.headers;
    if (description) out.description = description;
    if (disabled) out.disabled = true;
    return out;
  }
  const out: McpServerConfig = { type: 'stdio', command: (cfg.command || '').trim() };
  if (cfg.args?.length) out.args = cfg.args;
  if (cfg.env && Object.keys(cfg.env).length) out.env = cfg.env;
  if (description) out.description = description;
  if (disabled) out.disabled = true;
  return out;
}

async function readMcpFile(filePath: string): Promise<Record<string, RawServerCfg>> {
  try {
    const d = JSON.parse(await readFile(filePath, 'utf-8')) as { mcpServers?: Record<string, RawServerCfg> };
    return d && typeof d.mcpServers === 'object' && d.mcpServers ? d.mcpServers : {};
  } catch {
    return {};
  }
}

// 串行化 ~/.paw/mcp.json 的读-改-写操作，防止同时点保存/删除/导入时后写的请求把前一个请求改掉的配置覆盖丢失
let mcpConfigLock: Promise<void> = Promise.resolve();
async function withPawMcpLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = mcpConfigLock;
  let release!: () => void;
  mcpConfigLock = new Promise<void>((r) => { release = r; });
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function writePawMcpFile(mcpServers: Record<string, RawServerCfg>): Promise<void> {
  const filePath = pawMcpPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ mcpServers }, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await rename(tmp, filePath);
}

/** 加载 MCP 配置：WorkBuddy 的 stdio servers + Paw 自己的配置（覆盖或禁用同名项） */
async function loadConfigs(): Promise<Record<string, RawServerCfg>> {
  const out: Record<string, RawServerCfg> = {};
  // 1. WorkBuddy stdio servers（只收 stdio，跳过 WorkBuddy 内部 http 代理）
  const wb = await readMcpFile(workbuddyMcpPath());
  for (const [name, c] of Object.entries(wb)) {
    if (c?.command) out[name] = { ...c, type: 'stdio', source: '~/.workbuddy/mcp.json' };
  }
  // 2. Paw 自己的（支持 http/sse/stdio，覆盖同名；纯墓碑 { disabled: true } 则移除）
  const paw = await readMcpFile(pawMcpPath());
  for (const [name, c] of Object.entries(paw)) {
    if (!c) continue;
    if (c.disabled && !c.command && !c.url) {
      delete out[name];
    } else {
      out[name] = { ...c, source: PAW_MCP_SOURCE_LABEL };
    }
  }
  return out;
}

async function disconnectServer(name: string): Promise<void> {
  connectGeneration.set(name, (connectGeneration.get(name) ?? 0) + 1);
  const matching = servers.filter((s) => s.name === name);
  for (let i = servers.length - 1; i >= 0; i--) {
    if (servers[i].name === name) servers.splice(i, 1);
  }
  await Promise.all(matching.map((s) => s.client.close().catch(() => {})));
}

function transportLabel(type: McpServerConfig['type']): McpServerView['transport'] {
  if (type === 'http') return 'HTTP';
  if (type === 'sse') return 'SSE';
  return 'STDIO';
}

async function connectOne(name: string, rawCfg: RawServerCfg): Promise<McpServerView> {
  await disconnectServer(name);
  const myGen = (connectGeneration.get(name) ?? 0) + 1;
  connectGeneration.set(name, myGen);
  const cfg = normalizeConfig(rawCfg);
  const view: McpServerView = {
    name,
    status: cfg.disabled ? 'disabled' : 'connecting',
    transport: transportLabel(cfg.type),
    source: rawCfg.source || PAW_MCP_SOURCE_LABEL,
    target: cfg.type === 'stdio'
      ? [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' ')
      : (cfg.url || ''),
    toolCount: 0,
    config: cfg,
  };
  serverViews.set(name, view);
  if (cfg.disabled) return view;
  const client = new Client({ name: 'paw', version: '0.1.0' });
  try {
    const connectSignal = AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS);
    if (cfg.type === 'http') {
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url!), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      });
      await client.connect(transport, { signal: connectSignal });
    } else if (cfg.type === 'sse') {
      const transport = new SSEClientTransport(new URL(cfg.url!), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      });
      await client.connect(transport, { signal: connectSignal });
    } else {
      const transport = new StdioClientTransport({
        command: cfg.command!, args: cfg.args || [], env: cfg.env,
      });
      await client.connect(transport, { signal: connectSignal });
    }
    const listed = await client.listTools(undefined, { signal: AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS) });
    if (connectGeneration.get(name) !== myGen) {
      await client.close().catch(() => {});
      return serverViews.get(name) ?? view;
    }
    const tools = new Map<string, { schema: ToolSchema; originalName: string; readOnly: boolean }>();
    for (const t of listed.tools) {
      const p = t.inputSchema as ToolSchema['parameters'];
      const annotations = (t as { annotations?: { readOnlyHint?: boolean } }).annotations;
      tools.set(prefix(name, t.name), {
        schema: {
          name: prefix(name, t.name),
          description: `[${name}] ${t.description || t.name}`,
          parameters: p?.properties ? p : { type: 'object', properties: {} },
        },
        originalName: t.name,
        readOnly: annotations?.readOnlyHint === true,
      });
    }
    servers.push({ name, client, tools });
    view.status = 'connected';
    view.toolCount = tools.size;
    console.log(`  MCP ${name}: ${tools.size} 个工具`);
  } catch (e) {
    await client.close().catch(() => {});
    if (connectGeneration.get(name) !== myGen) {
      return serverViews.get(name) ?? view;
    }
    view.status = 'failed';
    view.error = (e as Error).message.slice(0, 200);
    console.warn(`  MCP ${name} 连接失败，跳过：${view.error}`);
  }
  return view;
}

/** 启动时连接所有 MCP server，发现工具（失败的不阻塞其他） */
export async function initMcp(): Promise<void> {
  const configs = await loadConfigs();
  await Promise.all(Object.entries(configs).map(([name, cfg]) => connectOne(name, cfg)));
}

/** 重新加载全部 MCP 配置并热重连 */
export async function reloadMcp(): Promise<void> {
  const existing = [...serverViews.keys()];
  await Promise.all(existing.map((n) => disconnectServer(n)));
  serverViews.clear();
  await initMcp();
}

/** 重连单个 MCP server */
export async function reconnectMcpServer(name: string): Promise<McpServerView> {
  const configs = await loadConfigs();
  const cfg = configs[name];
  if (!cfg) throw new Error(`未找到 MCP 服务：${name}`);
  return connectOne(name, cfg);
}

/** 校验并规范化 MCP 配置输入 */
export function validateMcpInput(name: string, input: Partial<McpServerConfig>): { name: string; config: McpServerConfig } {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('服务名称不能为空');
  if (cleanName.includes('__')) throw new Error('服务名称不能包含双下划线 __');
  if (!/^[\w.-]+$/.test(cleanName)) throw new Error('服务名称仅支持字母、数字、下划线、短横线和点');

  const rawType = String(input.type || '').toLowerCase();
  const type: McpServerConfig['type'] =
    rawType === 'sse'
      ? 'sse'
      : rawType === 'http' || rawType === 'streamablehttp' || (!!input.url && rawType !== 'stdio')
        ? 'http'
        : 'stdio';
  const description = String(input.description || '').trim() || undefined;
  const disabled = input.disabled === true ? true : undefined;

  if (type === 'http' || type === 'sse') {
    const url = String(input.url || '').trim();
    if (!url) throw new Error(`${type.toUpperCase()} 模式必须填写服务地址（URL）`);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`无效的 URL：${url}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('URL 必须以 http:// 或 https:// 开头');
    }
    const headers: Record<string, string> = {};
    if (input.headers && typeof input.headers === 'object') {
      for (const [k, v] of Object.entries(input.headers)) {
        if (k.trim()) headers[k.trim()] = String(v ?? '').trim();
      }
    }
    const config: McpServerConfig = { type, url };
    if (Object.keys(headers).length) config.headers = headers;
    if (description) config.description = description;
    if (disabled) config.disabled = true;
    return { name: cleanName, config };
  }

  const command = String(input.command || '').trim();
  if (!command) throw new Error('STDIO 模式必须填写启动命令');
  const args = Array.isArray(input.args)
    ? input.args.map((a) => String(a).trim()).filter(Boolean)
    : [];
  const env: Record<string, string> = {};
  if (input.env && typeof input.env === 'object') {
    for (const [k, v] of Object.entries(input.env)) {
      if (k.trim()) env[k.trim()] = String(v ?? '');
    }
  }
  const config: McpServerConfig = { type: 'stdio', command };
  if (args.length) config.args = args;
  if (Object.keys(env).length) config.env = env;
  if (description) config.description = description;
  if (disabled) config.disabled = true;
  return { name: cleanName, config };
}

/** 批量导入多个 MCP 服务（写入 ~/.paw/mcp.json 并并行热连接启用项） */
export async function importMcpServers(
  entries: Record<string, Partial<McpServerConfig>>,
  options?: { connect?: boolean },
): Promise<McpServerView[]> {
  const rawList = Object.entries(entries || {});
  if (!rawList.length) throw new Error('mcpServers 为空，至少需要一个服务');

  const validated: Array<{ name: string; config: McpServerConfig }> = [];
  for (const [rawName, rawCfg] of rawList) {
    if (!rawCfg || typeof rawCfg !== 'object' || Array.isArray(rawCfg)) {
      throw new Error(`服务「${rawName}」配置必须是对象`);
    }
    try {
      validated.push(validateMcpInput(rawName, rawCfg));
    } catch (e) {
      throw new Error(`服务「${rawName}」：${(e as Error).message}`);
    }
  }

  await withPawMcpLock(async () => {
    const paw = await readMcpFile(pawMcpPath());
    for (const { name, config } of validated) {
      paw[name] = { ...config };
    }
    await writePawMcpFile(paw);
  });

  if (options?.connect === false) {
    return validated.map(({ name, config }) => {
      const view: McpServerView = {
        name,
        status: config.disabled ? 'disabled' : 'failed',
        transport: transportLabel(config.type),
        source: PAW_MCP_SOURCE_LABEL,
        target: config.type === 'stdio'
          ? [config.command, ...(config.args || [])].filter(Boolean).join(' ')
          : (config.url || ''),
        toolCount: 0,
        config,
      };
      serverViews.set(name, view);
      return view;
    });
  }

  return Promise.all(validated.map(({ name, config }) => connectOne(name, { ...config, source: PAW_MCP_SOURCE_LABEL })));
}

/** 新增或编辑一个 MCP 服务（写入 ~/.paw/mcp.json 并立即热连接；支持重命名） */
export async function upsertMcpServer(
  rawName: string,
  input: Partial<McpServerConfig>,
  originalName?: string,
  options?: { connect?: boolean },
): Promise<McpServerView> {
  const { name, config } = validateMcpInput(rawName, input);
  const prev = originalName?.trim();
  if (prev && prev !== name) {
    await disconnectServer(prev);
    serverViews.delete(prev);
  }

  await withPawMcpLock(async () => {
    const paw = await readMcpFile(pawMcpPath());
    const wb = await readMcpFile(workbuddyMcpPath());
    if (prev && prev !== name) {
      if (wb[prev]?.command) paw[prev] = { disabled: true };
      else delete paw[prev];
    }
    paw[name] = { ...config };
    await writePawMcpFile(paw);
  });

  if (options?.connect === false) {
    const view: McpServerView = {
      name,
      status: config.disabled ? 'disabled' : 'failed',
      transport: transportLabel(config.type),
      source: PAW_MCP_SOURCE_LABEL,
      target: config.type === 'stdio'
        ? [config.command, ...(config.args || [])].filter(Boolean).join(' ')
        : (config.url || ''),
      toolCount: 0,
      config,
    };
    serverViews.set(name, view);
    return view;
  }
  return connectOne(name, { ...config, source: PAW_MCP_SOURCE_LABEL });
}

/** 删除一个 MCP 服务（若是 WorkBuddy 导入项则写 disabled 屏蔽，不改动外部文件） */
export async function deleteMcpServer(name: string): Promise<void> {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('服务名称不能为空');
  await disconnectServer(cleanName);
  serverViews.delete(cleanName);

  await withPawMcpLock(async () => {
    const paw = await readMcpFile(pawMcpPath());
    const wb = await readMcpFile(workbuddyMcpPath());
    if (wb[cleanName]?.command) {
      paw[cleanName] = { disabled: true };
    } else {
      delete paw[cleanName];
    }
    await writePawMcpFile(paw);
  });
}

/** 把所有 MCP 工具转成 Paw 的 ToolSchema（给模型看） */
export function mcpToolSchemas(): ToolSchema[] {
  return servers.flatMap((s) => [...s.tools.values()].map((t) => t.schema));
}

/** 查询已连接 MCP 工具是否显式声明了 annotations.readOnlyHint === true */
export function isMcpToolReadOnly(name: string): boolean {
  const sep = name.indexOf('__');
  if (sep < 0) return false;
  const serverName = name.slice(0, sep);
  const server = servers.find((s) => s.name === serverName);
  return server?.tools.get(name)?.readOnly === true;
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
