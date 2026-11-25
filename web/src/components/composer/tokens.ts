// 占位符 token 的纯函数（纯 textarea + 高亮层方案）。
// 附件在文本里用 `@"文件名"` 表示，token 原子化（整块选中/删除/跳过）全靠这些边界计算。
// 独立成文件是为了能在 node 里直接单测。

export interface TokenSpan {
  name: string;
  start: number;    // @" 的下标
  end: number;      // 右引号前（token 内部最后一个字符位置）
  rawEnd: number;   // 右引号后（@"名" 完整结束下标）
}

/** 找出文本里所有 @"名" 占位符的边界 */
export function findTokens(text: string): TokenSpan[] {
  const out: TokenSpan[] = [];
  const re = /@"([^"]+)"/g;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const rawEnd = start + m[0].length;
    out.push({ name: m[1], start, end: rawEnd - 1, rawEnd });
  }
  return out;
}

/** 判断光标位置是否落在 token 内部（不含左右边界） */
export function tokenInside(tokens: TokenSpan[], pos: number): TokenSpan | null {
  return tokens.find((t) => pos > t.start && pos < t.rawEnd) ?? null;
}

/** 删除文本里第 idx 个 token，返回新文本 */
export function removeTokenAt(text: string, token: TokenSpan): string {
  return text.slice(0, token.start) + text.slice(token.rawEnd);
}

/** 占位符名集合（用于 diff 删附件） */
export function tokenNames(text: string): string[] {
  return findTokens(text).map((t) => t.name);
}

/**
 * diff 前后文本，返回「被删掉的占位符名」（按顺序）。
 * 用于：用户在文本里删了 @"名"，这里把它找出来通知外层删附件。
 */
export function removedTokenNames(before: string, after: string): string[] {
  const prev = tokenNames(before);
  const next = tokenNames(after);
  const remaining = [...next];
  const removed: string[] = [];
  for (const name of prev) {
    const idx = remaining.indexOf(name);
    if (idx >= 0) remaining.splice(idx, 1);
    else removed.push(name);
  }
  return removed;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 生成高亮层 HTML：@"名" 包成 chip-token，其余转义原样 */
export function buildHighlightHtml(text: string, tokens = findTokens(text)): string {
  if (!tokens.length) return escapeHtml(text) + '\n';
  let out = '';
  let last = 0;
  for (const t of tokens) {
    out += escapeHtml(text.slice(last, t.start));
    out += `<span class="chip-token">${escapeHtml(text.slice(t.start, t.rawEnd))}</span>`;
    last = t.rawEnd;
  }
  out += escapeHtml(text.slice(last)) + '\n';
  return out;
}
