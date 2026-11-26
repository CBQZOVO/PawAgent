// 后台命令：run_command(background=true) 立即返回 job_id，
// get_terminal_output 轮询输出，kill_job 终止。对标 Qoder Bash 后台 + dsh job_*。
// 解决痛点：pnpm dev / 长测试以前 30s 超时被杀，Agent 没法跑长任务。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ToolSchema } from '@paw/shared';

const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  path.join(homedir(), '.local', 'bin'),
  path.join(homedir(), '.cargo', 'bin'),
];

/** Conda 常见安装位置，按优先级探测 */
const CONDA_BASE_DIRS = [
  path.join(homedir(), 'anaconda3'),
  path.join(homedir(), 'miniconda3'),
  path.join(homedir(), 'miniforge3'),
  '/opt/anaconda3',
  '/opt/miniconda3',
  '/opt/homebrew/anaconda3',
  '/opt/homebrew/Caskroom/miniconda/base',
  '/opt/homebrew/Caskroom/miniforge/base',
  '/usr/local/anaconda3',
  '/usr/local/Caskroom/miniconda/base',
];

/**
 * 找 Conda base：先探常见安装目录，都没有再读 ~/.conda/environments.txt（conda 自己维护的注册表）。
 * 只认磁盘上真实存在的目录，不 spawn conda（那要几百毫秒）。找不到返回 null。
 */
function findCondaBase(): string | null {
  const isWin = process.platform === 'win32';
  const candidates = [...CONDA_BASE_DIRS];
  if (isWin && process.env.LOCALAPPDATA) {
    candidates.push(
      path.join(process.env.LOCALAPPDATA, 'anaconda3'),
      path.join(process.env.LOCALAPPDATA, 'miniconda3'),
      path.join(process.env.LOCALAPPDATA, 'miniforge3'),
    );
  }
  try {
    const txt = readFileSync(path.join(homedir(), '.conda', 'environments.txt'), 'utf-8');
    for (const line of txt.split(/\r?\n/)) {
      const dir = line.trim();
      const isAbs = isWin ? /^[a-zA-Z]:[\\/]/.test(dir) : dir.startsWith('/');
      if (dir && isAbs && !candidates.includes(dir)) candidates.push(dir);
    }
  } catch { /* 没注册表，只靠静态列表 */ }
  for (const dir of candidates) {
    if (isWin) {
      if (existsSync(path.join(dir, 'Scripts', 'conda.exe'))) return dir;
    } else if (existsSync(path.join(dir, 'bin', 'conda'))) {
      return dir;
    }
  }
  return null;
}

export function buildShellEnv(): NodeJS.ProcessEnv {
  const isWin = process.platform === 'win32';
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const raw = process.env[pathKey] || (isWin ? '' : '/usr/bin:/bin:/usr/sbin:/sbin');
  const parts = raw.split(path.delimiter).filter(Boolean);
  const seen = new Set(isWin ? parts.map((p) => p.toLowerCase()) : parts);
  const hasDir = (d: string) => seen.has(isWin ? d.toLowerCase() : d);

  const extraDirs = isWin
    ? [path.join(homedir(), '.local', 'bin'), path.join(homedir(), '.cargo', 'bin')]
    : EXTRA_PATH_DIRS;
  const missing = extraDirs.filter((d) => !hasDir(d) && existsSync(d));
  if (!missing.length && parts.some((d) => /conda|anaconda|miniconda|miniforge/i.test(d))) return process.env;

  let insertAt = 0;
  while (insertAt < parts.length && /venv|conda|nvm|pyenv|fnm|volta/i.test(parts[insertAt])) insertAt++;
  const toInsert: string[] = [...missing];
  const condaBase = findCondaBase();
  if (condaBase) {
    const condaBins = isWin
      ? [condaBase, path.join(condaBase, 'Scripts'), path.join(condaBase, 'Library', 'bin')]
      : [path.join(condaBase, 'bin')];
    for (const b of condaBins.reverse()) {
      if (existsSync(b) && !hasDir(b)) toInsert.unshift(b);
    }
  }
  if (!toInsert.length) return process.env;
  const merged = [...parts.slice(0, insertAt), ...toInsert, ...parts.slice(insertAt)];
  return { ...process.env, [pathKey]: merged.join(path.delimiter) };
}

