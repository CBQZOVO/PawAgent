// IDE 模式文件服务：目录树（懒加载单层）+ 读文件（带行号上限）。
// 安全边界：所有路径必须落在指定工作区内（resolve 后前缀校验），防目录穿越。
import { readdir, readFile, writeFile, stat, open } from 'node:fs/promises';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '__pycache__', '.venv', 'venv', 'target', '.idea', '.gradle', 'out', '.paw-trash']);
const MAX_ENTRIES = 400;
/**
 * 读文件上限。
 *
 * 行数不再是瓶颈：前端是虚拟滚动，只渲染视口内几十行，20 万行的 DOM 高度
 * 也只有 520 万像素（远低于浏览器 3355 万的上限）。真正占内存的是字节数，
 * 所以只按 8MB 兜底（超过就预览前 8MB），避免有人点开 500MB 的日志把进程撑爆。
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 200_000;

export interface TreeEntry { name: string; path: string; dir: boolean; size?: number }
export interface TreeResult {
  entries: TreeEntry[];
  truncated: boolean;
  /** 该目录下的真实总项数（截断时前端据此提示「共 N 项」） */
  total: number;
}

/** 路径必须在工作区内（或就是工作区根本身） */
function insideRoot(root: string, p: string): string | null {
  const abs = path.resolve(root, p);
  const rel = path.relative(path.resolve(root), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

/**
 * 列目录单层。
 *
 * filter：大目录必须能搜。真实项目里存在 6300+ 子目录的扁平模块目录（CRM/igix），
 * 按字母截断到 400 等于 c 之后的模块永远点不到。有 filter 时先过滤再截断，
 * 用户输入几个字母就能定位到任意深处的模块。
 */
export async function listTree(root: string, sub: string, filter?: string): Promise<TreeResult | { error: string }> {
  const dir = insideRoot(root, sub || '.');
  if (!dir) return { error: '路径越界' };
  let items;
  try { items = await readdir(dir, { withFileTypes: true }); }
  catch (e) { return { error: (e as Error).message }; }
  const visible = items.filter((i) => !SKIP.has(i.name));
  const q = (filter || '').trim().toLowerCase();
  const matched = q ? visible.filter((i) => i.name.toLowerCase().includes(q)) : visible;
  // 目录在前、按名排序（IDE 惯例）
  const sorted = matched.sort((a, b) =>
    (a.isDirectory() === b.isDirectory()) ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1);
  const entries: TreeEntry[] = sorted.slice(0, MAX_ENTRIES).map((it) => ({
    name: it.name,
    path: path.join(dir, it.name),
    dir: it.isDirectory(),
    // 不取 size：树里不显示文件大小，逐项串行 stat 纯属白干（网络盘上尤其慢）
  }));
  return { entries, truncated: sorted.length > MAX_ENTRIES, total: sorted.length };
}

export async function readWorkspaceFile(root: string, file: string): Promise<
  { path: string; content: string; lines: number; truncated: boolean; binary?: boolean; size: number; notice?: string } | { error: string }> {
  const abs = insideRoot(root, file);
  if (!abs) return { error: '路径越界' };
  let s;
  try { s = await stat(abs); } catch { return { error: '文件不存在' }; }
  if (s.isDirectory()) return { error: '这是目录' };

  // 大文件不再一律拒绝：只读前 1MB 给出预览（真实项目里 4 万行的 liquibase
  // changelog、生成的 city.json 都超 1MB，直接拒绝等于看不到任何内容）。
  const oversize = s.size > MAX_FILE_BYTES;
  let text: string;
  try {
    if (oversize) {
      const fh = await open(abs, 'r');
      try {
        const buf = Buffer.alloc(MAX_FILE_BYTES);
        const { bytesRead } = await fh.read(buf, 0, MAX_FILE_BYTES, 0);
        text = buf.subarray(0, bytesRead).toString('utf-8');
      } finally { await fh.close(); }
      // 末尾可能是被截断的半个 UTF-8 字符或多半行，丢掉最后一行
      const cut = text.lastIndexOf('\n');
      if (cut > 0) text = text.slice(0, cut);
    } else {
      text = await readFile(abs, 'utf-8');
    }
  } catch { return { error: '读取失败' }; }

  if (text.includes('\u0000')) {
    // IDE 里图片/PDF 走 /api/fs/raw 浏览器原生预览；这里只给个说明性文本，
    // 供「加入对话」等仍按文本消费的链路用，不再说「无法预览」
    const hint = isRawPreviewable(abs) ? '（二进制文件，可在 IDE 中预览）' : '（二进制文件，无法预览）';
    return { path: abs, content: hint, lines: 0, truncated: false, binary: true, size: s.size };
  }
  const all = text.split('\n');
  const truncated = oversize || all.length > MAX_LINES;
  const content = all.length > MAX_LINES ? all.slice(0, MAX_LINES).join('\n') : text;
  const shown = content.split('\n').length;
  const notice = oversize
    ? `文件 ${(s.size / 1024 / 1024).toFixed(1)}MB，已预览前 ${shown} 行（读满 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限）。完整内容用 Agent 的 read_file 分段读。`
    : all.length > MAX_LINES
      ? `文件共 ${all.length} 行，已预览前 ${MAX_LINES} 行。`
      : undefined;
  // lines 报「已加载的行数」；oversize 时总行数未知，不给误导性的数字
  return { path: abs, content, lines: shown, truncated, size: s.size, notice };
}

/** 能交给浏览器原生预览的 MIME（图片 + PDF） */
const RAW_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  pdf: 'application/pdf',
};
/** raw 接口一次性把整个文件吐给浏览器，给足上限（PDF 常超 8MB）但不能无界 */
const MAX_RAW_BYTES = 64 * 1024 * 1024;

/** 是否是可原生预览的二进制（图片/PDF）——给前端和 readWorkspaceFile 共用 */
export function isRawPreviewable(file: string): boolean {
  return !!RAW_MIME[path.extname(file).slice(1).toLowerCase()];
}

/** IDE 编辑器手动保存：同样限制在工作区内，只写文本，拒绝二进制/目录 */
export async function writeWorkspaceFile(root: string, file: string, content: string): Promise<{ ok: true; size: number } | { error: string }> {
  const abs = insideRoot(root, file);
  if (!abs) return { error: '路径越界' };
  let s;
  try { s = await stat(abs); } catch { return { error: '文件不存在' }; }
  if (!s.isFile()) return { error: '不是文件' };
  if (isRawPreviewable(abs)) return { error: '二进制文件不能从编辑器保存' };
  if (content.includes('\u0000')) return { error: '内容含二进制字符' };
  try {
    await writeFile(abs, content, 'utf-8');
    const st = await stat(abs);
    return { ok: true, size: st.size };
  } catch (e) { return { error: `保存失败：${(e as Error).message}` }; }
}

/**
 * 工作区内二进制只读接口：Markdown 里的图片 + IDE 里点开的图片/PDF 都走这里。
 * 返回原始字节 + 正确 MIME，浏览器自己渲染；路径仍限制在工作区内。
 */
export async function readWorkspaceImage(root: string, file: string): Promise<
  { mime: string; data: Buffer } | { error: string }> {
  const abs = insideRoot(root, file);
  if (!abs) return { error: '路径越界' };
  const mime = RAW_MIME[path.extname(abs).slice(1).toLowerCase()];
  if (!mime) return { error: '不是支持预览的格式' };
  let s;
  try { s = await stat(abs); } catch { return { error: '文件不存在' }; }
  if (!s.isFile()) return { error: '不是文件' };
  if (s.size > MAX_RAW_BYTES) return { error: '文件超过 64MB，浏览器无法预览' };
  try { return { mime, data: await readFile(abs) }; } catch { return { error: '读取失败' }; }
}