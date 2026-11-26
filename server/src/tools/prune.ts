// Paw 宿主侧工具结果裁剪入口（算法在 @paw/kernel；由插件 meta.prunable 或 MCP 命名空间驱动）
import { pruneToolResult as kernelPruneToolResult } from '@paw/kernel';
import { pawPlugins } from '../plugins/index.js';
import { saveTruncatedOutput } from './truncated.js';

export function isPrunableTool(name: string): boolean {
  return pawPlugins.isPrunable(name) || name.includes('__');
}

export function pruneToolResult(content: string, readsThisRound: number, toolName?: string): string {
  // 裁剪发生时把全文落盘，模型可按 read_file 提示读回被省略的中段
  return kernelPruneToolResult(content, readsThisRound, toolName, {
    onTruncate: (full, name) => saveTruncatedOutput(full, name),
  });
}
