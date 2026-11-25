// call_api 工具：让模型调用「系统连接」里登记的外部 HTTP 接口。
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolSchema } from '@paw/shared';
import type { ToolContext } from './index.js';
import { callConnection, connectionCatalogText, isSecretsFile, loadConnections } from '../connections.js';
import { resolveToolPath } from '../workspace.js';

const MAX_BODY_FILE_BYTES = 50 * 1024 * 1024;
const TEXT_BODY_EXTS = new Set(['.json', '.ndjson', '.jsonl', '.txt', '.xml', '.csv', '.html', '.md', '.yaml', '.yml']);

/** 没配任何连接就不注册这个工具（少一个 schema，少一份干扰） */
export function callApiSchema(): ToolSchema | null {
  const conns = loadConnections();
  if (!conns.length) return null;
  const codes = conns.map((c) => c.code);
  return {
    name: 'call_api',
    description: [
      'Call an HTTP API on one of the user\'s registered system connections (internal/company services).',
      'Credentials are injected by the app — you never see or pass tokens.',
      '',
      'Available connections:',
      connectionCatalogText(),
      '',
      'Rules:',
      '- `path` is relative to the connection base URL, e.g. "/api/users" or "v1/orders". Never pass a full URL.',
      '- GET / POST / PUT / PATCH / DELETE are all allowed. Use a write method only when the user actually asked to change something; if unsure, read first.',
      '- Use `headers` for custom request headers such as `{"Accept": "text/event-stream"}` on SSE endpoints or custom `Content-Type`.',
      '- For large request bodies (e.g. file contents, byte arrays, big JSON), write the payload to a local file first and pass its path in `body_file` instead of `body`.',
      '- Use web_fetch for public pages; use call_api only for the connections above.',
      '- Large responses are truncated. Prefer narrow filters in `query` over downloading a whole table.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', enum: codes, description: 'Connection code (from the list above)' },
        method: { type: 'string', description: 'HTTP method: GET (default) / POST / PUT / PATCH / DELETE' },
        path: { type: 'string', description: 'Relative path under the connection base URL, e.g. /api/users' },
        query: { type: 'object', description: 'Optional query string parameters (flat key → value)' },
        headers: { type: 'object', description: 'Optional extra request headers (flat key → string), e.g. {"Accept": "text/event-stream"} for SSE endpoints. Sensitive headers (Authorization/Host/Cookie/Content-Length) are ignored.' },
        body: { description: 'Optional request body. An object is sent as JSON. Mutually exclusive with body_file.' },
        body_file: { type: 'string', description: 'Optional path to a local file (absolute or relative to workspace) to send as the request body. Use this for large payloads (e.g. fileContent byte arrays, large JSON, binary uploads). Mutually exclusive with body.' },
        summary: { type: 'string', description: '用简体中文简述这次调用的目的，20字以内' },
      },
      required: ['connection', 'path'],
    },
  };
}

function looksLikeJsonBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 1024));
  if (sample.includes(0)) return false;
  const trimmed = sample.toString('utf-8').trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

async function loadBodyFromFile(
  rawPath: string,
  workspace: string | null | undefined,
  headers: Record<string, string> | undefined,
): Promise<{ body: string | Buffer; inferredContentType?: string }> {
  const abs = await resolveToolPath(rawPath, workspace);
  if (isSecretsFile(abs)) throw new Error('不允许通过 body_file 发送凭据文件');
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`body_file 不存在或不是文件：${rawPath}`);
  if (st.size > MAX_BODY_FILE_BYTES) {
    throw new Error(`body_file 超过 ${(MAX_BODY_FILE_BYTES / 1024 / 1024).toFixed(0)}MB 上限（当前 ${(st.size / 1024 / 1024).toFixed(1)}MB）`);
  }
  const buf = await readFile(abs);
  const explicitCt = headers
    ? Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1]
    : undefined;
  const ext = path.extname(abs).toLowerCase();
  const isTextByCt = !!explicitCt && /json|text\/|xml|javascript|x-www-form-urlencoded/i.test(explicitCt);
  const isTextByExt = TEXT_BODY_EXTS.has(ext);
  const isJsonHeuristic = !explicitCt && !isTextByExt && looksLikeJsonBuffer(buf);

  if (isTextByCt || isTextByExt || isJsonHeuristic) {
    let inferredContentType: string | undefined;
    if (!explicitCt) {
      if (ext === '.xml') inferredContentType = 'application/xml; charset=utf-8';
      else if (ext === '.html') inferredContentType = 'text/html; charset=utf-8';
      else if (ext === '.txt' || ext === '.csv' || ext === '.md' || ext === '.yaml' || ext === '.yml') {
        inferredContentType = 'text/plain; charset=utf-8';
      }
    }
    return { body: buf.toString('utf-8'), inferredContentType };
  }
  return { body: buf };
}

export async function executeCallApi(args: Record<string, unknown>, ctx: ToolContext = {}): Promise<string> {
  const code = String(args.connection ?? '').trim();
  if (!code) throw new Error('缺少 connection（要用哪个连接）');
  const method = String(args.method || 'GET').toUpperCase();
  const p = String(args.path ?? '/');
  const query = args.query && typeof args.query === 'object' && !Array.isArray(args.query)
    ? args.query as Record<string, unknown>
    : undefined;

  let headers: Record<string, string> | undefined;
  if (args.headers !== undefined && args.headers !== null) {
    if (typeof args.headers !== 'object' || Array.isArray(args.headers)) {
      throw new Error('headers 必须是键值对对象，例如 {"Accept": "text/event-stream"}');
    }
    headers = Object.fromEntries(
      Object.entries(args.headers as Record<string, unknown>)
        .filter(([k, v]) => k && v !== undefined && v !== null)
        .map(([k, v]) => [k, String(v)]),
    );
  }

  let body: unknown = args.body;
  const bodyFile = typeof args.body_file === 'string' ? args.body_file.trim() : '';
  if (bodyFile) {
    if (args.body !== undefined && args.body !== null) {
      throw new Error('body 和 body_file 不能同时传入，请二选一');
    }
    const loaded = await loadBodyFromFile(bodyFile, ctx.workspace, headers);
    body = loaded.body;
    if (loaded.inferredContentType) {
      headers = { ...headers, 'Content-Type': loaded.inferredContentType };
    }
  }

  const r = await callConnection(code, { method, path: p, query, headers, body }, ctx.signal);
  const head = `${method} ${code}${p} → ${r.status} · ${r.ms}ms`;
  const respBody = r.text || '（空响应体）';
  if (!r.ok) throw new Error(`${head}\n\n${respBody}`);
  return `${head}\n\n${respBody}`;
}
