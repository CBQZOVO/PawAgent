// 文件写入/编辑/删除工具：write_file / edit_file / delete_file。
// 对标 CodeBuddy 的 write_to_file / replace_in_file / delete_file——
// 让 Agent 改代码不用整文件重写（省 token、少出错），删除走废纸篓可恢复。
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ToolSchema } from '@paw/shared';
import { resolveToolPath } from '../workspace.js';

const MAX_EDIT_BYTES = 5 * 1024 * 1024; // 超过 5MB 不做文本编辑（多半是数据/产物）

export const EDIT_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'write_file',
    description: 'Create a new file or fully overwrite an existing one. Parent directories are created automatically. For small changes to an existing file prefer edit_file (cheaper and safer). Absolute path, or relative to workspace root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to workspace root)' },
        content: { type: 'string', description: 'Full file content to write' },
        summary: { type: 'string', description: '用简体中文简述要写什么文件，20字以内' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Surgical find-and-replace edit on an existing file. old_string must match EXACTLY (including whitespace/indentation) and be unique unless replace_all=true. Returns a short diff-style confirmation. Prefer this over write_file for modifying existing files. If old_string is not found, re-read the current file region and copy the exact text; do not retry the same old_string.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to workspace root)' },
        old_string: { type: 'string', description: 'Exact text to replace (copy from read_file output, keep indentation)' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false; then old_string must be unique)' },
        summary: { type: 'string', description: '用简体中文简述本次修改，20字以内' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file safely: it is moved to a trash folder (~/.paw-trash) instead of being destroyed, so it can be restored. Refuses directories. Absolute path, or relative to workspace root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to delete (absolute, or relative to workspace root)' },
        summary: { type: 'string', description: '用简体中文简述要删什么，20字以内' },
      },
      required: ['path'],
    },
  },
];

export const EDIT_TOOL_NAMES = new Set(['write_file', 'edit_file', 'delete_file']);

/** 简易 diff 摘要：给出改动位置行号 + 前后各 1 行上下文，模型/用户一眼看懂改了哪 */
function editSummary(text: string, oldStr: string, newStr: string, count: number): string {
  const idx = text.indexOf(oldStr);
  const line = text.slice(0, idx).split('\n').length;
  const removed = oldStr.split('\n').length;
  const added = newStr.split('\n').length;
  return `已替换 ${count} 处（第 ${line} 行起，-${removed} 行 / +${added} 行）`;
}

async function writeFileTool(p: string, content: string): Promise<string> {
  await mkdir(path.dirname(p), { recursive: true });
  let existed = false;
  let oldBytes = 0;
  try { const s = await stat(p); existed = true; oldBytes = s.size; } catch { /* 新文件 */ }
  await writeFile(p, content, 'utf-8');
  const bytes = Buffer.byteLength(content, 'utf-8');
  return existed
    ? `已覆写 ${p}（${oldBytes}B → ${bytes}B，${content.split('\n').length} 行）`
    : `已创建 ${p}（${bytes}B，${content.split('\n').length} 行）`;
}

async function editFileTool(p: string, oldStr: string, newStr: string, replaceAll: boolean): Promise<string> {
  if (oldStr === newStr) throw new Error('old_string 和 new_string 相同，无需修改');
  const s = await stat(p).catch(() => null);
  if (!s) throw new Error(`文件不存在: ${p}（新建文件请用 write_file）`);
  if (s.size > MAX_EDIT_BYTES) throw new Error('文件超过 5MB，不做文本编辑');
  const text = await readFile(p, 'utf-8');
  // 兼容 CRLF 文件：模型 JSON 参数总是输出 \n，若原文件使用 \r\n 且精确匹配未命中，自动对齐换行符并保持文件原有行尾格式
  let targetOld = oldStr;
  let targetNew = newStr;
  let count = text.split(targetOld).length - 1;
  if (count === 0 && text.includes('\r\n') && !oldStr.includes('\r\n')) {
    const crlfOld = oldStr.replace(/\n/g, '\r\n');
    const crlfCount = text.split(crlfOld).length - 1;
    if (crlfCount > 0) {
      targetOld = crlfOld;
      targetNew = newStr.replace(/\r?\n/g, '\r\n');
      count = crlfCount;
    }
  }
  if (count === 0) {
    throw new Error('old_string 在文件里找不到。请先 read_file 拿到最新内容，逐字符复制（含缩进/空白）再试');
  }
  if (count > 1 && !replaceAll) {
    throw new Error(`old_string 出现 ${count} 次，不唯一。加更多上下文让它唯一，或设 replace_all=true`);
  }
  const next = replaceAll ? text.split(targetOld).join(targetNew) : text.replace(targetOld, targetNew);
  const summary = editSummary(text, targetOld, targetNew, replaceAll ? count : 1);
  await writeFile(p, next, 'utf-8');
  return `${p}: ${summary}`;
}

/** 删除 = 移进 ~/.paw-trash（保留原目录结构 + 时间戳防重名），可人工恢复 */
async function deleteFileTool(p: string): Promise<string> {
  const s = await stat(p).catch(() => null);
  if (!s) throw new Error(`文件不存在: ${p}`);
  if (s.isDirectory()) throw new Error('delete_file 只删文件，不删目录（目录请用 run_command 谨慎处理）');
  const trashRoot = path.join(os.homedir(), '.paw-trash');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // 绝对路径去掉开头 /，保留目录层级，恢复时知道它原来在哪
  const rel = p.replace(/^\//, '');
  const dest = path.join(trashRoot, stamp, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(p, dest);
  return `已删除 ${p}（移入废纸篓 ${dest}，可恢复）`;
}

export async function executeEditTool(name: string, args: Record<string, unknown>, root?: string | null): Promise<string> {
  // 必填参数缺失直接报错。不能兜底成空串：write_file 缺 content 会把已有文件清空、
  // edit_file 缺 old_string 配 replace_all 会把 new_string 插进每个字符之间——
  // 而且都回「成功」，模型以为改好了（假成功最难纠正）。
  if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('缺少 path 参数：请传入要操作的文件路径（绝对路径，或相对工作区根目录）');
  const p = await resolveToolPath(args.path, root);
  if (name === 'write_file') {
    if (typeof args.content !== 'string') throw new Error('缺少 content 参数：write_file 需要完整的文件内容。只想改一部分请用 edit_file');
    return writeFileTool(p, args.content);
  }
  if (name === 'edit_file') {
    if (typeof args.old_string !== 'string' || !args.old_string) throw new Error('缺少 old_string 参数：需要被替换的原文，不能为空（先用 read_file 拿到最新内容再逐字符复制）');
    return editFileTool(p, args.old_string, String(args.new_string ?? ''), args.replace_all === true);
  }
  if (name === 'delete_file') return deleteFileTool(p);
  throw new Error(`Unknown edit tool: ${name}`);
}