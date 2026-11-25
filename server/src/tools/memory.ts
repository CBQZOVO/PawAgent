// 长期记忆：memory_save / memory_search / memory_delete。
// 对标 Qoder UpdateMemory/SearchMemory、CodeBuddy update_memory、dsh 记忆机制。
// 统一复用 ~/.paw/paw.db（见 db.ts / paths.ts），避免打包应用下写只读 cwd 崩溃或升级丢数据。
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolSchema } from '@paw/shared';
import { db } from '../db.js';
import { DATA_DIR, LEGACY_DIRS } from '../paths.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    workspace TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
// 旧库补 workspace 列：存量记忆全归为通用（''），不用迁移数据
try {
  const cols = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
  if (cols.length && !cols.some((c) => c.name === 'workspace')) {
    db.exec("ALTER TABLE memories ADD COLUMN workspace TEXT NOT NULL DEFAULT ''");
  }
} catch { /* 新库已带列 */ }

/** 一次性迁移旧版落在 server/data/paw.db 里的记忆条目（之前 memory.ts 单独打开了 cwd/data/paw.db） */
function migrateLegacyMemoriesOnce(): void {
  if (process.env.PAW_DATA_DIR) return; // 测试环境使用隔离目录，不迁入宿主机旧数据
  const currentDb = path.resolve(DATA_DIR, 'paw.db');
  const count = (db.prepare('SELECT COUNT(1) AS n FROM memories').get() as { n: number } | undefined)?.n ?? 0;
  if (count > 0) return;
  for (const dir of LEGACY_DIRS) {
    const candidate = path.resolve(dir, 'paw.db');
    if (candidate === currentDb || !existsSync(candidate)) continue;
    let legacy: DatabaseSync | null = null;
    try {
      legacy = new DatabaseSync(candidate, { open: true });
      const rows = legacy.prepare('SELECT id, title, content, tags, created_at, updated_at FROM memories').all() as {
        id: string; title: string; content: string; tags: string; created_at: number; updated_at: number;
      }[];
      if (!rows.length) continue;
      const ins = db.prepare(`INSERT OR IGNORE INTO memories(id,title,content,tags,created_at,updated_at) VALUES(?,?,?,?,?,?)`);
      for (const r of rows) ins.run(r.id, r.title, r.content, r.tags || '', r.created_at, r.updated_at);
      break;
    } catch { /* 旧库无 memories 表或不可读则跳过 */ }
    finally { try { legacy?.close(); } catch { /* ignore */ } }
  }
}
migrateLegacyMemoriesOnce();

export interface Memory { id: string; title: string; content: string; tags: string; workspace: string; updatedAt: number }

export const MEMORY_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'memory_save',
    description: 'Save a durable memory across sessions: user preferences, project facts, decisions, lessons learned. Memories are scoped to the current workspace (project) by default. If id is given, updates that memory; otherwise creates a new one. Keep title short and content factual. Do NOT save secrets/passwords.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, e.g. "报工脚本位置" / "用户偏好简洁回复"' },
        content: { type: 'string', description: 'The fact/preference/lesson to remember (concise, factual)' },
        tags: { type: 'string', description: 'Optional comma-separated tags for retrieval, e.g. "报工,oms,脚本"' },
        id: { type: 'string', description: 'Optional existing memory id to update (from memory_search)' },
        summary: { type: 'string', description: '用简体中文简述要记什么，20字以内' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'memory_search',
    description: 'Search long-term memories by keyword (matches title/content/tags). Returns full content of top hits. Use before asking the user something they may have told you before.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search (space-separated terms are OR-matched)' },
        limit: { type: 'number', description: 'Max results (default 5, max 20)' },
        summary: { type: 'string', description: '用简体中文简述要找什么记忆，20字以内' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete an outdated or wrong memory by id (from memory_search).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory id to delete' },
        summary: { type: 'string', description: '用简体中文简述目的，20字以内' },
      },
      required: ['id'],
    },
  },
];

export const MEMORY_TOOL_NAMES = new Set(['memory_save', 'memory_search', 'memory_delete']);

/** workspace 入参归一：undefined/null/空 → ''（通用记忆） */
function normWs(workspace: string | null | undefined): string {
  return typeof workspace === 'string' ? workspace.trim() : '';
}

