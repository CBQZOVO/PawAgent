// SQLite 会话持久化：用 Node 22 内置 node:sqlite，零依赖。
// 表结构极简：一个会话一行，messages 存 JSON（不拆表，代码干净、改动小）。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { messageText, normalizeMessage, type ContextReading, type Session, type ScheduledTask, type SessionSummary, type TaskRun, type ViewMessage } from '@paw/shared';
import { friendlyGatewayError } from './gateway/client.js';
import { DATA_DIR, LEGACY_DIRS, dataFile } from './paths.js';

// 库放 ~/.paw，不跟 app 包走（重装会清空包内目录，见 paths.ts）
const DB_FILE = dataFile('paw.db', LEGACY_DIRS);
export const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    messages TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS context_checkpoints (
    session_id TEXT PRIMARY KEY, covered INTEGER NOT NULL, digest TEXT NOT NULL, summary TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS context_samples (
    seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_context_samples ON context_samples(session_id, at DESC, seq DESC);
  CREATE TRIGGER IF NOT EXISTS trim_context_samples AFTER INSERT ON context_samples BEGIN
    DELETE FROM context_samples WHERE seq IN (
      SELECT seq FROM context_samples WHERE session_id=NEW.session_id ORDER BY at DESC, seq DESC LIMIT -1 OFFSET 100
    );
  END;
`);
// 旧库补 meta 列（存 workspace/source/taskId 等会话归属，避免刷新后丢失）
try {
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (cols.length && !cols.some((c) => c.name === 'meta')) {
    db.exec("ALTER TABLE sessions ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'");
  }
} catch { /* 新库无需迁移 */ }
// 定时任务：任务定义（整个存 JSON）+ 执行历史
// 迁移：旧版有 tool/args 列，重建为 data JSON 列（定时任务无重要数据，直接清）
try {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  if (cols.length && !cols.some((c) => c.name === 'data')) db.exec('DROP TABLE IF EXISTS tasks');
} catch { /* 新库没有表 */ }
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, at INTEGER NOT NULL,
    ok INTEGER NOT NULL, output TEXT NOT NULL, seconds REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, at DESC);
`);

/** 清洗历史消息：旧版本把错误拼在 content 里（> ⚠️ gateway 502: {...}），
 *  提取到独立的 error 字段并翻译成人话，避免刷新后还看到一坨 JSON+HTML。
 *  content 现在是块数组，尾巴一般落在最后一个 text 块上。 */
function migrateLegacyError(m: ViewMessage): ViewMessage {
  if (m.role !== 'assistant') return m;
  const text = messageText(m);
  if (!text) return m;
  const match = text.match(/\n\n> ⚠️ (gateway \d+: .+)$/s);
  if (!match) return m;
  const content = [...m.content];
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i];
    if (b.type !== 'text') continue;
    const idx = b.text.indexOf(match[0]);
    if (idx >= 0) content[i] = { type: 'text', text: b.text.slice(0, idx) };
    break;
  }
  return { ...m, content, error: friendlyGatewayError(502, match[1].replace(/^gateway (\d+): /, '')) };
}

/** 会话归属元数据（workspace/source/taskId/runId/handoffFrom/handoffTo），单独存 JSON 方便扩展 */
type SessionMeta = Pick<Session, 'workspace' | 'source' | 'taskId' | 'runId' | 'parentId' | 'handoffFrom' | 'handoffTo'>;
interface SessionRow {
  id: string;
  title: string;
  messages: string;
  updated_at: number;
  meta: string | null;
}

function parseHandoffLink(raw: unknown): Session['handoffFrom'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { sessionId?: unknown; title?: unknown };
  if (typeof r.sessionId !== 'string' || !r.sessionId) return undefined;
  return { sessionId: r.sessionId, title: typeof r.title === 'string' && r.title ? r.title : '原会话' };
}

function parseSessionMeta(raw: string | null): SessionMeta {
  try {
    const m = JSON.parse(raw || '{}') as SessionMeta;
    const handoffFrom = parseHandoffLink(m.handoffFrom);
    const handoffTo = parseHandoffLink(m.handoffTo);
    return {
      ...(typeof m.workspace === 'string' && m.workspace ? { workspace: m.workspace } : {}),
      ...(m.source === 'task' || m.source === 'subagent' ? { source: m.source } : {}),
      ...(typeof m.taskId === 'string' && m.taskId ? { taskId: m.taskId } : {}),
      ...(typeof m.runId === 'string' && m.runId ? { runId: m.runId } : {}),
      ...(typeof m.parentId === 'string' && m.parentId ? { parentId: m.parentId } : {}),
      ...(handoffFrom ? { handoffFrom } : {}),
      ...(handoffTo ? { handoffTo } : {}),
    };
  } catch { return {}; }
}

