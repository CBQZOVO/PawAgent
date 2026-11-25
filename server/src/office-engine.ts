// 本地 Office 预览引擎：spawn / 复用本地 editor_sdk，按需自动下载并生成预览 URL。
//
// 设计取舍：
// - 懒启动（首次 /api/office/* 才 spawn），不拖慢 Paw 启动；
// - 二进制缺失时，非显式覆盖模式下可自动从 PAW_OFFICE_URL 下载到 ~/.paw/office/editor_sdk；
// - 下载或启动失败只返回明确错误，不抛异常、不阻塞主流程。
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PORT = 39177;
export const DEFAULT_OFFICE_DOWNLOAD_URL = 'https://igo-data.oss-cn-hangzhou.aliyuncs.com/editor_sdk';

type DocType = 'doc' | 'sheet' | 'slide' | 'pdf' | 'mind';

/** 与 editor_sdk 的 document-types 表一致（含 doc/docx/xls/xlsx/csv/ppt/pptx/pdf/xmind）。 */
const DOC_TYPE_BY_EXT: Record<string, DocType> = {
  '.doc': 'doc', '.docx': 'doc', '.dot': 'doc', '.dotx': 'doc',
  '.wps': 'doc', '.wpt': 'doc', '.docm': 'doc', '.dotm': 'doc',
  '.xls': 'sheet', '.xlsx': 'sheet', '.csv': 'sheet', '.xlt': 'sheet',
  '.xltx': 'sheet', '.xlsm': 'sheet', '.xltm': 'sheet',
  '.ppt': 'slide', '.pptx': 'slide', '.pps': 'slide', '.pot': 'slide',
  '.pptm': 'slide', '.ppsx': 'slide', '.ppsm': 'slide', '.potx': 'slide', '.potm': 'slide',
  '.pdf': 'pdf',
  '.xmind': 'mind',
};

const URL_CONFIG: Record<DocType, {
  params: Record<string, string>;
  readonlyParams?: Record<string, string>;
}> = {
  doc: {
    params: {
      local_edit: '1', client: 'sdk_local', mode: 'edit',
      toolbar: 'show', outline: 'show', statusbar: 'show',
    },
    readonlyParams: { mode: 'readonly', toolbar: 'hide', statusbar: 'hide' },
  },
  sheet: {
    params: { local_edit: '1', client: 'sdk_local_pure', mode: 'edit' },
    readonlyParams: { mode: 'readonly' },
  },
  slide: {
    params: { local_edit: '1', client: 'sdk_local_wb', hideTitlebar: '1' },
    readonlyParams: { client: 'sdk_local_wb_preview' },
  },
  pdf: { params: {} },
  mind: {
    params: { local_edit: '1', client: 'sdk_local_wb', mode: 'edit' },
    readonlyParams: { client: 'sdk_local_wb_preview', mode: 'readonly' },
  },
};

export type OfficeStatus = {
  available: boolean;
  port: number;
  error?: string;
  binary?: string;
};

