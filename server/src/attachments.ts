// 附件落盘：用户发来的图片/文件都在本机存一份真实文件，消息里的 @ 引用直接用真实路径。
//
// 为什么必须有（2026-11-26 两条排查会话的教训）：
// - 图片只在它所属的那条 user 消息上作为 image part 发给模型；后续轮次的历史里这条消息
//   只剩 @"原名" 占位，不再带图。用户说「刚才那张图」时模型看不到画面，又没有任何文件路径
//   可以交给工具，只能满磁盘找图，或者硬着头皮按用户文字描述去猜。
// - 桌面端带来的 localPath 指向来源目录（微信临时目录 temp/RWTemp、下载目录…），随时会被清。
//
// 落盘位置：~/.paw/attachments/<会话id>/<内容哈希前12位>-<原名>
// 文件名带内容哈希 → 同一份附件重发/编辑重发不会产生重复文件；也不需要额外的索引文件，
// listSessionAttachments 直接从目录还原「本会话发过哪些附件、叫什么、在哪」。
// 消息里的 @ 引用统一用落盘后的真实路径（见 chat-input.ts），历史里也能照着路径找回。
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment } from '@paw/shared';
import { DATA_DIR } from './paths.js';

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp',
};
/** 从来源目录拷贝原件的大小上限（超过就不拷，localPath 保持指向来源） */
const MAX_COPY_BYTES = 100 * 1024 * 1024;

/** 附件根目录（测试可显式传入，别碰真实的 ~/.paw） */
export function attachmentRoot(dir?: string): string {
  return dir ?? path.join(DATA_DIR, 'attachments');
}

/** 某个会话的附件目录：<根>/<会话id>（会话 id 里的非法字符换成下划线） */
function sessionDir(sessionId: string | undefined, dir?: string): string {
  const id = (sessionId || 'unsaved').replace(/[^\w-]/g, '_').slice(0, 64);
  return path.join(attachmentRoot(dir), id);
}

/** 解析 data URL；不是图片 data URL 返回 null */
export function parseImageDataUrl(content: string): { mime: string; bytes: Buffer } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(content);
  if (!m) return null;
  const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  return bytes.length ? { mime: m[1].toLowerCase(), bytes } : null;
}

/** 安全文件名：去掉路径部分，非法字符换成下划线 */
function safeName(name: string): string {
  const base = path.basename(name || 'file');
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').slice(-80);
  return cleaned && cleaned !== '_' ? cleaned : 'file';
}

/** @ 引用匹配用的键：原名归一化（去路径、去扩展名、小写）。落盘文件名的中段就是它。 */
export function nameKey(name: string): string {
  return safeName(name).replace(/\.[^.]*$/, '').toLowerCase();
}

/** 落盘后的一份附件 */
export interface StoredAttachment {
  /** 用户发来时的归一化原名（nameKey(原名)） */
  key: string;
  /** 本机绝对路径 */
  path: string;
  /** 首次落盘时间（毫秒时间戳） */
  at: number;
}

/**
 * 列出某个会话落盘过的所有附件，按落盘时间升序。
 * 不需要额外的索引文件：落盘文件名就是「12 位内容哈希-原名」，直接从目录还原。
 */
