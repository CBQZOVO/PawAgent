// 系统连接（Connections）：把外部系统登记成一条"连接"，Agent 通过 call_api 调它的接口。
//
// 核心只保留通用 HTTP 连接（none / bearer / header / basic / query），
// 专有签名协议与页面 SSO（如外部插件）通过 registerConnectionAuthProvider /
// registerConnectionSsoProvider 注册接入。
//
// 安全边界：
//   - 模型拿不到 secret（存 ~/.paw/secrets.json，0600），只有服务端在发请求的那一刻注入
//   - path 只能是相对路径，解析后 origin 必须等于 baseUrl 的 origin（防 SSRF 跳站）
//   - 响应超过 16k 字符截断，避免把上下文一次性撑爆
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const FILE = path.join(DATA_DIR, 'connections.json');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

export type AuthType = 'none' | 'bearer' | 'header' | 'basic' | 'query';

/** 连接类型：默认 http，外部插件可注册自定义类型（如 gscloud 等） */
export type ConnectionKind = string;

export interface ConnectionSso {
  type: string;
  [key: string]: unknown;
}

export interface Connection {
  /** 模型用它指定连接；小写字母/数字/下划线/短横线 */
  code: string;
  /** 连接类型，缺省 http */
  kind?: ConnectionKind;
  name: string;
  /** 必须以 http:// 或 https:// 开头，path 只能挂在这个 origin 下 */
  baseUrl: string;
  description?: string;
  auth: {
    type: AuthType;
    /** header / query 认证时的字段名，如 X-API-Key、api_key */
    name?: string;
  };
  /** 可选页面 SSO 配置（由外部插件提供） */
  sso?: ConnectionSso;
  /** 固定附加的请求头（非敏感；敏感值走 secret） */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 允许插件透传保存自定义配置块（如特定协议的配置对象），禁用插件时不丢失用户配置 */
  [key: string]: unknown;
}

/** 给前端的视图：不含任何密钥，只告诉它有没有设 */
export interface ConnectionView extends Connection {
  hasSecret: boolean;
  lastCall?: LastCall;
}

export interface LastCall {
  at: number;
  method: string;
  path: string;
  status: number;
  ms: number;
  ok: boolean;
}

export interface ProviderFieldSchema {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
}

export interface ConnectionAuthProviderView {
  kind: string;
  label: string;
  configKey: string;
  badgeSigned?: string;
  badgeUnsigned?: string;
  tagSigned?: string;
  tagUnsigned?: string;
  secretLabel?: string;
  secretHint?: string;
  secretPlaceholder?: string;
  secretOptional?: boolean;
  defaultHeaders?: Array<{ key: string; value: string }>;
  autoHeaders?: string[];
  fields?: ProviderFieldSchema[];
}

export interface ConnectionAuthContext {
  conn: Connection;
  url: URL;
  method: string;
  body: string | Uint8Array;
  headers: Record<string, string>;
  secret: string | null;
  setHeader(name: string, value: string): void;
  deleteHeader(name: string): void;
}

export interface ConnectionAuthProvider extends ConnectionAuthProviderView {
  promptHint?: string;
  normalize?(conn: Connection): void;
  applyAuth(ctx: ConnectionAuthContext): Promise<void> | void;
}

export interface ConnectionSsoProviderView {
  type: string;
  label: string;
  fields?: ProviderFieldSchema[];
}

export interface ConnectionSsoProvider extends ConnectionSsoProviderView {
  promptHint?: string;
  normalize?(sso: Record<string, unknown>, code: string): ConnectionSso;

  /** 可选：把业务相对路径换成免密直达 URL（未实现时默认 baseUrl + path） */
  resolveSsoUrl?(ctx: {
    conn: Connection;
    secret: string | null;
    targetPath?: string;
    query?: Record<string, string>;
  }): Promise<{ url: string; partition?: string; title?: string }>;

  /** 可选：为只认 SSO 会话态的接口在转发前补凭据 */
  applySsoAuth?(ctx: ConnectionAuthContext): Promise<void> | void;
}

// ---------------------------------------------------------------- 外部认证/SSO 提供器注册表

const authProviders = new Map<string, ConnectionAuthProvider>();
const ssoProviders = new Map<string, ConnectionSsoProvider>();

