// 文件回滚：「编辑并重新发送」时，把 AI 在那条消息之后改过的文件退回去。
//
// 为什么必须做：用户改掉第 3 条消息重发，如果上一轮已经把 config.py 改坏了，
// 新一轮是基于「已改过」的文件开始的——状态就串了。WorkBuddy 的提示文案里那句
// 「产物也将回退至此信息前版本」就是这个意思。
//
// 只还原**我们写出来的**状态：回滚前比对当前内容是否等于 after，
// 用户手动改过的文件跳过，绝不覆盖他手写的代码。
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

interface FileChange {
  at: number;          // 改动时间（用于和消息 ts 比较）
  path: string;        // 绝对路径
  before: string | null;   // 改动前内容；null = 文件原本不存在
  after: string | null;    // 改动后内容；null = 被删除
}

const MAX_PER_SESSION = 300;
const store = new Map<string, FileChange[]>();

const storeFile = (sessionId: string) =>
  path.join(DATA_DIR, 'rollback', `${sessionId.replace(/[^\w.-]/g, '_')}.json`);

async function load(sessionId: string): Promise<FileChange[]> {
  const cached = store.get(sessionId);
  if (cached) return cached;
  try {
    const list = JSON.parse(await readFile(storeFile(sessionId), 'utf-8')) as FileChange[];
    if (Array.isArray(list)) { store.set(sessionId, list); return list; }
  } catch { /* 没有历史 */ }
  return [];
}

async function persist(sessionId: string, list: FileChange[]): Promise<void> {
  try {
    const f = storeFile(sessionId);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify(list), 'utf-8');
  } catch { /* 落盘失败不影响内存回滚 */ }
}

/** 记一次文件改动（在写文件前读 before、写完后读 after） */
export async function recordFileChange(
  sessionId: string,
  filePath: string,
  before: string | null,
  after: string | null,
): Promise<void> {
  if (before === after) return; // 没真改，不占位置
  const list = await load(sessionId);
  list.push({ at: Date.now(), path: filePath, before, after });
  if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
  store.set(sessionId, list);
  void persist(sessionId, list);
}

/**
 * 把时间戳晚于 `afterTs` 的改动倒序还原。
 * @returns 还原成功的路径 / 被跳过（已被手动改动）的路径
 */
export async function rollbackAfter(
  sessionId: string,
  afterTs: number,
): Promise<{ restored: string[]; skipped: string[] }> {
  const list = await load(sessionId);
  const hit = list.filter((c) => c.at > afterTs).sort((a, b) => b.at - a.at);
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const c of hit) {
    try {
      const cur = await readFile(c.path, 'utf-8').catch(() => null);
      if (cur !== c.after) { skipped.push(c.path); continue; } // 有人在中间手改过，别动
      if (c.before === null) await rm(c.path, { force: true });
      else {
        await mkdir(path.dirname(c.path), { recursive: true });
        await writeFile(c.path, c.before, 'utf-8');
      }
      restored.push(c.path);
    } catch {
      skipped.push(c.path);
    }
  }
  const keep = list.filter((c) => c.at <= afterTs);
  store.set(sessionId, keep);
  void persist(sessionId, keep);
  return { restored, skipped };
}
