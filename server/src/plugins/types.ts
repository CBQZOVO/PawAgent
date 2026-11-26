import type { PawPlugin, PluginContext, ToolExecutionContext, ToolResult, ToolSchema } from '@paw/kernel';
import type { ScheduledTask, Session, SessionSummary, TaskRun } from '@paw/shared';
import type { Hono } from 'hono';
import type {
  CallOptions,
  CallResult,
  Connection,
  ConnectionAuthProvider,
  ConnectionSsoProvider,
} from '../connections.js';
import type { McpServerView } from '../mcp.js';
import type { Memory } from '../tools/memory.js';
import type { WorkLog } from '../tools/worklog.js';

export interface ServerToolExecCtx extends ToolExecutionContext {
  workspace?: string | null;
  parentSessionId?: string;
  connectionCode?: string;
  gateway?: { baseUrl: string; apiKey: string; model: string };
}

/** 外部插件声明的自定义侧栏页面 */
export interface PluginPageSpec {
  /** 插件内唯一标识，如 'home' */
  id: string;
  /** 侧栏显示名称，如 '工作中心' */
  label: string;
  /** 内置图标名（briefcase/layout/globe/sparkles/box/compass/file/bar-chart/folder）或 emoji */
  icon?: string;
  /** 默认排序权重（内置项默认 10/20/30/40，越小越靠前，0 即排第 1 位） */
  order?: number;
  /** 相对插件目录的静态页面路径（如 'ui/index.html'）或 http(s):// 外部地址 */
  entry: string;
}

/** 解析后的页面清单项（透传给前端渲染侧栏与 iframe） */
export interface ResolvedPluginPage {
  key: string;
  pluginDir: string;
  pluginName: string;
  id: string;
  label: string;
  icon?: string;
  order: number;
  url: string;
}

/** 外部插件声明的会话流自定义部件（静态 HTML / 桥接页，运行在沙箱 iframe 中） */
export interface PluginWidgetSpec {
  /** 插件内唯一 ID，全局 key 为 `${pluginName}:${id}` */
  id: string;
  /** 默认卡片标题 */
  title?: string;
  /** 用途描述（管理页展示或注入提示词） */
  description?: string;
  /** 相对插件目录的静态入口，可带 ?query；或 https:// 远程地址 */
  entry: string;
  /** 默认展示位：消息流内嵌或右侧面板 */
  placement?: 'inline' | 'panel';
  /** inline 初始高度，默认 240 */
  defaultHeight?: number;
  /** inline 高度上限，默认 800（宿主硬上限 2000） */
  maxHeight?: number;
  /** 仅本机插件可开启同源模式；远程 URL 强制忽略 */
  sameOrigin?: boolean;
  /** 兜底绑定的系统连接 code */
  defaultConnection?: string;
  /** 允许访问的连接范围：默认 session（仅该卡片绑定值），或显式白名单 */
  allowedConnections?: 'session' | string[];
  /** 组件本身是远端业务页时，挂载前是否走 SSO 换票 */
  sso?: boolean;
}

/** 解析后的部件清单项（透传给前端渲染 WidgetFrame） */
export interface ResolvedPluginWidget {
  key: string;
  pluginDir: string;
  pluginName: string;
  id: string;
  title?: string;
  description?: string;
  url: string;
  placement: 'inline' | 'panel';
  defaultHeight: number;
  maxHeight: number;
  sameOrigin: boolean;
  defaultConnection?: string;
  allowedConnections?: 'session' | string[];
  sso: boolean;
}

export interface ServerPawPlugin extends PawPlugin<ServerToolExecCtx> {
  /** 可选：注入左侧菜单与自定义页面 */
  pages?: PluginPageSpec[];
  /** 可选：声明会话流内可渲染的自定义部件 */
  widgets?: PluginWidgetSpec[];
  /** 可选：注册插件专属 HTTP 路由，统一挂载在 /api/plugin-api/<plugin.name>/* */
  routes?: (router: Hono) => void;
}

/** 宿主注入给外部动态插件的稳定能力接口（外部插件无需 import 主仓库相对路径） */
export interface PluginHostApi {
  dataDir: string;
  pluginDir: string;
  config: Record<string, unknown>;
  getGateway(): { baseUrl: string; apiKey: string };
  resolveToolPath(p: string, workspace?: string | null): Promise<string>;
  getWorkspaceRoot(): Promise<string | null>;

  /** 工作区能力 */
  workspace: {
    getRoot(): Promise<string | null>;
    list(): Promise<string[]>;
    resolvePath(p: string, workspace?: string | null): Promise<string>;
  };

  /** 调用系统内已连接的 MCP 服务与工具 */
  mcp: {
    listServers(): McpServerView[];
    listTools(): ToolSchema[];
    callTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult | null>;
  };

  /** 调用 Paw 内置工具、其他插件工具与 MCP 工具 */
  tools: {
    list(ctx?: PluginContext): ToolSchema[];
    execute(
      name: string,
      args?: Record<string, unknown>,
      ctx?: Partial<ServerToolExecCtx>,
    ): Promise<ToolResult>;
  };

  /** 系统连接：读写、复用鉴权发请求，以及注册自定义认证/SSO 提供器 */
  connections: {
    load(): Connection[];
    get(code: string): Connection | undefined;
    call(code: string, opts: CallOptions, signal?: AbortSignal): Promise<CallResult>;
    registerAuthProvider(provider: ConnectionAuthProvider): void;
    unregisterAuthProvider(kind: string): boolean;
    registerSsoProvider(provider: ConnectionSsoProvider): void;
    unregisterSsoProvider(type: string): boolean;
  };

  /** 记忆库读写 */
  memory: {
    list(workspace?: string | null, limit?: number): Memory[];
    upsert(m: { id?: string; title: string; content: string; tags?: string; workspace?: string | null }): string;
    remove(id: string): boolean;
  };

  /** 工作日志读写 */
  worklog: {
    list(opts?: { workspace?: string | null; day?: string; days?: number; limit?: number }): WorkLog[];
    insert(entry: { workspace?: string | null; sessionId?: string; title: string; content: string; day?: string }): string;
    update(id: string, patch: { title?: string; content?: string }): boolean;
    remove(id: string): boolean;
  };

  /** 会话检索（只读） */
  sessions: {
    list(): SessionSummary[];
    get(id: string): Session | null;
  };

  /** 定时任务与运行历史（只读） */
  tasks: {
    list(): ScheduledTask[];
    get(id: string): ScheduledTask | null;
    listRuns(taskId?: string, limit?: number): TaskRun[];
  };

  /** 技能清单与正文读取 */
  skills: {
    list(): Promise<Array<{ dir: string; name: string; description: string; file: string }>>;
    read(id: string): Promise<string | null>;
  };

  /** 发送系统桌面通知 */
  notify(text: string): void;
}

export type ExternalPluginExport =
  | ServerPawPlugin
  | ((host: PluginHostApi) => ServerPawPlugin | Promise<ServerPawPlugin>);
