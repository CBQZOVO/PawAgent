// 只读文件系统工具：list_dir / search_file / search_content。
// 目的：给只读子代理（code-explorer）真正的探查能力，同时不开 run_command——
// Paw 没有沙箱，工具白名单是唯一的安全边界。
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolSchema } from '@paw/shared';
import { resolveToolPath } from '../workspace.js';

// 跳过的大目录/产物目录（探查它们只会浪费轮次）
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '__pycache__', '.venv', 'venv', 'target', '.idea', '.gradle', 'out']);
// 常见二进制后缀：search_content 直接跳过，免去无效的 stat + readFile 系统调用
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tif', '.tiff', '.icns',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.ogg', '.mov', '.avi', '.mkv',
  '.wasm', '.pyc', '.pyo', '.class', '.jar', '.so', '.dylib', '.dll', '.exe', '.bin',
  '.db', '.sqlite', '.sqlite3',
]);
const MAX_ENTRIES = 500;      // list_dir 条目上限
const MAX_FILES = 20000;      // search_file / search_content 遍历文件上限
const MAX_HITS = 200;         // search_content 命中上限
const MAX_LINE_LEN = 400;     // 命中行截断
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 目录递归搜索跳过 >2MB 的大产物文件
const MAX_SINGLE_FILE_BYTES = 64 * 1024 * 1024; // 显式指定单文件（如 .log/.txt）放宽至 64MB
const SEARCH_CONCURRENCY = 16;

export const FS_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'list_dir',
    description: 'List directory contents (read-only). Returns entries with type and size. Skips node_modules/.git etc. Absolute path, or relative to workspace root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (absolute, or relative to workspace root)' },
        summary: { type: 'string', description: '用简体中文简述本次调用的目的，20字以内' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_file',
    description: 'Find files by glob pattern (read-only), e.g. "**/*.tsx" or "src/**/use*.ts". Returns absolute file paths. Skips node_modules/.git etc.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern. ** matches any depth; * matches within one path segment; ? matches one char' },
        path: { type: 'string', description: 'Root directory to search (absolute, or relative to workspace root). Defaults to workspace root' },
        summary: { type: 'string', description: '用简体中文简述本次调用的目的，20字以内' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'search_content',
    description: 'Search file contents by regex (read-only). Supports directories (skips >2MB/binary) and explicit single log/text files up to 64MB. Set context_lines (1-10) to include surrounding lines (like grep -C) so stacktraces/logs need no extra read_file.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression, e.g. "useSessions|mergeSessions"' },
        path: { type: 'string', description: 'Root directory or single file to search (absolute, or relative to workspace root). Defaults to workspace root' },
        glob: { type: 'string', description: 'Optional filename glob filter, e.g. "*.ts"' },
        case_sensitive: { type: 'boolean', description: 'Default false (case-insensitive)' },
        context_lines: { type: 'number', description: 'Optional number of lines before and after each match (0-10, default 0)' },
        summary: { type: 'string', description: '用简体中文简述本次调用的目的，20字以内' },
      },
      required: ['pattern'],
    },
  },
];

/** glob → RegExp（** 跨层级，* 单层，? 单字符） */
function globToRegex(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // **/ 允许匹配零层目录
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

/** 深度优先遍历文件（跳过 SKIP_DIRS），带总量上限。返回绝对路径。 */
async function* walkFiles(root: string, budget: { left: number }, signal?: AbortSignal): AsyncGenerator<string> {
  if (signal?.aborted) return;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (budget.left <= 0 || signal?.aborted) return;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      yield* walkFiles(full, budget, signal);
    } else if (e.isFile()) {
      budget.left--;
      yield full;
    }
  }
}

async function listDir(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const slice = entries.slice(0, MAX_ENTRIES);
  const lines = await Promise.all(slice.map(async (e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return `${full}/`;
    try { return `${full} (${(await stat(full)).size}B)`; } catch { return full; }
  }));
  if (entries.length > MAX_ENTRIES) lines.push(`… 共 ${entries.length} 项，只显示前 ${MAX_ENTRIES} 项`);
  return lines.length ? lines.join('\n') : '（空目录）';
}

async function searchFile(pattern: string, root: string, signal?: AbortSignal): Promise<string> {
  const re = globToRegex(pattern);
  const hits: string[] = [];
  for await (const file of walkFiles(root, { left: MAX_FILES }, signal)) {
    if (signal?.aborted) throw new Error('搜索已取消');
    // 同时匹配相对路径（常规 glob 语义）和文件名（宽松兜底）
    const rel = path.relative(root, file);
    if (re.test(rel) || re.test(path.basename(file))) hits.push(file);
    if (hits.length >= MAX_HITS) break;
  }
  if (!hits.length) return '没有匹配的文件（换个模式或放宽范围再试）';
  return hits.join('\n') + (hits.length >= MAX_HITS ? `\n… 命中超过 ${MAX_HITS} 条，已截断` : '');
}

