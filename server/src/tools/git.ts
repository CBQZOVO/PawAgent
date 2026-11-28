// Git 快捷工具：status / diff / log 只读，commit / branch / stash 做常规操作。
// 对标 Qoder/dsh 的工程操作——Agent 改代码前后高频看状态/差异/落提交，
// 专用工具比 run_command 拼 git 命令更稳（固定参数、限制输出、参数转义）。
// 注意：不做 push（对外动作先问用户），也不做 reset --hard 这类破坏性操作。
import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ToolSchema } from '@paw/shared';
import { getWorkspaceRoot, resolveToolPath } from '../workspace.js';
import { buildShellEnv } from './background.js';

const execAsync = promisify(exec);
const MAX_OUT = 60000; // 输出上限（diff 可能很大）

export const GIT_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'git_status',
    description: 'Show git working tree status of the current workspace: branch, ahead/behind, staged/modified/untracked files (short format). Read-only.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional repo path (absolute). Defaults to workspace root' },
        summary: { type: 'string', description: '用简体中文简述目的，20字以内' },
      },
    },
  },
  {
    name: 'git_diff',
    description: 'Show git diff of the current workspace (read-only). Default: unstaged changes. staged=true for index diff; commit="HEAD~1" to compare commits; file to limit to one path. Output truncated at 60KB.',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged (index) diff instead of working tree' },
        commit: { type: 'string', description: 'Optional commit/range to diff against, e.g. "HEAD~1" or "main..feature"' },
        file: { type: 'string', description: 'Optional file path to limit the diff' },
        path: { type: 'string', description: 'Optional repo path (absolute). Defaults to workspace root' },
        summary: { type: 'string', description: '用简体中文简述目的，20字以内' },
      },
    },
  },
  {
    name: 'git_log',
    description: 'Show recent git commits of the current workspace (read-only): hash, date, author, subject. Default 10, max 50.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of commits (default 10, max 50)' },
        file: { type: 'string', description: 'Optional file path to show its history' },
        path: { type: 'string', description: 'Optional repo path (absolute). Defaults to workspace root' },
        summary: { type: 'string', description: '用简体中文简述目的，20字以内' },
      },
    },
  },
  {
    name: 'git_commit',
    description: 'Create a commit. Stages first (default: all tracked changes via `git add -u`; pass `files` to pick specific paths, or all=true to include untracked). Does NOT push. Call git_status/git_diff before committing so you know what goes in.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message (required). One concise summary line; blank line + body for details.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional paths to stage and commit (relative to repo or absolute)' },
        all: { type: 'boolean', description: 'Stage everything including untracked files (`git add -A`). Only when the user explicitly wants all of it.' },
        path: { type: 'string', description: 'Optional repo path (absolute). Defaults to workspace root' },
        summary: { type: 'string', description: '用简体中文简述目的，20字以内' },
      },
      required: ['message'],
    },
  },
  {
    name: 'git_branch',
    description: 'List, create, switch or delete local branches. Branch operations only — never rewrites commits.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'switch', 'delete'], description: 'list (default) | create / switch / delete need `name`' },
        name: { type: 'string', description: 'Branch name for create / switch / delete' },
        path: { type: 'string', description: 'Optional repo path (absolute). Defaults to workspace root' },
        summary: { type: 'string', description: '用简体中文简述目的，20字以内' },
      },
    },
  },
  {
    name: 'git_stash',
    description: 'Save or restore uncommitted changes: push (default) cleans the tree, pop restores, list shows entries, drop removes the latest. Handy before switching branches with uncommitted work.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['push', 'pop', 'list', 'drop'], description: 'push (default) | pop | list | drop' },
        message: { type: 'string', description: 'Optional stash message for push' },
        path: { type: 'string', description: 'Optional repo path (absolute). Defaults to workspace root' },
        summary: { type: 'string', description: '用简体中文简述目的，20字以内' },
      },
    },
  },
];

export const GIT_TOOL_NAMES = new Set(['git_status', 'git_diff', 'git_log', 'git_commit', 'git_branch', 'git_stash']);

