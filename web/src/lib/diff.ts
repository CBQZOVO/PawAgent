/**
 * 极简行级 diff：剥掉公共前缀和后缀，中间的旧行全标删、新行全标增。
 *
 * 为什么不用完整 LCS：edit_file 的典型场景是「改中间几行」，
 * 前后夹逼已经能给出正确直觉；而且无依赖、O(n)、结果可预测。
 * 人家的客户端（CodeBuddy/WorkBuddy）也是本地用 args 自己算 diff，不靠服务端。
 */
export interface DiffLine { type: 'add' | 'del' | 'same'; text: string }
export interface LineDiff { added: number; removed: number; lines: DiffLine[] }

export function computeLineDiff(oldStr: string, newStr: string): LineDiff {
  // 去掉末尾单个换行再切，避免「改了一行」被算成多一个空行
  const strip = (s: string) => s.replace(/\n$/, '');
  const a = strip(oldStr).split('\n');
  const b = strip(newStr).split('\n');

  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre &&
         a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const lines: DiffLine[] = [];
  for (let i = 0; i < pre; i++) lines.push({ type: 'same', text: a[i] });
  for (let i = pre; i < a.length - suf; i++) lines.push({ type: 'del', text: a[i] });
  for (let i = pre; i < b.length - suf; i++) lines.push({ type: 'add', text: b[i] });
  for (let i = 0; i < suf; i++) lines.push({ type: 'same', text: a[a.length - suf + i] });

  return { added: b.length - pre - suf, removed: a.length - pre - suf, lines };
}

/** write_file 没有 old_string：整篇都是新增 */
export function computeWriteDiff(content: string): LineDiff {
  const lines = content.replace(/\n$/, '').split('\n').map((text) => ({ type: 'add' as const, text }));
  return { added: lines.length, removed: 0, lines };
}
