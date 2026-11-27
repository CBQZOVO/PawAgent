// ============================================================================
// 文件快照回滚与跨分叉工作区状态切换（snapshots.ts）
// ============================================================================
// 每当 AI 通过 write_file / edit_file / delete_file 修改磁盘文件时，
// 我们都会在改之前读一份 before、改之后读一份 after，按时间顺序记在 ~/.paw/rollback/<sessionId>.json 里。
//
// 基于这份改动日志，支持三种操作：
//   1. rollbackAfter（破坏性回退）：用户点「编辑消息并重发」时，倒序撤销该消息之后的所有文件改动并裁掉历史；
//   2. revertWorkspaceTo + forkSnapshotRecords（会话分叉）：原会话快照不动，把工作区退回分叉点，并把分叉点之前的历史拷贝给新分支；
//   3. switchSessionWorkspace（跨分叉切换）：用分叉树的最近公共祖先（LCA）算出共享截止点 pivotTs，
//      先倒序撤销源分支在 pivotTs 之后的改动，再正序重放目标分支在 pivotTs 之后的改动。
//
// 核心安全铁律：
//   动任何文件之前，先核对「磁盘当前内容」是否严格等于预期值（undo 比对 after，redo 比对 before）；
//   只要发现不等，说明用户自己在外面手改过这个文件 —— 立刻跳过并拉黑该路径，绝不覆盖用户手写代码！
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { computeForkLCA, type ForkTreeNode } from '@paw/kernel';
import { DATA_DIR } from './paths.js';

/** 单条文件改动记录：记住改动时间、文件路径、改前内容和改后内容 */
export interface FileChange {
  at: number;              // 单调递增时间戳（毫秒），保证同毫秒内多次写入也有严格先后顺序
  path: string;            // 文件绝对路径
  before: string | null;   // 改前内容；null 表示文件原本不存在（新建）
  after: string | null;    // 改后内容；null 表示文件被删除
}

/** 跨分支切换结果报告 */
export interface SwitchWorkspaceResult {
  switched: boolean;            // 是否执行了切换（两个不相关会话时为 false）
  lcaSessionId: string | null;  // 找到的最近公共祖先会话 ID
  pivotTs: number | null;       // 共同历史的截止时间戳
  restored: string[];           // 第一阶段（undo 源分支）成功还原的文件路径
  replayed: string[];           // 第二阶段（redo 目标分支）成功重放的文件路径
  skipped: string[];            // 因用户手动修改过或 IO 失败而被安全跳过的文件路径
}

const MAX_PER_SESSION = 300; // 每个会话最多保留最近 300 条改动记录，防止 JSON 无限膨胀
const store = new Map<string, FileChange[]>();           // 内存缓存：sessionId -> 改动数组
const loading = new Map<string, Promise<FileChange[]>>(); // 并发读去重：同一会话同时首次 load 时共享一个 Promise
const persistChains = new Map<string, Promise<void>>();   // 并发写串行链：同一会话多次落盘按顺序排队写
let persistSeq = 0;
let lastRecordedAt = 0;

/** 生成严格单调递增的时间戳：即使两笔写入发生在同一毫秒，后者也会自动 +1，避免边界比较歧义 */
function nextMonotonicTs(): number {
  const now = Date.now();
  lastRecordedAt = now > lastRecordedAt ? now : lastRecordedAt + 1;
  return lastRecordedAt;
}

const rollbackDir = () => path.join(DATA_DIR, 'rollback');
const storeFile = (sessionId: string) =>
  path.join(rollbackDir(), `${sessionId.replace(/[^\w.-]/g, '_')}.json`);

/** 加载某会话的快照记录（带内存缓存 + 并发防重入，避免多个工具同时写文件时各自读出一份数组互相覆盖） */
async function load(sessionId: string): Promise<FileChange[]> {
  const cached = store.get(sessionId);
  if (cached) return cached;
  const inflight = loading.get(sessionId);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      const list = JSON.parse(await readFile(storeFile(sessionId), 'utf-8')) as FileChange[];
      if (Array.isArray(list)) {
        store.set(sessionId, list);
        return list;
      }
    } catch { /* 首次还没有历史文件，正常忽略 */ }
    const empty: FileChange[] = [];
    store.set(sessionId, empty);
    return empty;
  })().finally(() => {
    loading.delete(sessionId);
  });

  loading.set(sessionId, task);
  return task;
}

/**
 * 串行 + 原子落盘：
 * 1) 同一会话的多次 persist 挂到同一条 Promise 链上依次执行，不会出现「旧快照后写完反盖新快照」；
 * 2) 先写临时文件 .tmp 再 rename 替换正式文件，即使进程中途崩了也不会留下半截损坏的 JSON。
 */