export function registerConnectionAuthProvider(provider: ConnectionAuthProvider): void {
  const kind = String(provider.kind || '').trim().toLowerCase();
  if (!kind || kind === 'http') throw new Error(`无效的连接认证提供器类型：${provider.kind}`);
  authProviders.set(kind, { ...provider, kind, configKey: provider.configKey || kind });
}

export function unregisterConnectionAuthProvider(kind: string): boolean {
  return authProviders.delete(String(kind || '').trim().toLowerCase());
}

export function getConnectionAuthProvider(kind?: string): ConnectionAuthProvider | undefined {
  if (!kind || kind === 'http') return undefined;
  return authProviders.get(kind.toLowerCase());
}

export function listConnectionAuthProviderViews(): ConnectionAuthProviderView[] {
  return [...authProviders.values()].map((p) => ({
    kind: p.kind,
    label: p.label,
    configKey: p.configKey,
    badgeSigned: p.badgeSigned,
    badgeUnsigned: p.badgeUnsigned,
    tagSigned: p.tagSigned,
    tagUnsigned: p.tagUnsigned,
    secretLabel: p.secretLabel,
    secretHint: p.secretHint,
    secretPlaceholder: p.secretPlaceholder,
    secretOptional: p.secretOptional,
    defaultHeaders: p.defaultHeaders,
    autoHeaders: p.autoHeaders,
    fields: p.fields,
  }));
}

export function registerConnectionSsoProvider(provider: ConnectionSsoProvider): void {
  const type = String(provider.type || '').trim();
  if (!type) throw new Error('无效的 SSO 提供器类型');
  ssoProviders.set(type, { ...provider, type });
}

export function unregisterConnectionSsoProvider(type: string): boolean {
  return ssoProviders.delete(String(type || '').trim());
}

export function getConnectionSsoProvider(type?: string): ConnectionSsoProvider | undefined {
  if (!type) return undefined;
  return ssoProviders.get(type);
}

export function listConnectionSsoProviderViews(): ConnectionSsoProviderView[] {
  return [...ssoProviders.values()].map((p) => ({
    type: p.type,
    label: p.label,
    fields: p.fields,
  }));
}

// ---------------------------------------------------------------- 读写

const lastCalls = new Map<string, LastCall>();
const SECRET_FILE_MODE = 0o600;
const RESERVED_CONN_KEYS = new Set([
  'code', 'kind', 'name', 'baseUrl', 'description', 'auth', 'sso', 'headers', 'timeoutMs',
  'hasSecret', 'lastCall',
]);

function normalizeSso(raw: unknown, code: string): ConnectionSso | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const type = String(s.type ?? '').trim();
  if (!type) return undefined;
  const provider = ssoProviders.get(type);
  if (provider?.normalize) return provider.normalize(s, code);
  // 对应插件未加载时透传保留，避免覆盖丢失用户已有配置
  return { ...s, type };
}

/** 编码校验：模型会把它当 enum 用，太宽松会有歧义 */
export function normalizeCode(code: unknown): string {
  const s = String(code ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(s)) {
    throw new Error('连接编码只能用小写字母开头 + 字母/数字/下划线/短横线（最长 41 字符）');
  }
  return s;
}

function normalize(c: Partial<Connection>): Connection {
  const code = normalizeCode(c.code);
  const baseUrl = String(c.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/i.test(baseUrl)) throw new Error(`连接 ${code} 的 baseUrl 必须是 http:// 或 https:// 开头的完整地址`);
  const name = String(c.name ?? '').trim() || code;
  const kind: ConnectionKind = String(c.kind ?? 'http').trim().toLowerCase() || 'http';

  const headers = c.headers && typeof c.headers === 'object'
    ? Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [String(k), String(v)]).filter(([k]) => !!k))
    : undefined;

  const authType = (c.auth?.type ?? 'none') as AuthType;
  if (!['none', 'bearer', 'header', 'basic', 'query'].includes(authType)) {
    throw new Error(`连接 ${code} 的认证方式不认识：${authType}`);
  }
  const authName = c.auth?.name ? String(c.auth.name).trim() : undefined;
  if (kind === 'http' && (authType === 'header' || authType === 'query') && !authName) {
    throw new Error(`连接 ${code} 选了 ${authType} 认证，必须填字段名（请求头名或查询参数名）`);
  }

  // 透传插件扩展字段（如 gscloud 等），不因插件暂时未安装而抹掉配置
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (!RESERVED_CONN_KEYS.has(k) && v !== undefined) extras[k] = v;
  }

  const normalized: Connection = {
    ...extras,
    code,
    kind,
    name,
    baseUrl,
    description: c.description ? String(c.description).trim() : undefined,
    auth: { type: kind === 'http' ? authType : 'none', name: kind === 'http' ? authName : undefined },
    sso: normalizeSso(c.sso, code),
    headers,
    timeoutMs: Math.min(120000, Math.max(1000, Number(c.timeoutMs) || 30000)),
  };

  if (kind !== 'http') {
    const provider = authProviders.get(kind);
    provider?.normalize?.(normalized);
  }
  return normalized;
}