/** 存量会话一次性迁移（模块加载时执行）：
 *  - 旧版本把错误拼在 content 里 → 提取到独立 error 字段并翻译成人话；
 *  - 老定时任务会话没有 source 标记 → 用「首条用户消息 ≈ 任务 prompt」补标记。
 *  写回后读路径不再解析消息正文（列表接口零消息解析），migrate/infer 逻辑只活在这里。 */
function migrateSessionsOnce(): void {
  const tasks = (db.prepare('SELECT data FROM tasks').all() as { data: string }[])
    .map((r) => { try { return JSON.parse(r.data) as { id: string; prompt: string }; } catch { return null; } })
    .filter((t): t is { id: string; prompt: string } => !!t);
  const rows = db.prepare('SELECT id, messages, meta FROM sessions').all() as { id: string; messages: string; meta: string | null }[];
  for (const r of rows) {
    let msgs: ViewMessage[];
    try { msgs = JSON.parse(r.messages) as ViewMessage[]; } catch { continue; }
    const meta = parseSessionMeta(r.meta);
    let changed = false;
    msgs = msgs.map((raw) => {
      // 数据模型升级：content 从 string + tools 数组升成块数组（见 shared 的 ContentBlock）。
      // 只转旧格式，已是数组的跳过——否则每次启动都会以为有变化、反复写库。
      let m = raw;
      if (!Array.isArray((m as unknown as { content?: unknown }).content)) {
        // 第一次真要改库之前留个整库快照：这个迁移会重写所有老会话的 messages
        const bak = path.join(DATA_DIR, 'paw.db.bak-before-content-blocks');
        if (!existsSync(bak)) { try { copyFileSync(path.join(DATA_DIR, 'paw.db'), bak); } catch { /* 备份失败不阻塞迁移 */ } }
        m = normalizeMessage(raw as unknown as Record<string, unknown>);
        changed = true;
      }
      const n = migrateLegacyError(m);
      if (n !== m) changed = true;
      return n;
    });
    let { workspace, source, taskId } = meta;
    if (!source) {
      const firstUserMsg = msgs.find((m) => m.role === 'user');
      const firstUser = firstUserMsg ? messageText(firstUserMsg).trim() : '';
      if (firstUser) {
        const match = tasks.find((t) => {
          const p = t.prompt?.trim();
          if (!p) return false;
          // 会话首条消息可能是 prompt 原文，或 prompt 前 24 字（标题场景）；双向前缀匹配
          return firstUser.startsWith(p.slice(0, 40)) || p.startsWith(firstUser.slice(0, 40));
        });
        if (match) { source = 'task'; taskId = match.id; changed = true; }
      }
    }
    if (!changed) continue;
    db.prepare('UPDATE sessions SET messages=?, meta=? WHERE id=?')
      .run(JSON.stringify(msgs), JSON.stringify({ workspace, source, taskId, runId: meta.runId, parentId: meta.parentId }), r.id);
  }
}
migrateSessionsOnce();

/** 会话列表：只返回摘要（不解析消息 JSON），正文按需走 getSession */
export function listSessionSummaries(): SessionSummary[] {
  const rows = db.prepare('SELECT id, title, updated_at, meta FROM sessions ORDER BY updated_at DESC').all() as unknown as { id: string; title: string; updated_at: number; meta: string | null }[];
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at, ...parseSessionMeta(r.meta) }));
}

export function getSession(id: string): Session | null {
  const r = db.prepare('SELECT id, title, messages, updated_at, meta FROM sessions WHERE id=?').get(id) as unknown as SessionRow | undefined;
  return r ? {
    id: r.id, title: r.title, messages: JSON.parse(r.messages), updatedAt: r.updated_at,
    ...parseSessionMeta(r.meta),
  } : null;
}

function serializeSessionMeta(s: Session): string {
  return JSON.stringify({
    workspace: s.workspace,
    source: s.source,
    taskId: s.taskId,
    runId: s.runId,
    parentId: s.parentId,
    handoffFrom: s.handoffFrom,
    handoffTo: s.handoffTo,
  });
}

export function upsertSession(s: Session): void {
  db.prepare(`INSERT INTO sessions(id,title,messages,updated_at,meta) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, messages=excluded.messages, updated_at=excluded.updated_at, meta=excluded.meta`)
    .run(s.id, s.title, JSON.stringify(s.messages), s.updatedAt, serializeSessionMeta(s));
}