interface Job {
  id: string;
  cmd: string;
  cwd: string;
  proc: ChildProcess;
  daemon?: boolean;       // 常驻服务：不随单轮对话停止信号被连带杀死
  chunks: string[];       // 输出分片（读取时拼接）
  bytes: number;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  readCursor: number;     // get_terminal_output 增量读取游标（分片下标）
}

const MAX_JOBS = 20;               // 同时保留的 job 上限（超出清理最老的已结束 job）
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 每个 job 输出上限 2MB，超出丢最老的
const jobs = new Map<string, Job>();
let seq = 0;

export const BG_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'get_terminal_output',
    description: 'Read output of a background command started by run_command(background=true). Returns new output since last read plus job status. Wait with wait_seconds (max 30) instead of adding sleep to the command. Do not claim completion until status is exited with a success code; on failure read the error and change approach instead of re-running the same command.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id returned by run_command' },
        wait_seconds: { type: 'number', description: 'Optional: wait up to N seconds (max 30) for new output before returning. Default 0' },
        summary: { type: 'string', description: '用简体中文简述目的，20字以内' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'kill_job',
    description: 'Terminate a background or daemon job started by run_command (SIGTERM, then SIGKILL after 3s). Always prefer kill_job over raw kill/lsof commands so you never kill an unrelated process.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id to kill' },
        summary: { type: 'string', description: '用简体中文简述目的，20字以内' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'list_jobs',
    description: 'List background and daemon command jobs with job_id, PID, status, runtime and command line.',
    parameters: { type: 'object', properties: { summary: { type: 'string', description: '用简体中文简述目的，20字以内' } } },
  },
];

export const BG_TOOL_NAMES = new Set(['get_terminal_output', 'kill_job', 'list_jobs']);

function pushChunk(job: Job, text: string) {
  job.chunks.push(text);
  job.bytes += Buffer.byteLength(text);
  while (job.bytes > MAX_OUTPUT_BYTES && job.chunks.length > 1) {
    job.bytes -= Buffer.byteLength(job.chunks.shift()!);
    if (job.readCursor > 0) job.readCursor--;
  }
}

function evictOldJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const finished = [...jobs.values()].filter((j) => j.status !== 'running')
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  for (const j of finished) {
    if (jobs.size <= MAX_JOBS) break;
    jobs.delete(j.id);
  }
}