async function searchContent(
  pattern: string,
  root: string,
  glob?: string,
  caseSensitive?: boolean,
  contextLines = 0,
  signal?: AbortSignal,
): Promise<string> {
  let re: RegExp;
  try { re = new RegExp(pattern, caseSensitive ? '' : 'i'); }
  catch (e) { return `正则无效: ${(e as Error).message}`; }
  const ctxLines = Math.min(10, Math.max(0, Math.floor(contextLines || 0)));
  const globRe = glob ? globToRegex(glob) : null;
  const hits: string[] = [];
  let matchCount = 0;
  let scanned = 0;

  const st = await stat(root).catch(() => null);
  if (!st) return `路径不存在：${root}`;
  const singleFile = st.isFile();
  if (singleFile && st.size > MAX_SINGLE_FILE_BYTES) {
    return `文件大小 ${(st.size / 1024 / 1024).toFixed(1)}MB 超过 search_content 单文件上限（64MB），请改用 run_command 的 grep -n / awk 分段过滤`;
  }
  const byteCap = singleFile ? MAX_SINGLE_FILE_BYTES : MAX_FILE_BYTES;
  const candidates: string[] = [];
  if (singleFile) {
    candidates.push(root);
  } else {
    for await (const file of walkFiles(root, { left: MAX_FILES }, signal)) {
      if (signal?.aborted) throw new Error('搜索已取消');
      if (BINARY_EXTS.has(path.extname(file).toLowerCase())) continue;
      if (globRe && !globRe.test(path.relative(root, file)) && !globRe.test(path.basename(file))) continue;
      candidates.push(file);
    }
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(SEARCH_CONCURRENCY, candidates.length) }, async () => {
    while (cursor < candidates.length && matchCount < MAX_HITS && !signal?.aborted) {
      const file = candidates[cursor++];
      try {
        const s = await stat(file);
        if (s.size > byteCap) continue;
        const text = await readFile(file, 'utf-8');
        if (text.includes('\u0000')) {
          if (singleFile) {
            hits.push(`该文件包含二进制数据（${file}），无法按文本正则搜索`);
          }
          continue;
        }
        scanned++;
        const lines = text.split('\n');
        if (ctxLines === 0) {
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              if (matchCount < MAX_HITS) {
                hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, MAX_LINE_LEN)}`);
                matchCount++;
              }
              if (matchCount >= MAX_HITS) break;
            }
          }
        } else {
          const matchedIdx: number[] = [];
          for (let i = 0; i < lines.length && matchCount < MAX_HITS; i++) {
            if (re.test(lines[i])) {
              matchedIdx.push(i);
              matchCount++;
            }
          }
          if (matchedIdx.length) {
            const matchedSet = new Set(matchedIdx);
            const ranges: Array<[number, number]> = [];
            for (const idx of matchedIdx) {
              const rs = Math.max(0, idx - ctxLines);
              const reEnd = Math.min(lines.length - 1, idx + ctxLines);
              const prev = ranges[ranges.length - 1];
              if (prev && rs <= prev[1] + 1) prev[1] = Math.max(prev[1], reEnd);
              else ranges.push([rs, reEnd]);
            }
            const blocks: string[] = [];
            for (const [rs, reEnd] of ranges) {
              const blockLines: string[] = [];
              for (let ln = rs; ln <= reEnd; ln++) {
                const sep = matchedSet.has(ln) ? ':' : '-';
                blockLines.push(`${file}${sep}${ln + 1}${sep} ${lines[ln].slice(0, MAX_LINE_LEN)}`);
              }
              blocks.push(blockLines.join('\n'));
            }
            hits.push(blocks.join('\n--\n'));
          }
        }
      } catch { /* 读不了就跳过 */ }
    }
  });
  await Promise.all(workers);
  if (signal?.aborted) throw new Error('搜索已取消');
  if (!hits.length) return `没有命中（扫描了 ${scanned} 个文件）。换个正则/放宽 glob 再试`;
  return hits.join('\n') + (matchCount >= MAX_HITS ? `\n… 命中超过 ${MAX_HITS} 条，已截断（缩小范围）` : '');
}

/** 三个只读工具的统一入口。root 由调用方固定（一次运行内不漂移）。 */
export async function executeFsTool(name: string, args: Record<string, unknown>, root?: string | null, signal?: AbortSignal): Promise<string> {
  if (name === 'list_dir') {
    return listDir(await resolveToolPath(String(args.path || '.'), root));
  }
  if (name === 'search_file') {
    const rootDir = await resolveToolPath(String(args.path || '.'), root);
    return searchFile(String(args.pattern), rootDir, signal);
  }
  if (name === 'search_content') {
    const rootDir = await resolveToolPath(String(args.path || '.'), root);
    return searchContent(
      String(args.pattern),
      rootDir,
      typeof args.glob === 'string' ? args.glob : undefined,
      args.case_sensitive === true,
      typeof args.context_lines === 'number' ? args.context_lines : 0,
      signal,
    );
  }
  throw new Error(`Unknown fs tool: ${name}`);
}

export const FS_TOOL_NAMES = new Set(['list_dir', 'search_file', 'search_content']);