/** 读全部连接（坏条目跳过并在日志里说一声，不要因为一条配置写错就整个用不了） */
export function loadConnections(): Connection[] {
  if (!existsSync(FILE)) return [];
  try {
    const d = JSON.parse(readFileSync(FILE, 'utf-8')) as { connections?: unknown };
    const arr = Array.isArray(d.connections) ? d.connections : [];
    const out: Connection[] = [];
    for (const raw of arr) {
      try { out.push(normalize(raw as Partial<Connection>)); }
      catch (e) { console.warn(`[conn] 跳过无效连接：${(e as Error).message}`); }
    }
    return out;
  } catch (e) {
    console.warn(`[conn] 读 ${FILE} 失败：${(e as Error).message}`);
    return [];
  }
}

/** 整体写回（先写临时文件再 rename，避免写一半断电留下半截 JSON） */
export function saveConnections(list: Connection[]): Connection[] {
  const normalized = list.map(normalize);
  const codes = new Set<string>();
  for (const c of normalized) {
    if (codes.has(c.code)) throw new Error(`连接编码重复：${c.code}`);
    codes.add(c.code);
  }
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ connections: normalized }, null, 2), { encoding: 'utf-8', mode: SECRET_FILE_MODE });
  renameSync(tmp, FILE);
  return normalized;
}

export function getConnection(code: string): Connection | undefined {
  return loadConnections().find((c) => c.code === code);
}

// ---------------------------------------------------------------- 凭据

function fileSecrets(): Record<string, string> {
  try {
    if (!existsSync(SECRETS_FILE)) return {};
    return JSON.parse(readFileSync(SECRETS_FILE, 'utf-8')) as Record<string, string>;
  } catch { return {}; }
}

function fileSecretWrite(code: string, secret: string | null): void {
  const all = fileSecrets();
  if (secret === null) delete all[code];
  else all[code] = secret;
  writeFileSync(SECRETS_FILE, JSON.stringify(all, null, 2), { encoding: 'utf-8', mode: SECRET_FILE_MODE });
  try { chmodSync(SECRETS_FILE, SECRET_FILE_MODE); } catch { /* ignore */ }
}

export async function getSecret(code: string): Promise<string | null> {
  return fileSecrets()[code] ?? null;
}

/** secret=null 表示删除；undefined 表示不改动 */
export async function setSecret(code: string, secret: string | null | undefined): Promise<void> {
  if (secret === undefined) return;
  fileSecretWrite(code, secret === null ? null : secret);
}

export async function hasSecret(code: string): Promise<boolean> {
  return !!fileSecrets()[code];
}

