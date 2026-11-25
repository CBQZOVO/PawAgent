// 工作日志：每轮对话结束后自动记一条（见 reflection.ts），按项目（workspace）区分，
// 存 ~/.paw/paw.db。Agent 用 worklog_search 按日期查（定时报工），管理页走下面的 CRUD。
import { DatabaseSync } from 'node:sqlite';
import type { ToolSchema } from '@paw/shared';
import { db } from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS work_logs (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL DEFAULT '',
    day TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    session_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_worklogs_day ON work_logs(day DESC, created_at DESC);
`);

export interface WorkLog {
  id: string;
  workspace: string;
  day: string;       // YYYY-MM-DD（本地时区）
  title: string;
  content: string;
  sessionId?: string;
  createdAt: number;
}

/** 本地日期 YYYY-MM-DD（toLocaleDateString('sv-SE') 恰好是这个格式） */
export function localDay(ts = Date.now()): string {
  return new Date(ts).toLocaleDateString('sv-SE');
}

function rowToLog(r: Record<string, unknown>): WorkLog {
  return {
    id: r.id as string,
    workspace: (r.workspace as string) || '',
    day: r.day as string,
    title: r.title as string,
    content: r.content as string,
    ...(r.session_id ? { sessionId: r.session_id as string } : {}),
    createdAt: r.created_at as number,
  };
}

export function insertWorkLog(entry: {
  workspace?: string | null; sessionId?: string; title: string; content: string; day?: string;
}): string {
  const now = Date.now();
  const id = `wl-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare('INSERT INTO work_logs(id,workspace,day,title,content,session_id,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, (entry.workspace || '').trim(), entry.day || localDay(now),
      entry.title.trim(), entry.content.trim(), entry.sessionId || null, now);
  return id;
}

/** 列表查询。workspace 缺省=全部；day 缺省=今天起往前 days 天 */
export function listWorkLogs(opts: {
  workspace?: string | null; day?: string; days?: number; limit?: number;
} = {}): WorkLog[] {
  const days = Math.min(90, Math.max(1, opts.days || 7));
  const limit = Math.min(1000, Math.max(1, opts.limit || 500));
  const endDay = opts.day || localDay();
  const [y, m, d] = endDay.split('-').map(Number);
  const startDay = new Date(Date.UTC(y, (m || 1) - 1, d || 1) - (days - 1) * 86400_000).toLocaleDateString('sv-SE');
  const ws = (opts.workspace || '').trim();
  const rows = (ws
    ? db.prepare("SELECT * FROM work_logs WHERE day BETWEEN ? AND ? AND (workspace=? OR workspace='') ORDER BY created_at DESC LIMIT ?").all(startDay, endDay, ws, limit)
    : db.prepare('SELECT * FROM work_logs WHERE day BETWEEN ? AND ? ORDER BY created_at DESC LIMIT ?').all(startDay, endDay, limit)) as Record<string, unknown>[];
  return rows.map(rowToLog);
}

export function updateWorkLog(id: string, patch: { title?: string; content?: string }): boolean {
  const cur = db.prepare('SELECT title, content FROM work_logs WHERE id=?').get(id) as { title: string; content: string } | undefined;
  if (!cur) return false;
  const title = (patch.title ?? cur.title).trim();
  const content = (patch.content ?? cur.content).trim();
  if (!title || !content) throw new Error('title 和 content 都不能为空');
  return db.prepare('UPDATE work_logs SET title=?, content=? WHERE id=?').run(title, content, id).changes > 0;
}

export function deleteWorkLog(id: string): boolean {
  return db.prepare('DELETE FROM work_logs WHERE id=?').run(id).changes > 0;
}

// ---------------- Agent 工具 ----------------

export const WORKLOG_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'worklog_search',
    description: '查询工作日志（每轮对话结束后自动记录，按项目分开）。定时报工、写日报、回顾某天做了什么时用。返回当天的条目：时间、项目、标题、内容。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '起始日期 YYYY-MM-DD（本地时区），默认今天' },
        days: { type: 'number', description: '从 date 起往前共查几天（默认 1，最大 90）' },
        query: { type: 'string', description: '可选关键词过滤（匹配标题/内容/项目名）' },
        summary: { type: 'string', description: '用简体中文简述要查什么日志，20字以内' },
      },
    },
  },
];

export const WORKLOG_TOOL_NAMES = new Set(['worklog_search']);

export async function executeWorklogTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name !== 'worklog_search') throw new Error(`Unknown worklog tool: ${name}`);
  const date = String(args.date || '').trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date 格式应为 YYYY-MM-DD');
  const days = Number(args.days) || 1;
  const query = String(args.query || '').trim().toLowerCase();
  let logs = listWorkLogs({ ...(date ? { day: date } : {}), days, limit: 300 });
  if (query) {
    logs = logs.filter((l) => `${l.title} ${l.content} ${l.workspace}`.toLowerCase().includes(query));
  }
  if (!logs.length) return '（这个范围没有工作日志）';
  const proj = (ws: string) => {
    if (!ws) return '（无项目）';
    const segs = ws.split('/').filter(Boolean);
    return segs[segs.length - 1] || ws;
  };
  return logs.map((l) =>
    `[${l.day} ${new Date(l.createdAt).toTimeString().slice(0, 5)}] ${proj(l.workspace)}｜${l.title}\n${l.content}`,
  ).join('\n\n');
}