export function upsertSessions(list: Session[]): void {
  if (!list.length) return;
  if (list.length === 1) { upsertSession(list[0]); return; }
  const stmt = db.prepare(`INSERT INTO sessions(id,title,messages,updated_at,meta) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, messages=excluded.messages, updated_at=excluded.updated_at, meta=excluded.meta`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const s of list) {
      stmt.run(s.id, s.title, JSON.stringify(s.messages), s.updatedAt, serializeSessionMeta(s));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface ContextCheckpoint {
  covered: number;
  digest: string;
  summary: string;
}

export function getContextCheckpoint(id: string): ContextCheckpoint | null {
  const row = db.prepare('SELECT covered, digest, summary FROM context_checkpoints WHERE session_id=?').get(id);
  return row ? { covered: Number(row.covered), digest: String(row.digest), summary: String(row.summary) } : null;
}

export function saveContextCheckpoint(id: string, previous: ContextCheckpoint | null, next: ContextCheckpoint): boolean {
  if (!previous) {
    return db.prepare(`INSERT INTO context_checkpoints(session_id, covered, digest, summary) VALUES(?, ?, ?, ?)
      ON CONFLICT(session_id) DO NOTHING`).run(id, next.covered, next.digest, next.summary).changes === 1;
  }
  return db.prepare(`UPDATE context_checkpoints SET covered=?, digest=?, summary=?
    WHERE session_id=? AND covered=? AND digest=? AND summary=?`)
    .run(next.covered, next.digest, next.summary, id, previous.covered, previous.digest, previous.summary).changes === 1;
}

export function addContextSample(id: string, sample: object): void {
  db.prepare('INSERT INTO context_samples(session_id, at, data) VALUES(?, ?, ?)').run(id, Date.now(), JSON.stringify(sample));
}

export function getContextSamples(id: string): object[] {
  const rows = db.prepare('SELECT at, data FROM context_samples WHERE session_id=? ORDER BY at, seq').all(id);
  return rows.map(row => ({ ...JSON.parse(String(row.data)), at: Number(row.at) }));
}

export function getContextReading(id: string, turnId: string, since?: number): ContextReading | null {
  let row = db.prepare(`SELECT data FROM context_samples WHERE session_id=? AND json_extract(data,'$.turnId')=?
    ORDER BY at DESC, seq DESC LIMIT 1`).get(id, turnId);
  if (!row && since !== undefined) {
    // 旧记录没有 turnId。用保存的助手耗时封住右边界，避免回退后读到已撤销轮次。
    const messages = getSession(id)?.messages ?? [];
    const index = messages.findIndex(m => m.role === 'user' && m.id === turnId && m.ts === since);
    const reply = index >= 0 ? messages[index + 1] : undefined;
    if (reply?.role === 'assistant' && reply.durationMs !== undefined) {
      row = db.prepare(`SELECT data FROM context_samples WHERE session_id=? AND at BETWEEN ? AND ?
        AND json_extract(data,'$.turnId') IS NULL ORDER BY at DESC, seq DESC LIMIT 1`)
        .get(id, since, reply.ts + reply.durationMs);
    }
  }
  if (!row) return null;
  const { usage, estimatedTokens } = JSON.parse(String(row.data));
  if (Number.isFinite(usage?.prompt) && Number.isFinite(usage?.completion)) {
    return { tokens: usage.prompt, estimated: false };
  }
  return Number.isFinite(estimatedTokens) ? { tokens: estimatedTokens, estimated: true } : null;
}

function removeSessionData(id?: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (id === undefined) {
      db.exec('DELETE FROM context_checkpoints; DELETE FROM context_samples; DELETE FROM sessions');
    } else {
      db.prepare('DELETE FROM context_checkpoints WHERE session_id=?').run(id);
      db.prepare('DELETE FROM context_samples WHERE session_id=?').run(id);
      db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function deleteSession(id: string): void {
  removeSessionData(id);
}

export function clearSessions(): void {
  removeSessionData();
}

// ---------------- 定时任务 ----------------
function rowToTask(r: Record<string, unknown>): ScheduledTask {
  return JSON.parse(r.data as string) as ScheduledTask;
}

export function listTasks(): ScheduledTask[] {
  const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getTask(id: string): ScheduledTask | null {
  const r = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown> | undefined;
  return r ? rowToTask(r) : null;
}

export function upsertTask(t: ScheduledTask): void {
  db.prepare(`INSERT INTO tasks(id,data,enabled,created_at) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, enabled=excluded.enabled`)
    .run(t.id, JSON.stringify(t), t.enabled ? 1 : 0, t.createdAt);
}

export function deleteTask(id: string): void {
  db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  db.prepare('DELETE FROM task_runs WHERE task_id=?').run(id);
}

export function touchTask(id: string, at: number): void {
  const t = getTask(id);
  if (t) { t.lastRun = at; upsertTask(t); }
}

export function addRun(run: TaskRun): void {
  db.prepare('INSERT INTO task_runs(id,task_id,at,ok,output,seconds) VALUES(?,?,?,?,?,?)')
    .run(run.id, run.taskId, run.at, run.ok ? 1 : 0, run.output, run.seconds);
}

export function listRuns(taskId?: string, limit = 50): TaskRun[] {
  const rows = (taskId
    ? db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY at DESC LIMIT ?').all(taskId, limit)
    : db.prepare('SELECT * FROM task_runs ORDER BY at DESC LIMIT ?').all(limit)) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string, taskId: r.task_id as string, at: r.at as number,
    ok: !!r.ok, output: r.output as string, seconds: r.seconds as number,
  }));
}