/** 防止 body_file 把本地凭据文件外发出去 */
export function isSecretsFile(absPath: string): boolean {
  const target = path.resolve(absPath);
  const secret = path.resolve(SECRETS_FILE);
  if (target === secret) return true;
  try {
    return existsSync(secret) && existsSync(target) && realpathSync(target) === realpathSync(secret);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 调用

export interface CallOptions {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** 附加请求头，仅允许非敏感头（Authorization / Host 一律由服务端控制） */
  headers?: Record<string, string>;
}

const MAX_CHARS = 16000;

function buildUrl(conn: Connection, p: string, query?: Record<string, unknown>): URL {
  const raw = String(p ?? '/').trim();
  if (/^[a-z]+:\/\//i.test(raw)) throw new Error('path 必须是相对路径，不能带协议（目标地址已由连接固定）');
  if (raw.startsWith('//')) throw new Error('path 不能以 // 开头');
  const base = new URL(conn.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const rest = raw.replace(/^\/+/, '');

  const prefix = basePath.slice(1);
  const alreadyPrefixed = !!prefix && (rest === prefix || rest.startsWith(prefix + '/'));
  const url = alreadyPrefixed
    ? new URL('/' + rest, base.origin)
    : new URL(basePath + '/' + rest, base.origin);
  if (url.origin !== base.origin) throw new Error('path 越出了连接配置的域名');
  if (basePath && !url.pathname.startsWith(basePath === '/' ? '/' : basePath + '/')) {
    throw new Error(`path 越出了连接的路径前缀 ${basePath}`);
  }
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return url;
}

function authHeaders(conn: Connection, secret: string | null): Record<string, string> {
  const h: Record<string, string> = {};
  if (!secret || conn.auth.type === 'none') return h;
  if (conn.auth.type === 'bearer') h.Authorization = `Bearer ${secret}`;
  else if (conn.auth.type === 'header') h[conn.auth.name!] = secret;
  else if (conn.auth.type === 'basic') h.Authorization = `Basic ${Buffer.from(secret).toString('base64')}`;
  return h;
}

export interface CallResult {
  ok: boolean;
  status: number;
  ms: number;
  text: string;
  truncated: boolean;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
  }
  headers[name] = value;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
  }
}

async function applyAuth(
  conn: Connection,
  url: URL,
  method: string,
  body: string | Uint8Array,
  headers: Record<string, string>,
): Promise<void> {
  const secret = await getSecret(conn.code);
  const kind = conn.kind || 'http';
  if (kind !== 'http') {
    const provider = authProviders.get(kind);
    if (!provider) {
      throw new Error(`连接 ${conn.code} 的类型 "${kind}" 需要安装并启用对应的外部插件`);
    }
    await provider.applyAuth({
      conn,
      url,
      method,
      body,
      headers,
      secret,
      setHeader: (name, value) => setHeader(headers, name, value),
      deleteHeader: (name) => deleteHeader(headers, name),
    });
  } else {
    for (const [k, v] of Object.entries(authHeaders(conn, secret))) setHeader(headers, k, v);
    if (conn.auth.type === 'query' && conn.auth.name && secret) {
      url.searchParams.set(conn.auth.name, secret);
    }
  }
  // 通用认证之后、发请求之前给外置 SSO 插件一次补凭据的机会；没装插件就什么都不做
  const sso = conn.sso ? ssoProviders.get(conn.sso.type) : undefined;
  if (sso?.applySsoAuth) {
    await sso.applySsoAuth({
      conn, url, method, body, headers, secret,
      setHeader: (name, value) => setHeader(headers, name, value),
      deleteHeader: (name) => deleteHeader(headers, name),
    });
  }
}

interface PreparedConnectionRequest {
  conn: Connection;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  displayUrl: string;
}

async function prepareConnectionRequest(code: string, opts: CallOptions): Promise<PreparedConnectionRequest> {
  const conn = getConnection(code);
  if (!conn) {
    const all = loadConnections().map((c) => c.code).join(', ');
    throw new Error(`没有这个连接：${code}${all ? `（可用：${all}）` : '（还没配任何连接）'}`);
  }
  const method = String(opts.method || 'GET').toUpperCase();
  if (!(ALLOWED_METHODS as readonly string[]).includes(method)) {
    throw new Error(`不支持的 HTTP 方法 ${method}，可用：GET / POST / PUT / PATCH / DELETE`);
  }
  const url = buildUrl(conn, opts.path, opts.query);

  const headers: Record<string, string> = {};
  setHeader(headers, 'Accept', 'application/json, text/plain, */*');
  for (const [k, v] of Object.entries(conn.headers || {})) setHeader(headers, k, v);
  for (const [k, v] of Object.entries(opts.headers || {})) {
    if (/^(authorization|host|content-length|cookie)$/i.test(k)) continue;
    setHeader(headers, k, String(v));
  }
  let body: string | Uint8Array | undefined;
  if (opts.body !== undefined && opts.body !== null && method !== 'GET' && method !== 'HEAD') {
    if (opts.body instanceof Uint8Array) {
      body = opts.body;
      if (!hasHeader(headers, 'Content-Type')) setHeader(headers, 'Content-Type', 'application/octet-stream');
    } else if (typeof opts.body === 'string') {
      body = opts.body;
      if (!hasHeader(headers, 'Content-Type')) setHeader(headers, 'Content-Type', 'application/json');
    } else {
      body = JSON.stringify(opts.body);
      if (!hasHeader(headers, 'Content-Type')) setHeader(headers, 'Content-Type', 'application/json');
    }
  }

  await applyAuth(conn, url, method, body ?? '', headers);
  return { conn, method, url, headers, body, displayUrl: `${conn.baseUrl}${url.pathname}` };
}

/** 原始响应：保留状态码 / Content-Type / 二进制，不做 16k 截断（部件下载与预览走这条） */
export interface RawConnectionResponse {
  ok: boolean;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  ms: number;
  timedOut: boolean;
}

const RAW_MAX_BYTES = 20 * 1024 * 1024;

export async function fetchConnectionRaw(code: string, opts: CallOptions, signal?: AbortSignal): Promise<RawConnectionResponse> {
  const p = await prepareConnectionRequest(code, opts);
  const timeout = AbortSignal.timeout(p.conn.timeoutMs || 30000);
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(p.url, { method: p.method, headers: p.headers, body: p.body as BodyInit | undefined, signal: composed, redirect: 'follow' });
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? `请求超时（${p.conn.timeoutMs}ms）` : (e as Error).message;
    throw new Error(`${p.method} ${p.displayUrl} 失败：${msg}`);
  }

  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let timedOut = false;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        received += value.byteLength;
        if (received >= RAW_MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
      }
    } catch (e) {
      if ((e as Error).name === 'TimeoutError' && received > 0) timedOut = true;
      else throw e;
    }
  }
  const ms = Date.now() - started;
  lastCalls.set(code, { at: Date.now(), method: p.method, path: p.url.pathname + p.url.search, status: res.status, ms, ok: res.ok });
  console.log(`[conn] ${p.method} ${code}${p.url.pathname} → ${res.status} ${ms}ms`);
  return {
    ok: res.ok,
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    bytes: Buffer.concat(chunks.map((c) => Buffer.from(c))),
    ms,
    timedOut,
  };
}

