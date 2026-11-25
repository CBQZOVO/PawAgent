// Paw 宿主侧工具结果裁剪入口（算法在 @paw/kernel；由插件 meta.prunable 或 MCP 命名空间驱动）
import { pruneToolResult as kernelPruneToolResult } from '@paw/kernel';
import { pawPlugins } from '../plugins/index.js';

export function isPrunableTool(name: string): boolean {
  return pawPlugins.isPrunable(name) || name.includes('__');
}

export function pruneToolResult(content: string, readsThisRound: number, toolName?: string): string {
  return kernelPruneToolResult(content, readsThisRound, toolName);
}
