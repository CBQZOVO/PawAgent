// 工具结果进「模型历史」前的三档留头留尾裁剪。
// 前端通过 tool_done 事件仍拿到完整输出，只有喂给模型的历史被精简。

export interface PruneOptions {
  sparseHeadChars?: number;
  sparseTailChars?: number;
  normalHeadChars?: number;
  normalTailChars?: number;
  denseHeadChars?: number;
  denseTailChars?: number;
  denseAt?: number;
  hint?: (toolName?: string) => string;
}

const DEFAULTS = {
  sparseHeadChars: 10_000,
  sparseTailChars: 2_000,
  normalHeadChars: 6_000,
  normalTailChars: 1_500,
  denseHeadChars: 2_500,
  denseTailChars: 700,
  denseAt: 5,
};

export function defaultPruneHint(toolName?: string): string {
  if (toolName === 'read_file') return '需要完整内容请用 read_file 的 offset/limit 分段读取中间行';
  if (toolName === 'search_content' || toolName === 'search_file') return '需要更精确结果请缩小 path 范围或加 glob 过滤';
  if (toolName === 'git_diff' || toolName === 'git_log') return '需要查看特定文件请传 file 参数限定路径';
  return '如需查看省略段请缩小查询范围或精确过滤';
}

export function pruneToolResult(
  content: string,
  readsThisRound: number,
  toolName?: string,
  opts: PruneOptions = {},
): string {
  const denseAt = opts.denseAt ?? DEFAULTS.denseAt;
  const dense = readsThisRound >= denseAt;
  const sparse = readsThisRound <= 2;
  const head = dense
    ? (opts.denseHeadChars ?? DEFAULTS.denseHeadChars)
    : sparse
      ? (opts.sparseHeadChars ?? DEFAULTS.sparseHeadChars)
      : (opts.normalHeadChars ?? DEFAULTS.normalHeadChars);
  const tail = dense
    ? (opts.denseTailChars ?? DEFAULTS.denseTailChars)
    : sparse
      ? (opts.sparseTailChars ?? DEFAULTS.sparseTailChars)
      : (opts.normalTailChars ?? DEFAULTS.normalTailChars);
  if (content.length <= head + tail + 500) return content;
  const omitted = content.length - head - tail;
  const hint = (opts.hint ?? defaultPruneHint)(toolName);
  return content.slice(0, head)
    + `\n\n…[已精简 ${omitted} 字符（本轮一共 ${readsThisRound} 个大结果调用，全文会让后续每轮请求变慢）。`
    + `${hint}]…\n\n`
    + content.slice(-tail);
}
