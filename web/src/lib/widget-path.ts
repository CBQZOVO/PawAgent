/**
 * 部件 Bridge 调用只接受相对路径：拒绝 scheme、协议相对 URL、点段、编码穿越与反斜杠。
 * 宿主的最终 URL 还会再做一次路由前缀断言，这里先挡住绝大多数越界写法。
 * 单独放一个文件，方便在不加载 React 的情况下测边界。
 */
export function safeWidgetApiPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.startsWith('//') || value.includes('\\') || value.includes('\0')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const segments = value.split(/[?#]/, 1)[0].split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return null;
    if (!/^[\p{L}\p{N}_\-.~%]+$/u.test(seg)) return null;
    if (/%2e|%2f|%5c/i.test(seg)) return null;
  }
  return '/' + segments.join('/');
}