export async function listSessionAttachments(sessionId?: string, dir?: string): Promise<StoredAttachment[]> {
  if (!sessionId) return [];
  const dirPath = sessionDir(sessionId, dir);
  let files: string[];
  try { files = await readdir(dirPath); } catch { return []; }
  const out: StoredAttachment[] = [];
  for (const f of files) {
    const m = /^[0-9a-f]{12}-(.+)$/.exec(f);
    if (!m) continue;
    try {
      const st = await stat(path.join(dirPath, f));
      if (st.isFile()) out.push({ key: m[1].replace(/\.[^.]*$/, '').toLowerCase(), path: path.join(dirPath, f), at: st.mtimeMs });
    } catch { /* 刚被清掉的文件，跳过 */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 附件落盘（图片 + 文件一律处理），成功后把 localPath 指向落盘文件（原地修改附件对象）。
 *   - 图片：解码 data URL 写盘；
 *   - 文件带本机来源路径：直接拷贝原件（二进制也能存，且不再依赖微信临时目录）；
 *   - 文件只有文本内容：把文本写盘；
 *   - 二进制占位（前端读不出内容）且没有来源路径：存不了，跳过。
 * 单个失败不抛、不影响其它：失败的附件按原样走老流程。返回落盘成功的个数。
 */
export async function persistAttachments(
  attachments: Attachment[],
  opts: { sessionId?: string; dir?: string } = {},
): Promise<number> {
  if (!attachments.length) return 0;
  let dir: string;
  try {
    dir = sessionDir(opts.sessionId, opts.dir);
    await mkdir(dir, { recursive: true });
  } catch {
    return 0;
  }

  const rootPrefix = path.resolve(attachmentRoot(opts.dir)).toLowerCase() + path.sep;
  let saved = 0;
  for (const a of attachments) {
    try {
      // 已经指向我们的落盘目录（编辑重发等场景）就不重复处理（兼容 Windows 路径分隔符与大小写）
      if (a.localPath && path.resolve(a.localPath).toLowerCase().startsWith(rootPrefix)) { saved++; continue; }
      const dest = await persistOne(a, dir);
      if (!dest) continue;
      a.localPath = dest;
      saved++;
    } catch { /* 单个失败不影响其它 */ }
  }
  return saved;
}

async function persistOne(a: Attachment, dir: string): Promise<string | null> {
  if (a.kind === 'image' && a.content.startsWith('data:')) {
    const parsed = parseImageDataUrl(a.content);
    if (!parsed) return null;
    const bytes = parsed.bytes;
    // 扩展名一律按真实 MIME 定（原名可能没有扩展名，或是 SVG 转成的 PNG）
    const ext = IMAGE_EXT[parsed.mime] ?? 'png';
    return await writeDedup(dir, a.name, ext, bytes);
  }
  if (a.kind !== 'file') return null;

  // IDE 右键引用的工作区文件/文件夹/代码片段（name 带路径分隔符或 :起止行号，且没有 localPath）：
  // 它们本身就是工作区路径，绝不能写进 attachments 副本导致模型改错文件。
  if (!a.localPath && (/[\\/]/.test(a.name) || /:\d+(-\d+)?$/.test(a.name))) return null;

  // 文件带本机来源路径：拷贝原件（保留原始字节，不依赖来源目录存活）
  if (a.localPath) {
    const st = await stat(a.localPath).catch(() => null);
    if (st?.isFile() && st.size <= MAX_COPY_BYTES) {
      const bytes = await readFile(a.localPath);
      const ext = path.extname(a.name || a.localPath);
      return await writeDedup(dir, a.name, ext.replace(/^\./, '') || 'bin', bytes);
    }
    return null;
  }
  // 只有文本内容：写文本。二进制占位（前端读不出内容）没法落盘，跳过。
  if (a.content && !a.content.startsWith('[二进制文件') && !a.content.startsWith('data:')) {
    return await writeDedup(dir, a.name, (a.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? 'txt'), Buffer.from(a.content, 'utf8'));
  }
  return null;
}

/** 内容哈希做文件名前缀：同一份附件重发不重复写。返回最终路径。 */
async function writeDedup(dir: string, originalName: string, ext: string, bytes: Buffer): Promise<string> {
  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 12);
  const base = safeName(originalName).replace(/\.[^.]*$/, '');
  const file = path.join(dir, `${hash}-${base}${ext ? `.${ext}` : ''}`);
  try {
    await access(file); // 已存在就不重写（避免 readFile 把大文件整份读进内存）
  } catch {
    await writeFile(file, bytes, { mode: 0o600 });
  }
  return file;
}