/** 只允许安全的 git 子命令参数：拒绝 shell 元字符，file 参数单独转义 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function findChildGitRepos(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const subs: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (existsSync(path.join(dir, e.name, '.git'))) subs.push(e.name);
      if (subs.length >= 12) break;
    }
    return subs;
  } catch {
    return [];
  }
}

/** 微服务多仓库工作区适配：若工作区根目录自身无 .git，但传入的 file/files 落在子 Git 仓库内，自动切到该子仓库执行 */
function resolveGitTarget(
  baseCwd: string,
  explicitPath: boolean,
  args: Record<string, unknown>,
): { cwd: string; file?: string; files?: string[] } {
  const rawFile = typeof args.file === 'string' && args.file.trim() ? args.file.trim() : undefined;
  const rawFiles = Array.isArray(args.files) ? args.files.map(String).filter(Boolean) : undefined;
  if (explicitPath || existsSync(path.join(baseCwd, '.git'))) {
    return { cwd: baseCwd, file: rawFile, files: rawFiles };
  }
  const probe = rawFile ?? rawFiles?.[0];
  if (!probe) return { cwd: baseCwd, file: rawFile, files: rawFiles };
  const absProbe = path.resolve(baseCwd, probe);
  let cur = absProbe;
  const rootResolved = path.resolve(baseCwd);
  const rootPrefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  while (cur.startsWith(rootPrefix)) {
    if (existsSync(path.join(cur, '.git'))) {
      const toRel = (p: string) => path.relative(cur, path.resolve(baseCwd, p)) || '.';
      return {
        cwd: cur,
        file: rawFile ? toRel(rawFile) : undefined,
        files: rawFiles ? rawFiles.map(toRel) : undefined,
      };
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { cwd: baseCwd, file: rawFile, files: rawFiles };
}

async function runGit(cmd: string, cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd, env: buildShellEnv(), timeout: 15000, maxBuffer: 4e6, signal });
    const out = (stdout + (stderr ? '\n' + stderr : '')).trim();
    return out.length > MAX_OUT ? out.slice(0, MAX_OUT) + '\n…[输出过长已截断]' : out || '（无输出）';
  } catch (e) {
    const err = e as Error & { stderr?: string; stdout?: string };
    const msg = (err.stderr || err.message || '').trim();
    // git diff --cached 在非 git 目录会退化为 --no-index 并报 unknown option `cached'，一并归类为非 git 仓库
    if (/not a git repository|unknown option [`']cached['`]/i.test(msg)) {
      const subRepos = await findChildGitRepos(cwd);
      if (subRepos.length) {
        throw new Error(`当前目录（${cwd}）不是 Git 仓库，但发现以下子目录是独立 Git 仓库：${subRepos.join('、')}。请通过 path 参数传入具体子仓库路径。`);
      }
      throw new Error(`当前目录（${cwd}）不是 git 仓库（无需重复尝试 git 工具，请改用 read_file / list_dir / search_content 查看文件）`);
    }
    throw new Error(msg.slice(0, 500));
  }
}

export async function executeGitTool(name: string, args: Record<string, unknown>, workspace?: string | null, signal?: AbortSignal): Promise<string> {
  const hasExplicitPath = typeof args.path === 'string' && !!args.path.trim();
  const baseCwd = hasExplicitPath
    ? await resolveToolPath(String(args.path).trim(), workspace)
    : (workspace === undefined ? await getWorkspaceRoot() : workspace) || process.cwd();
  const resolved = resolveGitTarget(baseCwd, hasExplicitPath, args);
  const cwd = resolved.cwd;
  const file = resolved.file ? ` -- ${shellQuote(resolved.file)}` : '';
  if (name === 'git_status') {
    return runGit('git status --short --branch', cwd, signal);
  }
  if (name === 'git_diff') {
    const staged = args.staged === true ? ' --cached' : '';
    const commit = typeof args.commit === 'string' && args.commit ? ` ${shellQuote(args.commit)}` : '';
    if (/^[;&|`$]/.test(String(args.commit || ''))) throw new Error('commit 参数含非法字符');
    return runGit(`git diff${staged}${commit}${file}`, cwd, signal);
  }
  if (name === 'git_log') {
    const count = Math.min(50, Math.max(1, Number(args.count) || 10));
    return runGit(`git log -${count} --format='%h %ad %an %s' --date=short${file}`, cwd, signal);
  }
  if (name === 'git_commit') {
    const message = String(args.message ?? '').trim();
    if (!message) throw new Error('git_commit 需要非空的 message');
    const files = resolved.files ?? [];
    if (files.length) await runGit(`git add -- ${files.map(shellQuote).join(' ')}`, cwd, signal);
    else if (args.all === true) await runGit('git add -A', cwd, signal);
    // 默认只 stage 已跟踪文件的改动：避免把 .env、node_modules 里的新东西卷进去
    else await runGit('git add -u', cwd, signal);
    const staged = await runGit('git diff --cached --name-only', cwd, signal);
    if (staged === '（无输出）') throw new Error('暂存区是空的，没有可提交的改动（新文件请用 files 或 all=true 显式指定）');
    return runGit(`git commit -m ${shellQuote(message)}`, cwd, signal);
  }
  if (name === 'git_branch') {
    const action = String(args.action || 'list');
    const bname = String(args.name ?? '').trim();
    if (action === 'list') return runGit('git branch -vv', cwd, signal);
    if (!bname) throw new Error(`git_branch ${action} 需要 name`);
    if (/^[;&|`$]/.test(bname)) throw new Error('分支名含非法字符');
    if (action === 'create') { await runGit(`git branch ${shellQuote(bname)}`, cwd, signal); return `已创建分支 ${bname}（未切换）`; }
    // 用 checkout 而不是 switch：兼容老版本 git
    if (action === 'switch') return runGit(`git checkout ${shellQuote(bname)}`, cwd, signal);
    if (action === 'delete') return runGit(`git branch -d ${shellQuote(bname)}`, cwd, signal);
    throw new Error(`未知分支操作: ${action}`);
  }
  if (name === 'git_stash') {
    const action = String(args.action || 'push');
    const msg = String(args.message ?? '').trim();
    if (action === 'list') return runGit('git stash list', cwd, signal);
    if (action === 'push') return runGit(msg ? `git stash push -m ${shellQuote(msg)}` : 'git stash push', cwd, signal);
    if (action === 'pop') return runGit('git stash pop', cwd, signal);
    if (action === 'drop') return runGit('git stash drop', cwd, signal);
    throw new Error(`未知 stash 操作: ${action}`);
  }
  throw new Error(`Unknown git tool: ${name}`);
}