import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import type { PawPlugin, ToolSchema } from '@paw/kernel';
import { BG_TOOL_SCHEMAS, buildShellEnv, executeBgTool, killProcessTree, startBackgroundJob } from '../tools/background.js';
import { getWorkspaceRoot } from '../workspace.js';
import type { ServerToolExecCtx } from './types.js';

/** 跑前台命令：独立进程组 + 整组杀，避免停止后孙进程残留成孤儿 */
function runShell(cmd: string, opts: {
  cwd: string;
  timeout: number;
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      shell: true, cwd: opts.cwd, env: buildShellEnv(),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      killProcessTree(child.pid, sig);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const finishWithCode = (code: number | null) => settle(() => {
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
        return;
      }
      // 非零退出时必须同时保留 stdout 与 stderr：原先 `err || out` 在 stderr 有一行告警时会把整段 stdout 探测结果丢光
      const combined = [out.trim(), err.trim() ? `[stderr]\n${err.trim()}` : ''].filter(Boolean).join('\n');
      const trimmed = combined.length > 6000
        ? combined.slice(0, 4500) + '\n…[中间省略]…\n' + combined.slice(-1500)
        : combined;
      reject(new Error((trimmed ? trimmed + '\n' : '') + `[退出码 ${code}]`));
    });
    const onAbort = () => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 800);
      settle(() => reject(new Error('命令已被取消')));
    };

    if (opts.signal?.aborted) { onAbort(); return; }
    opts.signal?.addEventListener('abort', onAbort);
    timer = setTimeout(() => {
      killGroup('SIGKILL');
      settle(() => reject(new Error(`命令超时（${opts.timeout}ms）`)));
    }, opts.timeout);

    child.stdout?.on('data', (d: Buffer) => { if (out.length < 4e6) out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { if (err.length < 4e6) err += d.toString(); });
    child.on('error', (e) => settle(() => reject(e)));
    child.on('exit', (code) => {
      exitDrainTimer = setTimeout(() => finishWithCode(code), 200);
      exitDrainTimer.unref?.();
    });
    child.on('close', (code) => finishWithCode(code));
  });
}

export const RUN_COMMAND_SCHEMA: ToolSchema = {
  name: 'run_command',
  description: 'Run a shell command in the current workspace directory. Use only for real shell commands (git/build/test/system). For file discovery or reading use list_dir/search_file/search_content/read_file instead of ls/find/grep/cat. Default timeout 30s (max 300s via timeout_ms). For batch commands >30s (builds, downloads, scans), set background=true and poll with get_terminal_output(wait_seconds); do not put sleep loops in a foreground command. For persistent servers/services (uvicorn, pnpm dev, mock APIs), set daemon=true (survives turn stop; do NOT use nohup ... & in foreground) and stop with kill_job(job_id). Never kill PIDs from `lsof -ti:<port>` without `-sTCP:LISTEN` (it includes client connections and will kill callers!). Multi-line scripts should be written to a file with write_file, not crammed into shell quotes.',
  parameters: {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: 'Shell command to run' },
      background: { type: 'boolean', description: 'Run batch job in background and return job_id immediately (aborted if user stops the turn)' },
      daemon: { type: 'boolean', description: 'Start a persistent background server/service that survives across turns until kill_job(job_id) is called' },
      timeout_ms: { type: 'number', description: 'Foreground timeout in ms (default 30000, max 300000)' },
      summary: { type: 'string', description: '用简体中文简述要执行什么，25字以内' },
    },
    required: ['cmd'],
  },
};

export const shellPlugin: PawPlugin<ServerToolExecCtx> = {
  name: 'shell',
  tools: [
    {
      schema: RUN_COMMAND_SCHEMA,
      meta: { mutating: true, prunable: true },
      execute: async (args, _id, ctx) => {
        const wsRoot = ctx.workspace === undefined ? await getWorkspaceRoot() : ctx.workspace;
        if (args.background === true || args.daemon === true) {
          return startBackgroundJob(String(args.cmd), wsRoot || homedir(), ctx.signal, { daemon: args.daemon === true });
        }
        const timeout = Math.min(300000, Math.max(1000, Number(args.timeout_ms) || 30000));
        const cmdStr = String(args.cmd);
        const { stdout, stderr } = await runShell(cmdStr, {
          timeout, cwd: wsRoot || homedir(), signal: ctx.signal,
        });
        const daemonHint = /\bnohup\b[\s\S]*&/.test(cmdStr)
          ? '\n[提示：常驻服务请优先用 run_command(daemon=true) 启动，便于通过 list_jobs / kill_job 管理且不会被轮次超时误杀]'
          : '';
        return stdout + (stderr ? '\n[stderr]\n' + stderr : '') + daemonHint;
      },
    },
    ...BG_TOOL_SCHEMAS.map((schema) => ({
      schema,
      meta: {
        readOnly: schema.name === 'list_jobs' || schema.name === 'get_terminal_output',
        mutating: schema.name === 'kill_job',
        prunable: schema.name === 'get_terminal_output',
      },
      execute: (args: Record<string, unknown>, _id: string, ctx: ServerToolExecCtx) =>
        executeBgTool(schema.name, args, ctx.signal),
    })),
  ],
};
