/**
 * 从拖放事件取文件列表。
 * - 拖入**文件夹**：桌面端（Electron 有本机路径）整体作为一个附件，不展开——Agent 拿到
 *   路径后用 list_dir/read_file 自己浏览；纯浏览器端没有路径，退化为递归展开其中的文件。
 * - 拖入**文件**：原样保留原生 File（Electron webUtils.getPathForFile 才能取到本机路径）。
 *
 * 注意：DataTransferItem.webkitGetAsEntry() 与 getAsFile() 必须在 drop 事件回调里同步调用
 * （事件返回后 items 失效），所以本函数第一段同步收集，之后才进入异步遍历。
 */
import { MAX_ATTACHMENTS, dirFiles } from './attachments';

/** 各系统的垃圾文件，无论在哪一层都不要 */
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);
const isJunkFile = (name: string): boolean => JUNK_FILES.has(name);

/** 点开头的**目录**（.git/.m2/.venv…）递归时跳过；**文件**不在此列——.env/.npmrc/.gitignore 恰恰常需要发给 Agent */
const isHiddenDir = (name: string): boolean => name.startsWith('.');

/** 目录遍历跳过常见依赖/构建/版本控制目录，避免把附件配额全占成 node_modules 文件 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '__pycache__', '.venv', 'venv', 'target', '.idea', '.gradle', 'out',
  '.mvn', '.m2', // Maven：wrapper 配置与本地仓库（repository/ 里动辄上万个 jar）
]);

/** 最大递归深度，防止符号链接环或极深目录树无限递归 */
const MAX_WALK_DEPTH = 10;

function fileFromEntry(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file((f) => resolve(f), () => resolve(null)));
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => reader.readEntries((es) => resolve(es), () => resolve([])));
}

async function walkEntry(entry: FileSystemEntry, out: File[], limit: number, depth: number): Promise<void> {
  if (out.length >= limit || depth > MAX_WALK_DEPTH) return;
  if (entry.isFile) {
    if (isJunkFile(entry.name)) return;
    const file = await fileFromEntry(entry as FileSystemFileEntry);
    if (file) out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  if (depth > 0 && (isHiddenDir(entry.name) || SKIP_DIRS.has(entry.name))) return;
  // readEntries 每次最多返回 100 条，必须循环读到空
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    if (out.length >= limit) return;
    const batch = await readEntries(reader);
    if (!batch.length) break;
    for (const child of batch) {
      if (out.length >= limit) return;
      if (child.isDirectory && (isHiddenDir(child.name) || SKIP_DIRS.has(child.name))) continue;
      if (child.isFile && isJunkFile(child.name)) continue;
      await walkEntry(child, out, limit, depth + 1);
    }
  }
}

export function hasDroppedFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes('Files');
}

interface DroppedItem { entry: FileSystemEntry | null; rawFile: File | null }

export async function filesFromDataTransfer(dt: DataTransfer, limit = MAX_ATTACHMENTS): Promise<File[]> {
  const maxFiles = Math.max(1, Math.floor(limit));
  // 同步段：必须在 drop 回调返回前把 entry 与原生 File 全部拿到
  const items: DroppedItem[] = Array.from(dt.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => ({
      entry: typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null,
      rawFile: typeof item.getAsFile === 'function' ? item.getAsFile() : null,
    }));
  if (!items.length) {
    // 无 entry（如某些剪贴板/测试来源）：退回普通文件列表，过滤掉文件夹占位（type 为空且 size 为 0）
    return Array.from(dt.files ?? [])
      .filter((f) => !isJunkFile(f.name) && (f.type !== '' || f.size > 0))
      .slice(0, maxFiles);
  }

  // Node 测试环境没有 window；桌面端 preload 注入 pawDesktop.getPathForFile
  const desktop = typeof window === 'undefined'
    ? undefined
    : (window as unknown as { pawDesktop?: { getPathForFile?: (file: File) => string | undefined } }).pawDesktop;
  const getPath = desktop?.getPathForFile;

  const out: File[] = [];
  for (const { entry, rawFile } of items) {
    if (out.length >= maxFiles) break;
    if (entry?.isDirectory) {
      // 桌面端能拿到文件夹的本机路径 → 整个文件夹作为一个附件，不展开
      if (rawFile && getPath?.(rawFile)) {
        dirFiles.add(rawFile);
        out.push(rawFile);
        continue;
      }
      // 浏览器端没有路径，Agent 读不到文件夹 → 退化为展开其中的文件
      await walkEntry(entry, out, maxFiles, 0);
      continue;
    }
    if (rawFile) {
      if (!isJunkFile(rawFile.name)) out.push(rawFile);
    } else if (entry?.isFile) {
      await walkEntry(entry, out, maxFiles, 0);
    }
  }
  return out;
}
