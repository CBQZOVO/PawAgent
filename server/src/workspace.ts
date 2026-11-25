// 工作区：选中一个目录后，Paw 自动读它的指令文件（AGENTS.md/CLAUDE.md/README.md/.codebuddy/…）
// 注入到 user-context；read_file/run_command 的相对路径基于工作区。
// 配置存 ~/.paw/workspace-config.json（照 web-search 的模式，简单可靠）。
import { open, readFile, unlink, writeFile, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { LEGACY_DIRS, dataFile } from './paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 工作区列表也放 ~/.paw：重装 app 不该让用户重新加一遍目录
const CONFIG_FILE = dataFile('workspace-config.json', LEGACY_DIRS);

// 指令文件候选（按优先级；项目根 + .codebuddy/ 里）
const INSTRUCTION_FILES = [
  'AGENTS.md', 'CLAUDE.md', '.codebuddy/AGENTS.md', '.codebuddy/CLAUDE.md',
  'README.md', '.cursorrules', '.github/copilot-instructions.md',
];
const MAX_FILE_BYTES = 12_000; // 每个文件最多注入 12KB，防止 token 爆炸

let cached: { root: string; mtime: number; block: string } | null = null;

interface WorkspaceConfig {
  root: string | null;
  workspaces: string[];
}

/** 迁移标记：只合并旧配置一次，之后用户主动 remove 的工作区不会被旧文件复活。 */
const MERGED_FILE = dataFile('workspaces-legacy-merged.json', LEGACY_DIRS);

async function readRawConfig(): Promise<WorkspaceConfig> {
  try {
    const d = JSON.parse(await readFile(CONFIG_FILE, 'utf-8')) as { root?: unknown; workspaces?: unknown };
    const root = typeof d.root === 'string' && d.root ? d.root : null;
    const workspaces = Array.isArray(d.workspaces)
      ? [...new Set(d.workspaces.filter((p): p is string => typeof p === 'string' && !!p))]
      : [];
    return { root, workspaces };
  } catch {
    return { root: null, workspaces: [] };
  }
}

/** 跨进程文件锁：开发 server 和桌面 app 共用 ~/.paw 时也不会互相覆盖工作区列表。 */
const LOCK_FILE = `${CONFIG_FILE}.lock`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function acquireConfigLock(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const handle = await open(LOCK_FILE, 'wx');
      await handle.close();
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // 旧进程被强杀会留下锁；超过 15 秒就当死锁清掉。
      try {
        const s = await stat(LOCK_FILE);
        if (Date.now() - s.mtimeMs > 15000) await unlink(LOCK_FILE).catch(() => undefined);
      } catch { /* 锁刚好被别人释放 */ }
      await sleep(30);
    }
  }
  throw new Error('工作区配置被其它 Paw 进程占用，请稍后重试');
}
async function releaseConfigLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => undefined);
}

/** 串行化读改写：同进程排队 + 跨进程文件锁，后来的写入基于最新文件。 */
let writeQueue: Promise<void> = Promise.resolve();
async function withConfigWrite(fn: (cfg: WorkspaceConfig) => Promise<void> | void): Promise<void> {
  const next = writeQueue.then(async () => {
    await acquireConfigLock();
    try {
      const cfg = await readRawConfig();
      await fn(cfg);
    } finally {
      await releaseConfigLock();
    }
  });
  writeQueue = next.catch(() => undefined);
  await next;
}

/** 原子写：先写临时文件再 rename，进程被杀也不会留下半截 JSON。 */
async function saveConfig(cfg: WorkspaceConfig): Promise<void> {
  const tmp = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  await rename(tmp, CONFIG_FILE);
}

/** 一次性合并旧配置：修复“早期 ~/.paw 只有当前目录，旧列表丢失”的事故。 */
async function mergeLegacyOnce(): Promise<void> {
  try { if ((await stat(MERGED_FILE)).isFile()) return; } catch { /* 首次 */ }
  await withConfigWrite(async (cfg) => {
    const union = [...cfg.workspaces];
    for (const dir of LEGACY_DIRS) {
      const legacy = path.join(dir, 'workspace-config.json');
      if (legacy === CONFIG_FILE) continue;
      try {
        const d = JSON.parse(await readFile(legacy, 'utf-8')) as { root?: unknown; workspaces?: unknown };
        const candidates = [
          ...(typeof d.root === 'string' && d.root ? [d.root] : []),
          ...(Array.isArray(d.workspaces) ? d.workspaces : []),
        ];
        for (const p of candidates) {
          if (typeof p === 'string' && p && !union.includes(p)) union.push(p);
        }
      } catch { /* 没有旧配置就跳过 */ }
    }
    cfg.workspaces = union;
    if (cfg.root && !union.includes(cfg.root)) union.push(cfg.root);
    await saveConfig(cfg);
  });
  await writeFile(MERGED_FILE, JSON.stringify({ at: new Date().toISOString() }) + '\n', 'utf-8').catch(() => undefined);
}

async function readWorkspaceConfig(): Promise<WorkspaceConfig> {
  await mergeLegacyOnce();
  return readRawConfig();
}

/** 当前工作区根目录（null=未选） */
export async function getWorkspaceRoot(): Promise<string | null> {
  return (await readWorkspaceConfig()).root;
}