/** 启动后台命令。cwd 由调用方固定（工作区）。daemon=true 时不绑单轮 abort，跨轮持续存活。 */
export function startBackgroundJob(
  cmd: string,
  cwd: string,
  signal?: AbortSignal,
  opts?: { daemon?: boolean },
): string {
  evictOldJobs();
  const daemon = opts?.daemon === true;
  const id = `job-${++seq}-${Date.now().toString(36)}`;
  // POSIX 用 detached 当进程组 leader 便于 kill(-pid)；Windows 不开 detached 且设 windowsHide 避免弹黑框
  const proc = spawn(cmd, {
    shell: true, cwd, env: buildShellEnv(),
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const job: Job = {
    id, cmd, cwd, proc, daemon, chunks: [], bytes: 0,
    status: 'running', exitCode: null, startedAt: Date.now(), readCursor: 0,
  };
  proc.stdout?.on('data', (d: Buffer) => pushChunk(job, d.toString()));
  proc.stderr?.on('data', (d: Buffer) => pushChunk(job, '[stderr] ' + d.toString()));
  proc.on('exit', (code) => {
    job.status = job.status === 'killed' ? 'killed' : 'exited';
    job.exitCode = code;
    job.endedAt = Date.now();
  });
  proc.on('error', (e) => {
    pushChunk(job, `[spawn error] ${e.message}`);
    job.status = 'exited'; job.exitCode = -1; job.endedAt = Date.now();
  });
  jobs.set(id, job);
  // 普通批处理后台任务：用户在对话里点停止 → 本轮 signal abort 时跟着终止。
  // 常驻服务（daemon=true）：跨轮提供服务，不随单轮停止被误杀，由 kill_job 或应用退出清理。
  if (signal && !daemon) {
    const onAbort = () => {
      if (job.status !== 'running') return;
      job.status = 'killed';
      killTree(proc, 'SIGTERM');
      setTimeout(() => { if (job.exitCode === null) killTree(proc, 'SIGKILL'); }, 3000).unref();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const pidInfo = proc.pid ? ` (pid=${proc.pid})` : '';
  const modeLabel = daemon ? '常驻服务已启动' : '后台任务已启动';
  return `${modeLabel}: ${id}${pidInfo}\ncmd: ${cmd}\ncwd: ${cwd}\n用 get_terminal_output(job_id="${id}") 查看输出，kill_job(job_id="${id}") 终止。`;
}

function jobHeader(j: Job): string {
  const secs = ((j.endedAt || Date.now()) - j.startedAt) / 1000;
  const pid = j.proc.pid ? ` · pid=${j.proc.pid}` : '';
  const tag = j.daemon ? ' · daemon' : '';
  return `[${j.id}] ${j.status}${j.exitCode !== null ? ` (exit=${j.exitCode})` : ''}${pid}${tag} · ${secs.toFixed(1)}s · ${j.cmd}`;
}

/** 跨平台杀整棵进程树：Windows 走 taskkill /T /F，POSIX 走负 PID 进程组 */
export function killProcessTree(pid: number, sig: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { /* 已退出 */ }
    return;
  }
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* 已退出 */ } }
}

function killTree(proc: ChildProcess, sig: NodeJS.Signals): void {
  if (!proc.pid) return;
  killProcessTree(proc.pid, sig);
}

async function getOutput(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const j = jobs.get(String(args.job_id));
  if (!j) return `没有这个 job（可能已被清理）。用 list_jobs 看现存任务。`;
  const wait = Math.min(30, Math.max(0, Number(args.wait_seconds) || 0));
  if (wait > 0 && j.readCursor >= j.chunks.length && j.status === 'running') {
    const t0 = Date.now();
    while (Date.now() - t0 < wait * 1000 && j.readCursor >= j.chunks.length && j.status === 'running') {
      if (signal?.aborted) return `${jobHeader(j)}\n（等待已被取消）`;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const fresh = j.chunks.slice(j.readCursor).join('');
  j.readCursor = j.chunks.length;
  return `${jobHeader(j)}\n${fresh || '（自上次读取后无新输出）'}`;
}

async function killJob(args: Record<string, unknown>): Promise<string> {
  const j = jobs.get(String(args.job_id));
  if (!j) return `没有这个 job: ${args.job_id}`;
  if (j.status !== 'running') return `${jobHeader(j)}\n任务已结束，无需终止。`;
  j.status = 'killed';
  killTree(j.proc, 'SIGTERM');
  setTimeout(() => { if (j.exitCode === null) killTree(j.proc, 'SIGKILL'); }, 3000).unref();
  return `已发送终止信号: ${jobHeader(j)}`;
}

function listJobs(): string {
  if (!jobs.size) return '（没有后台任务）';
  return [...jobs.values()].map(jobHeader).join('\n');
}

/** 返回当前仍在运行的常驻服务摘要（供会话交接单确定性提取，避免新会话重复起服务撞端口） */
export function getRunningDaemons(): string[] {
  return [...jobs.values()]
    .filter((j) => j.daemon && j.status === 'running')
    .map((j) => `${j.id}${j.proc.pid ? ` (pid=${j.proc.pid})` : ''}: ${j.cmd}`);
}

export async function executeBgTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  if (name === 'get_terminal_output') return getOutput(args, signal);
  if (name === 'kill_job') return killJob(args);
  if (name === 'list_jobs') return listJobs();
  throw new Error(`Unknown bg tool: ${name}`);
}

/** server 退出时清理所有还在跑的后台任务，不留孤儿 */
export function killAllJobs(): void {
  for (const j of jobs.values()) {
    if (j.status === 'running') { j.status = 'killed'; killTree(j.proc, 'SIGKILL'); }
  }
}

/** 前端展示用的 job 快照（不含进程句柄和输出缓冲，可 JSON 序列化） */
export interface BgJobView {
  id: string;
  cmd: string;
  cwd: string;
  daemon: boolean;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}

/** 顶栏「后台任务」徽标的数据源 */
export function jobViews(): BgJobView[] {
  return [...jobs.values()].map((j) => ({
    id: j.id, cmd: j.cmd, cwd: j.cwd, daemon: !!j.daemon,
    status: j.status, exitCode: j.exitCode, startedAt: j.startedAt, endedAt: j.endedAt ?? null,
  }));
}

/** 前端面板的「终止」按钮：和 kill_job 工具同一套逻辑 */
export function killJobById(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.status !== 'running') return false;
  j.status = 'killed';
  killTree(j.proc, 'SIGTERM');
  setTimeout(() => { if (j.exitCode === null) killTree(j.proc, 'SIGKILL'); }, 3000).unref();
  return true;
}