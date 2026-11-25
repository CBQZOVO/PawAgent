// @paw/kernel 声明式插件机制：工具、提示词块、子代理目录与生命周期钩子的统一注册表。
import type {
  AskQuestion,
  ToolExecutionContext,
  ToolResult,
  ToolRuntime,
  ToolSchema,
} from './types.js';
import { pruneToolResult } from './prune.js';

export interface PluginContext {
  workspace?: string | null;
  sessionId?: string;
  parentSessionId?: string;
  connectionCode?: string;
  [key: string]: unknown;
}

export interface PluginToolMeta {
  /** 无副作用、可与相邻只读调用并发执行（进入并发池） */
  readOnly?: boolean;
  /** 是否改变外部/工作区状态（成功执行后清空乒乓重复计数窗口）；支持按参数动态判定 */
  mutating?: boolean | ((args: Record<string, unknown>) => boolean);
  /** 大结果回填模型历史前自动三档裁剪 */
  prunable?: boolean;
  /** 裁剪省略处给模型的定制续读提示 */
  pruneHint?: string;
}

export interface PluginTool<TExecCtx extends ToolExecutionContext = ToolExecutionContext> {
  schema: ToolSchema;
  /** 可选动态 schema 生成器（如枚举配置项动态变化时）；返回 null 表示本次不暴露 */
  resolveSchema?: (ctx: PluginContext) => ToolSchema | null;
  meta?: PluginToolMeta;
  /** 可选动态门控：返回 false 时本次运行不暴露该工具 */
  available?: (ctx: PluginContext) => boolean;
  execute(args: Record<string, unknown>, toolCallId: string, ctx: TExecCtx): Promise<string | ToolResult> | string | ToolResult;
  /** 可选：自定义回填模型历史的脱敏/精简逻辑 */
  formatHistory?: (content: string, prunableCountInRound: number) => string;
}

export interface TurnSummary {
  workspace?: string | null;
  sessionId?: string;
  userText: string;
  assistantText: string;
  toolNames: string[];
}

export interface PawPlugin<TExecCtx extends ToolExecutionContext = ToolExecutionContext> {
  name: string;
  version?: string;
  tools?: PluginTool<TExecCtx>[];
  promptBlocks?: (ctx: PluginContext) => Promise<string | null | undefined> | string | null | undefined;
  subagentDirs?: string[];
  hooks?: {
    onInit?: () => Promise<void> | void;
    onTurnComplete?: (turn: TurnSummary) => Promise<void> | void;
    onDispose?: () => Promise<void> | void;
  };
}

export interface ToToolRuntimeOptions<TExecCtx extends ToolExecutionContext = ToolExecutionContext> {
  pluginCtx?: PluginContext;
  /** 包装内核 ToolExecutionContext 为宿主扩展上下文 */
  adaptExecCtx?: (ctx: ToolExecutionContext) => TExecCtx;
  summarizeCall?: (name: string, args?: Record<string, unknown>, provided?: string) => string;
  normalizeAskQuestions?: (raw: unknown) => AskQuestion[];
}

export class PluginRegistry<TExecCtx extends ToolExecutionContext = ToolExecutionContext> {
  private plugins = new Map<string, PawPlugin<TExecCtx>>();
  private tools = new Map<string, PluginTool<TExecCtx>>();