/** 已添加的工作区列表（包含当前项；兼容只有 root 的旧配置） */
export async function listWorkspaces(): Promise<string[]> {
  const cfg = await readWorkspaceConfig();
  return cfg.root && !cfg.workspaces.includes(cfg.root)
    ? [cfg.root, ...cfg.workspaces]
    : cfg.workspaces;
}

/** 设置当前工作区；选中目录会自动加入工作区列表（传 null 只取消当前，不删列表） */
export async function setWorkspaceRoot(root: string | null): Promise<void> {
  await withConfigWrite(async (cfg) => {
    cfg.root = root;
    if (root && !cfg.workspaces.includes(root)) cfg.workspaces.push(root);
    await saveConfig(cfg);
  });
  cached = null;
}

/** 从工作区列表移除（只移除引用，不删除磁盘目录）；移除当前项时自动切到下一个 */
export async function removeWorkspace(root: string): Promise<void> {
  await withConfigWrite(async (cfg) => {
    cfg.workspaces = cfg.workspaces.filter((p) => p !== root);
    if (cfg.root === root) cfg.root = cfg.workspaces[0] ?? null;
    await saveConfig(cfg);
  });
  cached = null;
}

/** 扫描工作区指令文件：返回 mtime 指纹和存在的文件清单（stat 便宜，命中缓存就不读正文） */
async function scanInstructions(root: string): Promise<{ mtime: number; main: string[]; extra: string[] }> {
  const main: string[] = [];
  let mtime = 0;
  for (const rel of INSTRUCTION_FILES) {
    try {
      mtime = Math.max(mtime, (await stat(path.join(root, rel))).mtimeMs);
      main.push(rel);
    } catch { /* 文件不存在就跳过 */ }
  }
  const extra: string[] = [];
  try {
    const dir = path.join(root, '.codebuddy');
    const entries = await readdir(dir, { recursive: true });
    const mds = entries.filter((e) => e.endsWith('.md') && !['AGENTS.md', 'CLAUDE.md'].includes(path.basename(e))).slice(0, 10);
    for (const e of mds) {
      try {
        mtime = Math.max(mtime, (await stat(path.join(dir, e))).mtimeMs);
        extra.push(e);
      } catch { /* skip */ }
    }
  } catch { /* 无 .codebuddy 目录 */ }
  return { mtime, main, extra };
}

/** 生成注入到 user-context 的 <workspace_context> 块。
 *  root 未传=读当前工作区；null=明确不用工作区（返回空）。
 *  缓存按 mtime 指纹失效：指令文件内容变了会重新读取（原来只按 root，内容变更不刷新）。 */
export async function loadWorkspaceBlock(root?: string | null): Promise<string> {
  const r = root === undefined ? await getWorkspaceRoot() : root;
  if (!r) return '';
  try {
    if (!(await stat(r)).isDirectory()) return '';
  } catch { return ''; }

  const { mtime, main, extra } = await scanInstructions(r);
  if (cached && cached.root === r && cached.mtime === mtime) return cached.block;

  const parts: string[] = [];
  for (const rel of main) {
    try {
      let text = await readFile(path.join(r, rel), 'utf-8');
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
        text = text.slice(0, MAX_FILE_BYTES) + '\n…（已截断）';
      }
      parts.push(`### ${rel}\n${text.trim()}`);
    } catch { /* 文件不存在就跳过 */ }
  }
  for (const e of extra) {
    try {
      let text = await readFile(path.join(r, '.codebuddy', e), 'utf-8');
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) text = text.slice(0, MAX_FILE_BYTES) + '\n…（已截断）';
      parts.push(`### .codebuddy/${e}\n${text.trim()}`);
    } catch { /* skip */ }
  }

  const block = parts.length
    ? [
        '<workspace_context>',
        `当前工作区：${r}`,
        '以下是工作区的指令文件，严格遵守其中的规则（尤其 AGENTS.md/CLAUDE.md）：',
        '',
        parts.join('\n\n'),
        '</workspace_context>',
      ].join('\n')
    : `<workspace_context>\n当前工作区：${r}\n（该工作区没有 AGENTS.md/CLAUDE.md/README.md 等指令文件）\n</workspace_context>`;

  cached = { root: r, mtime, block };
  return block;
}

/** 候选工作区：Paw 项目、用户常见代码目录、home 下含指令文件的目录 */
export async function listWorkspaceCandidates(): Promise<string[]> {
  const out = new Set<string>();
  for (const p of await listWorkspaces()) out.add(p);
  // 常见根目录
  for (const base of [
    path.join(os.homedir(), 'Workspaces', '01-codespaces'),
    path.join(os.homedir(), 'Workspaces'),
    path.join(os.homedir(), 'WorkBuddy'),
    os.homedir(),
  ]) {
    try {
      const entries = await readdir(base, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        out.add(path.join(base, e.name));
      }
    } catch { /* skip */ }
  }
  return [...out].slice(0, 60);
}

/** 解析工具路径：绝对路径原样；相对路径基于本次运行固定的工作区。
 *  root 未传=兼容旧调用读当前工作区；null=无工作区，基于 server 启动目录。 */
export async function resolveToolPath(p: string, root?: string | null): Promise<string> {
  if (path.isAbsolute(p)) return p;
  const base = root === undefined ? await getWorkspaceRoot() : root;
  // 没有工作区时落到主目录：path.resolve 会基于 process.cwd()，
  // 打包后那是 app 自己的安装目录，相对路径会解析到 Electron 内部去。
  return path.join(base || os.homedir(), p);
}