async function persist(sessionId: string, list: FileChange[]): Promise<void> {
  const payload = JSON.stringify(list);
  const prev = persistChains.get(sessionId) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const f = storeFile(sessionId);
      await mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.${++persistSeq}.tmp`;
      await writeFile(tmp, payload, 'utf-8');
      await rename(tmp, f);
    } catch { /* 落盘失败不影响内存里的回滚能力 */ }
  });
  persistChains.set(sessionId, next);
  await next;
}

/** 记录一次文件改动（在真正写盘前读 before、写盘后读 after），返回分配到的单调时间戳 */
export async function recordFileChange(
  sessionId: string,
  filePath: string,
  before: string | null,
  after: string | null,
): Promise<number | null> {
  if (before === after) return null; // 内容实际没变，不白占快照槽位
  const list = await load(sessionId);
  const at = nextMonotonicTs();
  list.push({ at, path: filePath, before, after });
  if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
  store.set(sessionId, list);
  await persist(sessionId, list);
  return at;
}

/** 查询某会话最新一条快照的时间戳（没有快照返回 0） */
export async function getLatestSnapshotTs(sessionId: string): Promise<number> {
  const list = await load(sessionId);
  return list.reduce((max, c) => (c.at > max ? c.at : max), 0);
}

/**
 * 内部通用撤销引擎：把时间戳严格大于 afterTs 的所有改动按时间「从新到旧」逐条倒退回 before。
 * 注意：同一个文件如果被连续改过 v1 -> v2 -> v3，倒序回放正好是 v3->v2 再 v2->v1，一步不差。
 */
async function undoChangesAfter(
  list: FileChange[],
  afterTs: number,
): Promise<{ restored: string[]; skipped: string[]; skippedSet: Set<FileChange> }> {
  const hit = list.filter((c) => c.at > afterTs).sort((a, b) => b.at - a.at);
  const restored: string[] = [];
  const skipped: string[] = [];
  const skippedSet = new Set<FileChange>();

  for (const c of hit) {
    try {
      const cur = await readFile(c.path, 'utf-8').catch(() => null);
      // 关键保护：当前磁盘内容如果不等于 AI 当时写进去的 after，说明用户自己改过，绝不动它
      if (cur !== c.after) {
        skipped.push(c.path);
        skippedSet.add(c);
        continue;
      }
      if (c.before === null) await rm(c.path, { force: true }); // 当初是新建的，退回就是删掉
      else {
        await mkdir(path.dirname(c.path), { recursive: true });
        await writeFile(c.path, c.before, 'utf-8');
      }
      restored.push(c.path);
    } catch {
      skipped.push(c.path);
      skippedSet.add(c);
    }
  }
  return { restored, skipped, skippedSet };
}

/**
 * 破坏性回退：撤销 afterTs 之后的改动，并从会话历史里裁掉已成功还原的条目。
 * （因用户手改而 skipped 的条目会被保留，避免之后再回滚时丢失记录）
 */
export async function rollbackAfter(
  sessionId: string,
  afterTs: number,
): Promise<{ restored: string[]; skipped: string[] }> {
  const list = await load(sessionId);
  const { restored, skipped, skippedSet } = await undoChangesAfter(list, afterTs);
  const keep = list.filter((c) => c.at <= afterTs || skippedSet.has(c));
  store.set(sessionId, keep);
  await persist(sessionId, keep);
  return { restored, skipped };
}

/**
 * 非破坏性回退（专用于会话分叉）：
 * 把工作区文件退回到 baselineTs 时刻的状态，但「不删除」原会话的快照记录，
 * 这样以后切回原会话时，依然能靠原会话的快照把文件状态重放回来。
 */
export async function revertWorkspaceTo(
  sessionId: string,
  baselineTs: number,
): Promise<{ restored: string[]; skipped: string[] }> {
  const list = await load(sessionId);
  const { restored, skipped } = await undoChangesAfter(list, baselineTs);
  return { restored, skipped };
}

/**
 * 分叉快照继承：把源会话在分叉基线 baselineTs 及之前（at <= baselineTs）的历史复制给新分支，
 * 分叉之后的改动不拷贝（那属于原会话自己的后续演进）。
 */
export async function forkSnapshotRecords(
  sourceSessionId: string,
  targetSessionId: string,
  baselineTs: number,
): Promise<void> {
  const list = await load(sourceSessionId);
  const inherited = list
    .filter((c) => c.at <= baselineTs)
    .map((c) => ({ ...c }));
  store.set(targetSessionId, inherited);
  await persist(targetSessionId, inherited);
}

/**
 * 跨同源分叉切换工作区文件状态（基于 LCA 最近公共祖先）：
 *
 * 举例：Root 改了 alpha=v1(t=10) -> alpha=v2(t=20)；
 *       Branch1 在 t=10 从 Root 分叉后改了 alpha=v1-b1(t=30)。
 *       现在用户从 Branch1 切回 Root：
 *         - computeForkLCA 算出 LCA = Root，共享截止时间 pivotTs = 10；
 *         - Step 1（Undo 源分支）：倒序撤销 Branch1 里 at > 10 的改动 -> alpha 从 v1-b1 退回 v1；
 *         - Step 2（Redo 目标分支）：正序重放 Root 里 at > 10 的改动 -> alpha 从 v1 前进到 v2。
 */
export async function switchSessionWorkspace(
  fromSessionId: string,
  toSessionId: string,
  getNode: (id: string) => ForkTreeNode | null | undefined,
): Promise<SwitchWorkspaceResult> {
  const plan = computeForkLCA(fromSessionId, toSessionId, getNode);
  if (!plan) {
    // 两个会话不在同一棵分叉树里，不做任何文件切换
    return {
      switched: false,
      lcaSessionId: null,
      pivotTs: null,
      restored: [],
      replayed: [],
      skipped: [],
    };
  }
  if (plan.sameSession) {
    return {
      switched: true,
      lcaSessionId: plan.lcaSessionId,
      pivotTs: null,
      restored: [],
      replayed: [],
      skipped: [],
    };
  }

  const fromList = await load(fromSessionId);
  const toList = await load(toSessionId);
  // dirtyPaths 记录一旦被发现用户手改过的文件路径：undo 跳过它，后续 redo 也绝不再碰它
  const dirtyPaths = new Set<string>();
  const restored: string[] = [];
  const replayed: string[] = [];
  const skippedSet = new Set<string>();

  // Step 1：倒序撤销源分支在 pivotTs 之后的独有改动（把工作区退回到 LCA@pivotTs）
  const undoList = fromList.filter((c) => c.at > plan.pivotTs).sort((a, b) => b.at - a.at);
  for (const c of undoList) {
    if (dirtyPaths.has(c.path)) {
      skippedSet.add(c.path);
      continue;
    }
    try {
      const cur = await readFile(c.path, 'utf-8').catch(() => null);
      if (cur !== c.after) {
        dirtyPaths.add(c.path);
        skippedSet.add(c.path);
        continue;
      }
      if (c.before === null) await rm(c.path, { force: true });
      else {
        await mkdir(path.dirname(c.path), { recursive: true });
        await writeFile(c.path, c.before, 'utf-8');
      }
      restored.push(c.path);
    } catch {
      dirtyPaths.add(c.path);
      skippedSet.add(c.path);
    }
  }

  // Step 2：正序重放目标分支在 pivotTs 之后的独有改动（从 LCA@pivotTs 前进到目标分支最新状态）
  const redoList = toList.filter((c) => c.at > plan.pivotTs).sort((a, b) => a.at - b.at);
  for (const c of redoList) {
    if (dirtyPaths.has(c.path)) {
      skippedSet.add(c.path);
      continue;
    }
    try {
      const cur = await readFile(c.path, 'utf-8').catch(() => null);
      // 重放前核对：当前文件必须正好等于这条改动发生前的 before，不匹配说明有外部手改
      if (cur !== c.before) {
        dirtyPaths.add(c.path);
        skippedSet.add(c.path);
        continue;
      }
      if (c.after === null) await rm(c.path, { force: true });
      else {
        await mkdir(path.dirname(c.path), { recursive: true });
        await writeFile(c.path, c.after, 'utf-8');
      }
      replayed.push(c.path);
    } catch {
      dirtyPaths.add(c.path);
      skippedSet.add(c.path);
    }
  }

  return {
    switched: true,
    lcaSessionId: plan.lcaSessionId,
    pivotTs: Number.isFinite(plan.pivotTs) ? plan.pivotTs : null,
    restored,
    replayed,
    skipped: [...skippedSet],
  };
}

/** 删除单个会话的快照缓存与落盘 JSON（先等该会话在途写入落完再删，避免删完又被写回来） */
export async function deleteSnapshots(sessionId: string): Promise<void> {
  const pending = persistChains.get(sessionId);
  if (pending) await pending.catch(() => {});
  persistChains.delete(sessionId);
  store.delete(sessionId);
  loading.delete(sessionId);
  await rm(storeFile(sessionId), { force: true }).catch(() => {});
}

/** 清空全部会话快照 */
export async function clearSnapshots(): Promise<void> {
  await Promise.all([...persistChains.values()].map((p) => p.catch(() => {})));
  persistChains.clear();
  store.clear();
  loading.clear();
  await rm(rollbackDir(), { recursive: true, force: true }).catch(() => {});
}