export function officePort(): number {
  const raw = Number(process.env.PAW_OFFICE_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_PORT;
}

/** 与 paths.ts 的 DATA_DIR 同一约定；测试可用 PAW_DATA_DIR 指到临时目录。 */
export function officeDataDir(): string {
  return process.env.PAW_DATA_DIR
    ? path.resolve(process.env.PAW_DATA_DIR)
    : path.join(os.homedir(), '.paw');
}

export function officeDownloadUrl(): string {
  return process.env.PAW_OFFICE_URL?.trim() || DEFAULT_OFFICE_DOWNLOAD_URL;
}

function hasNonEmptyFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile() && statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** 优先显式覆盖（测试/自定义）；其次仓库或打包目录 office/editor_sdk；最后 ~/.paw/office/editor_sdk。 */
export function resolveOfficeBinary(): string {
  const explicit = process.env.PAW_OFFICE_BIN?.trim();
  if (explicit) return explicit;
  const packaged = path.resolve(HERE, '..', '..', 'office', 'editor_sdk');
  if (process.env.PAW_OFFICE_IGNORE_PACKAGED !== '1' && hasNonEmptyFile(packaged)) return packaged;
  return path.join(officeDataDir(), 'office', 'editor_sdk');
}

/** 流式下载 editor_sdk 到目标路径，写入 .part 后原子重命名并赋 0755 执行权限。 */
export async function downloadOfficeBinary(
  dest: string,
  url: string = officeDownloadUrl(),
): Promise<string> {
  await mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.${process.pid}.part`;
  console.log(`[office] 正在下载引擎：${url} → ${dest}`);
  try {
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const nodeStream = Readable.fromWeb(resp.body as unknown as import('node:stream/web').ReadableStream);
    await pipeline(nodeStream, createWriteStream(part));
    await chmod(part, 0o755);
    await rename(part, dest);
    console.log(`[office] 引擎下载完成：${dest}`);
    return dest;
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined);
    throw new Error(`Office 引擎下载失败（${url}）：${(e as Error).message}`);
  }
}

/** 纯函数：给定绝对路径生成预览 URL；扩展名不支持时抛错（调用方转 400）。 */
export function buildPreviewUrl(
  absPath: string,
  mode: 'edit' | 'readonly' = 'edit',
  port: number = officePort(),
): string {
  const ext = path.extname(absPath).toLowerCase();
  const type = DOC_TYPE_BY_EXT[ext];
  if (!type) throw new Error(`不支持的 Office 文件类型：${ext || '(无扩展名)'}`);

  const cfg = URL_CONFIG[type];
  const typeParams = mode === 'readonly' && cfg.readonlyParams
    ? { ...cfg.params, ...cfg.readonlyParams }
    : cfg.params;
  // globalPadId 是 SDK 识别「同一份本地文档」的稳定身份，不能按 view 随机生成。
  const globalPadId = createHash('md5').update(absPath).digest('hex');
  const params = new URLSearchParams({
    title: path.basename(absPath),
    localFilePath: absPath,
    globalPadId,
    ...typeParams,
  });
  if (type === 'doc') params.set('editorSdkUrl', `http://127.0.0.1:${port}`);

  return `http://127.0.0.1:${port}/static/${type}/pc.html?${params.toString()}`;
}

/** 引擎是否已在给定端口提供静态页；成功即复用，不再 spawn 第二个 230MB 进程。 */
async function probeEngine(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/static/doc/pc.html`, {
      signal: AbortSignal.timeout(1200),
    });
    void r.body?.cancel().catch(() => undefined);
    return r.ok;
  } catch {
    return false;
  }
}

let child: ChildProcess | null = null;
let starting: Promise<OfficeStatus> | null = null;
let last: OfficeStatus = { available: false, port: DEFAULT_PORT };

async function start(): Promise<OfficeStatus> {
  const port = officePort();

  if (await probeEngine(port)) {
    last = { available: true, port, binary: resolveOfficeBinary() };
    return last;
  }

  let binary = resolveOfficeBinary();
  if (!hasNonEmptyFile(binary)) {
    const explicit = Boolean(process.env.PAW_OFFICE_BIN?.trim());
    const autoDownload = process.env.PAW_OFFICE_AUTO_DOWNLOAD !== '0';
    if (explicit || !autoDownload) {
      last = { available: false, port, binary, error: `Office 引擎二进制不存在：${binary}` };
      return last;
    }
    try {
      binary = await downloadOfficeBinary(binary);
    } catch (e) {
      last = { available: false, port, binary, error: (e as Error).message };
      return last;
    }
  }

  const dataDir = officeDataDir();
  const tmpDir = path.join(dataDir, 'office-tmp');
  const logDir = path.join(dataDir, 'office-logs');
  const logFile = path.join(dataDir, 'office.log');
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  let log: ReturnType<typeof createWriteStream> | undefined;
  try { log = createWriteStream(logFile, { flags: 'a' }); }
  catch { log = undefined; } // 日志失败不影响引擎

  last = { available: false, port, binary };
  let proc: ChildProcess;
  try {
    proc = spawn(binary, [
      `--port=${port}`,
      '--no_auth',
      `--tmp_dir=${tmpDir}`,
      `--log_dir=${logDir}`,
    ], {
      cwd: path.dirname(binary),
      stdio: ['ignore', log ? 'pipe' : 'ignore', log ? 'pipe' : 'ignore'],
    });
  } catch (e) {
    log?.end();
    last = { available: false, port, binary, error: `Office 引擎启动失败：${(e as Error).message}` };
    return last;
  }
  child = proc;
  if (log) {
    proc.stdout?.pipe(log);
    proc.stderr?.pipe(log);
  }
  proc.on('error', (e) => {
    if (child === proc) child = null;
    last = { available: false, port, binary, error: `Office 引擎进程错误：${e.message}` };
  });
  proc.on('exit', (code, signal) => {
    if (child === proc) child = null;
    last = { available: false, port, binary, error: `Office 引擎已退出（code=${code}, signal=${signal}）` };
  });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !last.error) {
    if (await probeEngine(port)) {
      last = { available: true, port, binary };
      console.log(`[office] 引擎就绪 port=${port}`);
      return last;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return last.error
    ? last
    : { ...last, error: `Office 引擎启动超时（端口 ${port} 未就绪，详见 ${logFile}）` };
}

/**
 * 每次调用都先探测实际端口，再用缓存的启动承诺并发复用。
 * 不能因为 `last.available` 就直接返回：引擎可能被外部杀掉或自行退出，
 * 过期状态会让前端拿到一个打不开的 iframe。
 */
export async function getOfficeStatus(): Promise<OfficeStatus> {
  const port = officePort();
  if (await probeEngine(port)) {
    last = { available: true, port, binary: resolveOfficeBinary() };
    return last;
  }
  if (!starting) starting = start().finally(() => { starting = null; });
  return starting;
}