export async function callConnection(code: string, opts: CallOptions, signal?: AbortSignal): Promise<CallResult> {
  const rawRes = await fetchConnectionRaw(code, opts, signal);
  const raw = Buffer.from(rawRes.bytes).toString('utf-8');
  const truncated = raw.length > MAX_CHARS;
  let text = truncated ? raw.slice(0, MAX_CHARS) + `\n…[响应过长，已截断；完整 ${raw.length} 字符]` : raw;
  if (rawRes.timedOut) text += `\n…[流式响应读取超时，已返回已收到的 ${rawRes.bytes.byteLength} 字节]`;
  return { ok: rawRes.ok, status: rawRes.status, ms: rawRes.ms, text, truncated };
}

/** 业务页面 URL：无 SSO 插件时安全拼接 baseUrl + path；有插件且实现 resolveSsoUrl 时走换票 */
export async function resolveBusinessPageUrl(
  code: string,
  opts: { path?: string; query?: Record<string, string>; title?: string },
): Promise<{ url: string; partition: string; title?: string }> {
  const conn = getConnection(code);
  if (!conn) throw new Error(`没有这个连接：${code}`);
  const targetPath = opts.path && opts.path !== '/' ? opts.path : '/';
  const fallback = buildUrl(conn, targetPath, opts.query).toString();
  const sso = conn.sso ? ssoProviders.get(conn.sso.type) : undefined;
  if (!sso?.resolveSsoUrl) {
    return { url: fallback, partition: `persist:conn-${code}`, title: opts.title };
  }
  const resolved = await sso.resolveSsoUrl({
    conn, secret: await getSecret(code), targetPath, query: opts.query,
  });
  const url = new URL(resolved.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('SSO 插件返回了非 http(s) 地址');
  return {
    url: url.toString(),
    partition: resolved.partition || `persist:conn-${code}`,
    title: resolved.title || opts.title,
  };
}

function formatSnippet(raw: string, contentType: string | null): string {
  const text = raw.trim();
  if (!text) return '';
  const looksJson = /json/i.test(contentType || '') || /^[[{]/.test(text);
  if (looksJson) {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      return pretty.length > 1600 ? pretty.slice(0, 1600) + '\n…（已截断）' : pretty;
    } catch { /* fall through */ }
  }
  return raw.length > 800 ? raw.slice(0, 800) + '…' : raw;
}

export interface TestOptions {
  path?: string;
  method?: string;
  body?: unknown;
}

export interface TestResult {
  ok: boolean;
  reachable: boolean;
  status: number;
  ms: number;
  message: string;
  path: string;
  method: string;
  snippet?: string;
}

export async function testConnection(code: string, opts: TestOptions = {}): Promise<TestResult> {
  const conn = getConnection(code);
  if (!conn) throw new Error(`没有这个连接：${code}`);

  const method = String(opts.method || 'GET').toUpperCase();
  if (!(ALLOWED_METHODS as readonly string[]).includes(method)) {
    throw new Error(`不支持的 HTTP 方法 ${method}，可用：GET / POST / PUT / PATCH / DELETE`);
  }

  let rawPath = String(opts.path ?? '').trim();
  if (/^https?:\/\//i.test(rawPath)) {
    const u = new URL(rawPath);
    const base = new URL(conn.baseUrl);
    if (u.origin !== base.origin) {
      throw new Error(`只能填相对路径：${u.origin} 和连接地址 ${base.origin} 不是同一个域`);
    }
    rawPath = u.pathname + u.search;
  }

  let url: URL;
  try {
    url = rawPath ? buildUrl(conn, rawPath) : new URL(conn.baseUrl);
  } catch (e) {
    throw new Error(`${(e as Error).message}（当前连接地址是 ${conn.baseUrl}）`);
  }

  let body = '';
  if (opts.body !== undefined && opts.body !== null && method !== 'GET' && method !== 'HEAD') {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }

  const headers: Record<string, string> = {};
  setHeader(headers, 'Accept', 'application/json, text/plain, */*');
  for (const [k, v] of Object.entries(conn.headers || {})) setHeader(headers, k, v);
  if (body && !hasHeader(headers, 'Content-Type')) setHeader(headers, 'Content-Type', 'application/json');
  await applyAuth(conn, url, method, body, headers);

  const started = Date.now();
  const shownPath = url.pathname + url.search;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body || undefined,
      signal: AbortSignal.timeout(Math.min(20000, conn.timeoutMs || 15000)),
      redirect: 'follow',
    });
    const ms = Date.now() - started;
    const raw = await res.text().catch(() => '');
    const snippet = formatSnippet(raw, res.headers.get('content-type'));

    let hint = '';
    if (res.status === 401 || res.status === 403) hint = '（能连上，凭据或签名不对）';
    else if (res.status === 404) hint = '（能连上，路径可能不对）';
    else if (res.status === 405) hint = `（能连上，这个路径可能不接受 ${method}）`;
    else if (res.status >= 500) hint = '（能连上，服务端自己报错了）';

    return {
      ok: res.ok,
      reachable: true,
      status: res.status,
      ms,
      message: `HTTP ${res.status} · ${ms}ms${hint}`,
      path: shownPath,
      method,
      snippet: snippet || undefined,
    };
  } catch (e) {
    const err = e as Error;
    const msg = err.name === 'TimeoutError'
      ? `请求超时（${Math.min(20000, conn.timeoutMs || 15000)}ms）`
      : err.message;
    return {
      ok: false,
      reachable: false,
      status: 0,
      ms: Date.now() - started,
      message: `${method} ${url.origin}${shownPath} 失败：${msg}`,
      path: shownPath,
      method,
    };
  }
}

export async function listConnectionViews(): Promise<ConnectionView[]> {
  const list = loadConnections();
  return Promise.all(list.map(async (c) => ({
    ...c,
    hasSecret: await hasSecret(c.code),
    lastCall: lastCalls.get(c.code),
  })));
}

export function connectionCatalogText(): string {
  const list = loadConnections();
  if (!list.length) return '';
  return list.map((c) => {
    const provider = getConnectionAuthProvider(c.kind);
    const kindTag = provider ? `【${provider.tagUnsigned || provider.kind}】` : '';
    const ssoTag = c.sso && getConnectionSsoProvider(c.sso.type) ? '【可打开业务页面】' : '';
    const parts = [`- \`${c.code}\`（${c.name}）${kindTag}${ssoTag}`];
    if (c.description) parts.push(`：${c.description}`);
    return parts.join('');
  }).join('\n');
}