  register(plugin: PawPlugin<TExecCtx>): this {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`插件 "${plugin.name}" 已注册`);
    }
    for (const tool of plugin.tools || []) {
      const toolName = tool.schema.name;
      if (this.tools.has(toolName)) {
        throw new Error(`插件 "${plugin.name}" 的工具 "${toolName}" 与已注册工具重名`);
      }
      this.tools.set(toolName, tool);
    }
    this.plugins.set(plugin.name, plugin);
    return this;
  }

  registerAll(plugins: PawPlugin<TExecCtx>[]): this {
    for (const p of plugins) this.register(p);
    return this;
  }

  unregister(pluginName: string): boolean {
    const p = this.plugins.get(pluginName);
    if (!p) return false;
    for (const tool of p.tools || []) this.tools.delete(tool.schema.name);
    return this.plugins.delete(pluginName);
  }

  listPlugins(): string[] {
    return [...this.plugins.keys()];
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getTool(name: string): PluginTool<TExecCtx> | undefined {
    return this.tools.get(name);
  }

  getSchemas(ctx: PluginContext = {}): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const tool of this.tools.values()) {
      if (tool.available && !tool.available(ctx)) continue;
      const schema = tool.resolveSchema ? tool.resolveSchema(ctx) : tool.schema;
      if (schema) out.push(schema);
    }
    return out;
  }

  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.meta?.readOnly === true;
  }

  isMutating(name: string, args: Record<string, unknown>): boolean {
    const m = this.tools.get(name)?.meta?.mutating;
    if (typeof m === 'function') return m(args);
    return m === true;
  }

  isPrunable(name: string): boolean {
    return this.tools.get(name)?.meta?.prunable === true;
  }

  formatHistoryResult(name: string, content: string, prunableCountInRound: number): string | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    if (tool.formatHistory) return tool.formatHistory(content, prunableCountInRound);
    if (tool.meta?.prunable) {
      return pruneToolResult(
        content,
        prunableCountInRound,
        name,
        tool.meta.pruneHint ? { hint: () => tool.meta!.pruneHint! } : undefined,
      );
    }
    return content;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    ctx: TExecCtx,
  ): Promise<ToolResult | null> {
    const tool = this.tools.get(name);
    if (!tool) return null;
    try {
      const res = await tool.execute(args, toolCallId, ctx);
      if (typeof res === 'string') return { tool_call_id: toolCallId, content: res, isError: false };
      return { ...res, tool_call_id: res.tool_call_id || toolCallId };
    } catch (e) {
      return { tool_call_id: toolCallId, content: `Tool error: ${(e as Error).message}`, isError: true };
    }
  }

  getSubagentDirs(): string[] {
    const dirs: string[] = [];
    for (const p of this.plugins.values()) {
      if (p.subagentDirs?.length) dirs.push(...p.subagentDirs);
    }
    return dirs;
  }

  async collectPromptBlocks(ctx: PluginContext = {}): Promise<string[]> {
    const blocks: string[] = [];
    for (const p of this.plugins.values()) {
      if (!p.promptBlocks) continue;
      const b = await p.promptBlocks(ctx);
      if (b && b.trim()) blocks.push(b.trim());
    }
    return blocks;
  }

  async initAll(): Promise<void> {
    for (const p of this.plugins.values()) await p.hooks?.onInit?.();
  }

  async emitTurnComplete(turn: TurnSummary): Promise<void> {
    for (const p of this.plugins.values()) await p.hooks?.onTurnComplete?.(turn);
  }

  async disposeAll(): Promise<void> {
    for (const p of this.plugins.values()) await p.hooks?.onDispose?.();
  }

  /** 直接生成可直接传给 runAgent 的 ToolRuntime */
  toToolRuntime(opts: ToToolRuntimeOptions<TExecCtx> = {}): ToolRuntime {
    const pluginCtx = opts.pluginCtx ?? {};
    return {
      getSchemas: () => this.getSchemas(pluginCtx),
      execute: async (name, args, toolCallId, ctx) => {
        if (ctx.allowedTools && !ctx.allowedTools.includes(name)) {
          return { tool_call_id: toolCallId, content: `工具 ${name} 不在本次运行的白名单里，已被拒绝`, isError: true };
        }
        const execCtx = opts.adaptExecCtx ? opts.adaptExecCtx(ctx) : (ctx as TExecCtx);
        const res = await this.execute(name, args, toolCallId, execCtx);
        return res ?? { tool_call_id: toolCallId, content: `Unknown tool: ${name}`, isError: true };
      },
      isReadOnly: (name) => this.isReadOnly(name),
      isMutating: (name, args) => this.isMutating(name, args),
      isPrunable: (name) => this.isPrunable(name),
      formatHistoryResult: (name, content, roundReads) =>
        this.formatHistoryResult(name, content, roundReads) ?? content,
      summarizeCall: opts.summarizeCall,
      normalizeAskQuestions: opts.normalizeAskQuestions,
    };
  }
}
