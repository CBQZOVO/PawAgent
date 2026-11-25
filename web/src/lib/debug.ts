/** UI 调试日志：POST 给 server 落盘 /tmp/paw-ui-debug.log（排查 chip/拖拽用，临时设施） */
let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function debugLog(line: string): void {
  pending.push(line);
  if (timer) return;
  // 200ms 内合批发一条，避免每个按键一个请求
  timer = setTimeout(() => {
    const batch = pending;
    pending = [];
    timer = null;
    if (!batch.length) return;
    void fetch('/api/debug-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line: batch.join('\n') }),
    }).catch(() => { /* 调试日志失败不影响主流程 */ });
  }, 200);
}
