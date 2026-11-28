// 本地 Office 预览引擎：spawn / 复用腾讯文档 editor_sdk，生成预览 URL。
//
// 设计取舍：
// - 引擎不随安装包分发，固定放在 ~/.paw/office/；
// - 懒启动（首次 /api/office/* 才 spawn），不拖慢 Paw 启动；
// - 二进制缺失只上报 needsDownload，由前端询问用户后走 /api/office/download 显式下载；
// - 下载或启动失败只返回明确错误，不抛异常、不阻塞主流程。
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
  /** 二进制未安装：需用户确认后才下载，绝不自动下载 */
  needsDownload?: boolean;
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
  if (process.env.PAW_OFFICE_URL?.trim()) return process.env.PAW_OFFICE_URL.trim();
  // OSS 上两个平台是两个文件：editor_sdk（mac）和 editor_sdk.exe（Windows）
  return process.platform === 'win32' ? `${DEFAULT_OFFICE_DOWNLOAD_URL}.exe` : DEFAULT_OFFICE_DOWNLOAD_URL;
}

function hasNonEmptyFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile() && statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** editor_sdk 文件名按平台：Windows 为 editor_sdk.exe，macOS 为 editor_sdk */
function editorBinaryName(): string {
  return process.platform === 'win32' ? 'editor_sdk.exe' : 'editor_sdk';
}

/** 优先显式覆盖（测试/自定义）；引擎不随包分发，固定放 ~/.paw/office/。 */
export function resolveOfficeBinary(): string {
  const explicit = process.env.PAW_OFFICE_BIN?.trim();
  if (explicit) return explicit;
  return path.join(officeDataDir(), 'office', editorBinaryName());
}

export type OfficeDownloadProgress = {
  downloading: boolean;
  downloaded: number;
  /** HTTP 没给 Content-Length 时为 null，前端只显示已下载大小 */
  total: number | null;
};

let downloadProgress: OfficeDownloadProgress = { downloading: false, downloaded: 0, total: null };
/** 只读快照，供 /api/office/download/progress 轮询；全过程只有一次下载，不需要按请求区分。 */
export function getOfficeDownloadProgress(): OfficeDownloadProgress {
  return { ...downloadProgress };
}

/** 流式下载 editor_sdk 到目标路径，写入 .part 后原子重命名并赋 0755 执行权限。 */
export async function downloadOfficeBinary(
  dest: string,
  url: string = officeDownloadUrl(),
  timeoutMs: number = 10 * 60 * 1000,
): Promise<string> {
  await mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.${process.pid}.part`;
  console.log(`[office] 正在下载引擎：${url} → ${dest}`);
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const totalHeader = Number(resp.headers.get('content-length'));
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
    downloadProgress = { downloading: true, downloaded: 0, total };
    const nodeStream = Readable.fromWeb(resp.body as unknown as import('node:stream/web').ReadableStream);
    // Transform 只计数不改字节，pipeline 自然保留背压；前端轮询快照即可拿到实时进度。
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        downloadProgress = { ...downloadProgress, downloaded: downloadProgress.downloaded + chunk.length };
        callback(null, chunk);
      },
    });
    await pipeline(nodeStream, counter, createWriteStream(part));
    if (process.platform !== 'win32') await chmod(part, 0o755);
    // Windows Defender 实时扫描刚写完的 230MB .part 时会短暂锁句柄，rename 遇 EPERM/EBUSY/EACCES 退避重试
    for (let i = 0; ; i++) {
      try {
        await rename(part, dest);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (i < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          await new Promise((r) => setTimeout(r, 300 * (i + 1)));
          continue;
        }
        throw err;
      }
    }
    downloadProgress = { downloading: false, downloaded: total ?? downloadProgress.downloaded, total };
    console.log(`[office] 引擎下载完成：${dest}`);
    return dest;
  } catch (e) {
    downloadProgress = { downloading: false, downloaded: 0, total: null };
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
let installing: Promise<OfficeStatus> | null = null;
let last: OfficeStatus = { available: false, port: DEFAULT_PORT };

async function start(): Promise<OfficeStatus> {
  const port = officePort();

  if (await probeEngine(port)) {
    last = { available: true, port, binary: resolveOfficeBinary() };
    return last;
  }

  const binary = resolveOfficeBinary();
  if (!hasNonEmptyFile(binary)) {
    last = {
      available: false, port, binary, needsDownload: true,
      error: `Office 引擎未安装：${binary}`,
    };
    return last;
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
      windowsHide: true,
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

  // Windows 首次运行刚落盘的 230MB .exe 常受 Defender 扫描拖慢，给 20s 上限（每 250ms 探测一次，就绪即返回）
  const deadline = Date.now() + (process.platform === 'win32' ? 20_000 : 12_000);
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

async function probeOrStart(): Promise<OfficeStatus> {
  const port = officePort();
  if (await probeEngine(port)) {
    last = { available: true, port, binary: resolveOfficeBinary() };
    return last;
  }
  if (!starting) starting = start().finally(() => { starting = null; });
  return starting;
}

/**
 * 每次调用都先探测实际端口，再用缓存的启动承诺并发复用。
 * 若用户刚确认下载且正在拉取引擎，直接等待本次安装完成，不再误报 needsDownload 重复弹窗。
 */
export async function getOfficeStatus(): Promise<OfficeStatus> {
  if (installing) return installing;
  return probeOrStart();
}

/**
 * 用户确认后才调用：下载到 ~/.paw/office/ 并启动。
 * 并发请求共用同一次下载，避免重复拉 230MB；已安装时直接走正常启动流程。
 */
export function installOfficeEngine(): Promise<OfficeStatus> {
  if (!installing) {
    installing = (async () => {
      const binary = resolveOfficeBinary();
      if (!hasNonEmptyFile(binary)) {
        try {
          await downloadOfficeBinary(binary);
        } catch (e) {
          return { available: false, port: officePort(), binary, error: (e as Error).message };
        }
      }
      return probeOrStart();
    })().finally(() => { installing = null; });
  }
  return installing;
}