function saveMemory(args: Record<string, unknown>, workspace?: string | null): string {
  const title = String(args.title || '').trim();
  const content = String(args.content || '').trim();
  if (!title || !content) throw new Error('title 和 content 都不能为空');
  const tags = String(args.tags || '').trim();
  const ws = normWs(workspace);
  const now = Date.now();
  const id = typeof args.id === 'string' && args.id ? args.id : null;
  if (id) {
    const r = db.prepare('UPDATE memories SET title=?, content=?, tags=?, updated_at=? WHERE id=?').run(title, content, tags, now, id);
    if (r.changes === 0) throw new Error(`没有这条记忆: ${id}（不带 id 则新建）`);
    return `已更新记忆 ${id}: ${title}`;
  }
  const newId = `mem-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare('INSERT INTO memories(id,title,content,tags,workspace,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(newId, title, content, tags, ws, now, now);
  return `已记住 ${newId}: ${title}`;
}

function searchMemories(args: Record<string, unknown>, workspace?: string | null): string {
  const query = String(args.query || '').trim();
  const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
  const ws = normWs(workspace);
  // 只看当前项目的记忆 + 通用记忆
  const rows = db.prepare("SELECT id,title,content,tags,workspace,updated_at FROM memories WHERE workspace=? OR workspace='' ORDER BY updated_at DESC")
    .all(ws) as { id: string; title: string; content: string; tags: string; updated_at: number }[];
  if (!query) {
    return rows.slice(0, limit).map((r) => `[${r.id}] ${r.title}\n${r.content}`).join('\n\n') || '（还没有记忆）';
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = rows.map((r) => {
    const hay = `${r.title} ${r.content} ${r.tags}`.toLowerCase();
    const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    return { r, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.r.updated_at - a.r.updated_at);
  if (!scored.length) return `没有匹配「${query}」的记忆`;
  return scored.slice(0, limit).map(({ r }) => `[${r.id}] ${r.title}${r.tags ? ` (${r.tags})` : ''}\n${r.content}`).join('\n\n');
}

function deleteMemory(args: Record<string, unknown>): string {
  const r = db.prepare('DELETE FROM memories WHERE id=?').run(String(args.id));
  if (r.changes === 0) throw new Error(`没有这条记忆: ${args.id}`);
  return `已删除记忆 ${args.id}`;
}

export async function executeMemoryTool(name: string, args: Record<string, unknown>, workspace?: string | null): Promise<string> {
  if (name === 'memory_save') return saveMemory(args, workspace);
  if (name === 'memory_search') return searchMemories(args, workspace);
  if (name === 'memory_delete') return deleteMemory(args);
  throw new Error(`Unknown memory tool: ${name}`);
}

/** 每轮注入的紧凑记忆索引（只有标题+tags，全文靠 memory_search 取，省 token）。
 *  只注入当前项目 + 通用的记忆，项目记忆标注来源。 */
export function loadMemoryIndex(workspace?: string | null): string {
  const ws = normWs(workspace);
  const rows = db.prepare("SELECT id,title,tags,workspace FROM memories WHERE workspace=? OR workspace='' ORDER BY updated_at DESC LIMIT 40")
    .all(ws) as { id: string; title: string; tags: string; workspace: string }[];
  if (!rows.length) return '';
  const lines = rows.map((r) => `- [${r.id}] ${r.title}${r.tags ? ` (${r.tags})` : ''}${ws && r.workspace === '' ? ' ·通用' : ''}`);
  return [
    '<long_term_memory>',
    '这些是跨会话记住的事实/偏好/经验（只有索引，标了 ·通用 的是跨项目记忆）。需要细节时用 memory_search 查全文；',
    '发现记忆过时或错误时用 memory_save(id=...) 更新或 memory_delete 删除；',
    '本轮学到值得长期记住的新事实时，主动 memory_save（自动按当前项目归档）。',
    ...lines,
    '</long_term_memory>',
  ].join('\n');
}

// ---------------- 管理 API 用（查看/编辑页面） ----------------
/** 管理页列表：不传 workspace 返回全部（前端自己筛），传了返回该项目+通用 */
export function listMemories(workspace?: string | null, limit = 500): Memory[] {
  const rows = (workspace
    ? db.prepare("SELECT * FROM memories WHERE workspace=? OR workspace='' ORDER BY updated_at DESC LIMIT ?").all(workspace, limit)
    : db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit)) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string, title: r.title as string, content: r.content as string,
    tags: r.tags as string, workspace: (r.workspace as string) || '', updatedAt: r.updated_at as number,
  }));
}

/** 管理页/自动记忆共用的新建+更新。返回 id。 */
export function upsertMemoryDirect(m: { id?: string; title: string; content: string; tags?: string; workspace?: string | null }): string {
  const now = Date.now();
  if (m.id) {
    const r = db.prepare('UPDATE memories SET title=?, content=?, tags=?, updated_at=? WHERE id=?')
      .run(m.title, m.content, m.tags || '', now, m.id);
    if (r.changes === 0) throw new Error(`没有这条记忆: ${m.id}`);
    return m.id;
  }
  const id = `mem-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare('INSERT INTO memories(id,title,content,tags,workspace,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, m.title, m.content, m.tags || '', normWs(m.workspace), now, now);
  return id;
}

export function deleteMemoryById(id: string): boolean {
  return db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0;
}