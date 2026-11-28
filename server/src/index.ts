// Paw 后端入口：Hono + SSE。
// POST /api/chat 收 messages，流式返回 AgentEvent。
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import {
  canSeeImages, messageText, normalizeMessage,
  type BtwRequest, type ChatRequest, type PermissionDecision, type ScheduledTask,
  type Session, type SessionPermission, type SessionSummary, type TurnTrace, type TurnTraceTool,
} from '@paw/shared';
import { deleteMemoryById, findMemoryByTitle, listMemories, upsertMemoryDirect } from './tools/memory.js';
import { deleteWorkLog, listWorkLogs, updateWorkLog } from './tools/worklog.js';
import { reflectTurn } from './reflection.js';
import {
  addContextSample, clearSessions, deleteSession, getContextReading, getContextSamples,
  getSession, getSessionUsage, listSessionSummaries, listTurnTraces, parseSessionPermission,
  searchSessions, updateSessionPermission, upsertSession, upsertSessions, upsertTurnTrace,
} from './db.js';
import { isConversationHistory, prepareSessionContext } from './agent/session-context.js';
import { generateHandoffBrief } from './agent/handoff.js';
import { loadPersonaPrompt } from './persona.js';
import { runAgent } from './agent/loop.js';
import { cancelPendingApprovals, createSessionAuthorizer, detectPermissionConflicts, hasPendingApproval, loadGlobalAllow, resolveApproval, saveGlobalAllow } from './agent/permission.js';
import type { GatewayConfig } from './gateway/client.js';
import { loadSkillContent, loadSkills, SKILLS_DIR } from './skills.js';
import {
  deleteMcpServer, importMcpServers, initMcp, mcpServerNames, mcpServerViews, mcpToolSchemas,
  reconnectMcpServer, reloadMcp, upsertMcpServer, type McpServerConfig,
} from './mcp.js';
import {
  getConnectionAuthProvider,
  getConnectionSsoProvider,
  listConnectionAuthProviderViews,
  listConnectionSsoProviderViews,
  listConnectionViews,
  fetchConnectionRaw,
  loadConnections,
  normalizeCode,
  resolveBusinessPageUrl,
  saveConnections,
  setSecret,
  testConnection,
  type Connection,
} from './connections.js';
import { getWorkspaceRoot, listWorkspaces, setWorkspaceRoot, removeWorkspace, listWorkspaceCandidates, resolveToolPath } from './workspace.js';
import { friendlyGatewayError } from './gateway/client.js';
import {
  getPluginInventory,
  getPluginRouter,
  getPluginsDir,
  getWidgetInventory,
  loadExternalPlugins,
  reloadExternalPlugins,
  updateExternalPlugin,
} from './plugins/index.js';
import { configureTools, executeTool, getAllToolSchemas } from './tools/index.js';
import { killAllJobs, jobViews, killJobById } from './tools/background.js';
import { listTree, readWorkspaceFile, readWorkspaceImage, writeWorkspaceFile } from './fs-api.js';
import { attachTerminal, terminalInfo } from './terminal.js';
import { isImageModel } from './tools/image-gen.js';
import { describeImage } from './vision.js';
import { addRun, deleteTask, getTask, listRuns, listTasks, touchTask, upsertTask } from './db.js';
import { composeChatMessages } from './chat-input.js';
import { listSessionAttachments, persistAttachments } from './attachments.js';
import { generateTitle } from './title.js';
import {
  clearSnapshots, deleteSnapshots, forkSnapshotRecords,
  getLatestSnapshotTs, revertWorkspaceTo, rollbackAfter, switchSessionWorkspace,
} from './snapshots.js';
import { runTask, startScheduler } from './scheduler.js';
import { loadSearchConfig, saveSearchProvider, type SearchProviderName } from './tools/web-search.js';
import { DATA_DIR } from './paths.js';
import { notifyDone } from './notify.js';
import { buildPreviewUrl, getOfficeDownloadProgress, getOfficeStatus, installOfficeEngine } from './office-engine.js';

const DEFAULT_GATEWAY_URL = 'https://api.inspurai.cc';
// 网关配置（GATEWAY_URL / GATEWAY_KEY）统一存于 ~/.paw/gateway-config.json（0600 权限）
const GATEWAY_CONFIG_FILE = path.join(DATA_DIR, 'gateway-config.json');

interface GatewayFileConfig {
  GATEWAY_URL?: string;
  baseUrl?: string;
  GATEWAY_KEY?: string;
  apiKey?: string;
  [key: string]: unknown;
}

async function readGatewayFileConfig(): Promise<GatewayFileConfig> {
  try {
    const raw = JSON.parse(await readFile(GATEWAY_CONFIG_FILE, 'utf-8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as GatewayFileConfig) : {};
  } catch {
    return {};
  }
}

async function saveGatewayConfigToFile(patch: { apiKey: string; baseUrl?: string }): Promise<void> {
  const prev = await readGatewayFileConfig();
  const next: GatewayFileConfig = { ...prev, GATEWAY_KEY: patch.apiKey };
  if (patch.baseUrl) next.GATEWAY_URL = patch.baseUrl;
  await mkdir(path.dirname(GATEWAY_CONFIG_FILE), { recursive: true });
  await writeFile(GATEWAY_CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await chmod(GATEWAY_CONFIG_FILE, 0o600).catch(() => undefined);
}

async function verifyGatewayCredentials(baseUrl: string, apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: `登录失败（HTTP ${r.status}）：Key 无效或与当前网关不匹配` };
    }
    return { ok: false, error: `网关返回异常（HTTP ${r.status}）` };
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? '连接超时' : (e as Error).message;
    return { ok: false, error: `无法连接网关（${baseUrl}）：${msg}` };
  }
}

const cleanUrl = (v: unknown) =>
  (typeof v === 'string' ? v.trim().replace(/^['"]|['"]$/g, '').replace(/\/+$/, '') : '');
const cleanKey = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

const fileGatewayCfg = await readGatewayFileConfig();
const cfg: GatewayConfig = {
  baseUrl: cleanUrl(fileGatewayCfg.GATEWAY_URL ?? fileGatewayCfg.baseUrl)
    || cleanUrl(process.env.GATEWAY_URL)
    || DEFAULT_GATEWAY_URL,
  apiKey: cleanKey(fileGatewayCfg.GATEWAY_KEY ?? fileGatewayCfg.apiKey)
    || cleanKey(process.env.GATEWAY_KEY),
  model: process.env.PAW_MODEL || 'qwen4-max',
};
// 不再因缺 key 退出：没 token 时照常启动，前端显示配置页让用户输入（保存到 GATEWAY_CONFIG_FILE）。
if (!cfg.apiKey) console.warn('[paw] 未配置网关 token，等待在页面填写（保存到 ' + GATEWAY_CONFIG_FILE + '）');

configureTools(cfg); // 生图工具走网关
startScheduler(cfg); // 定时任务的分钟级轮询
void initMcp(); // 连接 MCP server（异步，不阻塞启动）

const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true, model: cfg.model, configured: !!cfg.apiKey }));

// 调试日志：UI 事件落盘 /tmp/paw-ui-debug.log（排查 chip/拖拽问题临时加，2026-11-22）
app.post('/api/debug-log', async (c) => {
  try {
    const body = await c.req.json<{ line?: string }>().catch(() => null);
    const line = body?.line;
    if (typeof line === 'string' && line) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync('/tmp/paw-ui-debug.log', `${new Date().toISOString().slice(11, 23)} ${line}\n`);
    }
  } catch { /* 调试日志失败不影响主流程 */ }
  return c.json({ ok: true });
});
// token 配置：前端启动时查状态；提交后先验证再写文件并更新 cfg
app.get('/api/token-status', (c) => c.json({
  configured: !!cfg.apiKey,
  file: GATEWAY_CONFIG_FILE,
  baseUrl: cfg.baseUrl,
}));
app.post('/api/token', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { token?: string; baseUrl?: string };
  const key = typeof body.token === 'string' ? body.token.trim() : '';
  if (!key) return c.json({ ok: false, error: 'GATEWAY_KEY 不能为空' }, 400);

  const customUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : '';
  if (customUrl && !/^https?:\/\/[^/\s]+/i.test(customUrl)) {
    return c.json({ ok: false, error: 'GATEWAY_URL 必须以 http:// 或 https:// 开头' }, 400);
  }
  const targetUrl = customUrl || cfg.baseUrl;

  const check = await verifyGatewayCredentials(targetUrl, key);
  if (!check.ok) {
    return c.json({ ok: false, error: check.error }, 401);
  }

  try {
    await saveGatewayConfigToFile({ apiKey: key, baseUrl: customUrl || undefined });
  } catch (e) {
    return c.json({ ok: false, error: '写入失败：' + (e as Error).message }, 500);
  }
  cfg.baseUrl = targetUrl;
  cfg.apiKey = key;
  configureTools(cfg);
  console.log('[paw] 网关配置已更新（' + GATEWAY_CONFIG_FILE + '）');
  return c.json({ ok: true, configured: true, baseUrl: cfg.baseUrl });
});
// 工作区
app.get('/api/workspace', async (c) => c.json({
  root: await getWorkspaceRoot(),
  workspaces: await listWorkspaces(),
  candidates: await listWorkspaceCandidates(),
}));
app.put('/api/workspace', async (c) => {
  const { root } = await c.req.json() as { root: string | null };
  await setWorkspaceRoot(root);
  return c.json({ ok: true, root });
});
// 从工作区列表移除（不删除磁盘文件）
app.delete('/api/workspace', async (c) => {
  const { root } = await c.req.json() as { root: string };
  await removeWorkspace(root);
  return c.json({ ok: true, root: await getWorkspaceRoot(), workspaces: await listWorkspaces() });
});
// IDE 模式：工作区文件树（单层懒加载）与文件内容（路径限制在工作区内）
app.get('/api/fs/tree', async (c) => {
  const root = c.req.query('root');
  if (!root) return c.json({ error: '缺少 root' }, 400);
  return c.json(await listTree(root, c.req.query('path') || '.', c.req.query('q')));
});
app.get('/api/fs/file', async (c) => {
  const root = c.req.query('root');
  const file = c.req.query('path');
  if (!root || !file) return c.json({ error: '缺少 root/path' }, 400);
  const r = await readWorkspaceFile(root, file);
  return 'error' in r ? c.json(r, 400) : c.json(r);
});
// IDE 编辑器手动保存：写回工作区内文件（路径校验在 writeWorkspaceFile）
app.put('/api/fs/file', async (c) => {
  const { root, path: file, content } = await c.req.json() as { root?: string; path?: string; content?: string };
  if (!root || !file || typeof content !== 'string') return c.json({ error: '缺少 root/path/content' }, 400);
  const r = await writeWorkspaceFile(root, file, content);
  return 'error' in r ? c.json(r, 400) : c.json(r);
});
// Markdown 预览里的图片：返回真实字节 + 正确 MIME（路径同样限制在工作区内）
app.get('/api/fs/raw', async (c) => {
  const root = c.req.query('root');
  const file = c.req.query('path');
  if (!root || !file) return c.json({ error: '缺少 root/path' }, 400);
  const r = await readWorkspaceImage(root, file);
  if ('error' in r) return c.json(r, 400);
  return c.body(new Uint8Array(r.data), 200, {
    'Content-Type': r.mime,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
});
// 批量查询本机产物文件是否存在与大小（用于消息底部产物卡片展示真实字节数并过滤无效路径）
app.post('/api/fs/stat', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { paths?: unknown; root?: string | null };
  const rawPaths = Array.isArray(body.paths)
    ? body.paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).slice(0, 24)
    : [];
  const baseRoot = (typeof body.root === 'string' && body.root.trim()) ? body.root.trim() : await getWorkspaceRoot();
  const items: Record<string, { exists: boolean; size?: number; isDir?: boolean; absPath?: string }> = {};
  await Promise.all(rawPaths.map(async (p) => {
    if (!path.isAbsolute(p) && !baseRoot) {
      items[p] = { exists: false };
      return;
    }
    const abs = path.isAbsolute(p) ? p : path.resolve(baseRoot!, p);
    try {
      const st = await stat(abs);
      items[p] = { exists: true, size: st.size, isDir: st.isDirectory(), absPath: abs };
    } catch {
      items[p] = { exists: false };
    }
  }));
  return c.json({ items });
});
// ---------------------------------------------------------------- 本地 Office 预览（腾讯文档 editor_sdk）
// 懒启动；引擎不随包分发，缺失时只报 needsDownload，由用户确认后再下载。
app.get('/api/office/status', async (c) => {
  const s = await getOfficeStatus();
  return c.json({
    available: s.available,
    port: s.port,
    needsDownload: !!s.needsDownload,
    ...(s.error ? { error: s.error } : {}),
  });
});
// 前端询问用户后显式调用：下载引擎到 ~/.paw/office/ 并启动
app.post('/api/office/download', async (c) => {
  const s = await installOfficeEngine();
  if (!s.available) return c.json({ error: s.error || 'Office 引擎安装失败', port: s.port }, 500);
  return c.json({ available: true, port: s.port });
});
// 下载期间前端轮询这个只读快照显示进度（无副作用，不触发引擎启动）
app.get('/api/office/download/progress', (c) => c.json(getOfficeDownloadProgress()));
app.get('/api/office/preview', async (c) => {
  const raw = c.req.query('path')?.trim();
  if (!raw) return c.json({ error: '缺少 path' }, 400);
  const mode = c.req.query('mode') === 'readonly' ? 'readonly' : 'edit';

  let abs: string;
  try {
    abs = await resolveToolPath(raw);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  try {
    const s = await stat(abs);
    if (!s.isFile()) return c.json({ error: `不是文件：${abs}` }, 400);
  } catch {
    return c.json({ error: `文件不存在：${abs}`, code: 'OFFICE_FILE_NOT_FOUND' }, 404);
  }

  let url: string;
  try {
    url = buildPreviewUrl(abs, mode);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const status = await getOfficeStatus();
  if (!status.available) {
    return c.json({
      error: status.error || 'Office 引擎不可用',
      code: status.needsDownload ? 'OFFICE_ENGINE_MISSING' : 'OFFICE_ENGINE_UNAVAILABLE',
      port: status.port,
    }, 503);
  }
  return c.json({ url });
});

// IDE 终端：默认 shell / 起始目录 / 当前会话数（真正的连接走 /api/terminal 的 WebSocket）
app.get('/api/terminal/info', async (c) => c.json(terminalInfo(c.req.query('cwd') || await getWorkspaceRoot())));
// 弹出系统目录选择框让用户选文件夹（返回选中路径；取消返回 null）
app.post('/api/workspace/pick', async (c) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$d.Description = "选择 Paw 工作区目录"',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
      ].join('; ');
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { timeout: 120000, windowsHide: true });
      return c.json({ root: stdout.trim().replace(/[\\/]+$/, '') || null });
    }
    if (process.platform === 'darwin') {
      const script = [
        'tell application "System Events" to activate',
        'set theFolder to choose folder with prompt "选择 Paw 工作区目录"',
        'return POSIX path of theFolder',
      ].join('\n');
      const { stdout } = await run('osascript', ['-e', script], { timeout: 120000 });
      return c.json({ root: stdout.trim().replace(/\/$/, '') || null });
    }
    return c.json({ root: null });
  } catch {
    return c.json({ root: null }); // 用户取消或失败
  }
});

const mcpSnapshot = () => ({
  servers: mcpServerNames(), // 兼容旧调用方：已连接的名字
  views: mcpServerViews(),   // 所有配置项，含连接失败与可编辑 config
  tools: mcpToolSchemas().map((t) => ({ name: t.name, description: t.description })),
});

app.get('/api/mcp', (c) => c.json(mcpSnapshot()));

app.post('/api/mcp', async (c) => {
  const body = await c.req.json<{ name?: string; config?: Partial<McpServerConfig>; originalName?: string }>().catch(() => null);
  if (!body || !body.config) return c.json({ error: '请求体缺少 name 或 config' }, 400);
  try {
    const view = await upsertMcpServer(body.name || '', body.config, body.originalName);
    return c.json({ ok: true, view, ...mcpSnapshot() });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.delete('/api/mcp/:name', async (c) => {
  try {
    await deleteMcpServer(c.req.param('name'));
    return c.json({ ok: true, ...mcpSnapshot() });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post('/api/mcp/:name/reconnect', async (c) => {
  try {
    const view = await reconnectMcpServer(c.req.param('name'));
    return c.json({ ok: true, view, ...mcpSnapshot() });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post('/api/mcp/import', async (c) => {
  const body = await c.req.json<{ mcpServers?: Record<string, Partial<McpServerConfig>> } | Record<string, Partial<McpServerConfig>>>().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: '请求体必须是合法 JSON 对象' }, 400);
  }
  const map = ('mcpServers' in body && body.mcpServers && typeof body.mcpServers === 'object' && !Array.isArray(body.mcpServers))
    ? (body.mcpServers as Record<string, Partial<McpServerConfig>>)
    : (body as Record<string, Partial<McpServerConfig>>);
  try {
    const imported = await importMcpServers(map);
    return c.json({ ok: true, imported: imported.length, ...mcpSnapshot() });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post('/api/mcp/reload', async (c) => {
  await reloadMcp();
  return c.json({ ok: true, ...mcpSnapshot() });
});

// ---------------------------------------------------------------- 系统连接
// 连接定义落 ~/.paw/connections.json，密钥单独进钥匙串（永远不回传给前端）。
// 模型侧通过 call_api 工具使用，见 server/src/connections.ts。
app.get('/api/connections', async (c) => c.json({
  connections: await listConnectionViews(),
  authProviders: listConnectionAuthProviderViews(),
  ssoProviders: listConnectionSsoProviderViews(),
}));

app.put('/api/connections', async (c) => {
  const body = await c.req.json() as { connections?: Connection[] } | Connection[];
  const list = Array.isArray(body) ? body : body.connections;
  if (!Array.isArray(list)) return c.json({ error: 'connections 必须是数组' }, 400);
  try {
    saveConnections(list);
    return c.json({
      ok: true,
      connections: await listConnectionViews(),
      authProviders: listConnectionAuthProviderViews(),
      ssoProviders: listConnectionSsoProviderViews(),
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

/** 设置或清除某条连接的密钥。空字符串 = 清除。 */
app.post('/api/connections/:code/secret', async (c) => {
  const code = c.req.param('code').toLowerCase();
  if (!loadConnections().some((x) => x.code === code)) return c.json({ error: '连接不存在' }, 404);
  const { secret } = await c.req.json() as { secret?: string };
  const value = typeof secret === 'string' ? secret.trim() : '';
  try {
    if (!value) {
      await setSecret(code, null);
      return c.json({ ok: true, hasSecret: false });
    }
    // 写完回读一次：钥匙串写入失败必须让用户知道，不能假装成功
    await setSecret(code, value);
    const views = await listConnectionViews();
    return c.json({ ok: true, hasSecret: views.find((v) => v.code === code)?.hasSecret ?? false });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.delete('/api/connections/:code', async (c) => {
  const code = c.req.param('code').toLowerCase();
  const rest = loadConnections().filter((x) => x.code !== code);
  try {
    saveConnections(rest);
    await setSecret(code, null); // 连接删了，密钥不能留着
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post('/api/connections/:code/test', async (c) => {
  // body 可选：{ path, method, body } —— 前端连接检测面板会带；老调用不带就探测 baseUrl
  const opts = await c.req.json().catch(() => ({})) as { path?: string; method?: string; body?: unknown };
  try {
    const code = normalizeCode(c.req.param('code'));
    return c.json(await testConnection(code, opts));
  } catch (e) {
    return c.json({ ok: false, reachable: false, status: 0, ms: 0, message: (e as Error).message, path: opts.path || '', method: opts.method || 'GET' });
  }
});

/**
 * 部件请求业务接口的原始代理：复用连接的 baseUrl / 防 SSRF / 密钥注入，
 * 保留状态码与二进制（不做 call_api 的 16k 截断）。
 * 允许使用哪条连接由 WidgetFrame 按卡片绑定值与插件白名单在宿主侧收敛，
 * 这里只做连接本身的安全边界校验。
 */
app.all('/api/connections/:code/proxy/*', async (c) => {
  const code = c.req.param('code').toLowerCase();
  const rawPath = c.req.path.replace(/^\/api\/connections\/[^/]+\/proxy/, '') || '/';
  const method = c.req.method;
  const forwardHeaders: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (/^(authorization|host|content-length|cookie|connection|origin|referer|user-agent|accept-encoding|sec-.*)$/.test(lower)) return;
    forwardHeaders[k] = v;
  });
  let body: unknown;
  if (method !== 'GET' && method !== 'HEAD') {
    const ct = c.req.header('content-type') || '';
    if (/application\/json/i.test(ct)) body = await c.req.json().catch(() => undefined);
    else {
      const buf = await c.req.arrayBuffer().catch(() => null);
      if (buf && buf.byteLength > 0) body = new Uint8Array(buf);
    }
  }
  try {
    const r = await fetchConnectionRaw(code, { method, path: rawPath, query: c.req.query(), headers: forwardHeaders, body }, c.req.raw.signal);
    return new Response(r.bytes as BodyInit, {
      status: r.status,
      headers: { 'Content-Type': r.contentType || 'application/octet-stream', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

/** 部件里的「打开业务页面」：无 SSO 插件时直接拼安全 URL，有插件则换票 */
app.post('/api/connections/:code/sso/resolve', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    path?: string; query?: Record<string, string>; title?: string;
  };
  try {
    return c.json(await resolveBusinessPageUrl(c.req.param('code').toLowerCase(), {
      path: body.path, query: body.query, title: body.title,
    }));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// 会话持久化 API（SQLite）。列表只给摘要，消息正文按需取单条（避免全量解析）
app.get('/api/sessions', (c) => c.json({ sessions: listSessionSummaries() }));
// 必须注册在 /api/sessions/:id 之前，避免被 :id 吞掉
app.get('/api/sessions/search', (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q) return c.json({ results: [] });
  const workspace = c.req.query('workspace') || undefined;
  const rawLimit = Number(c.req.query('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(50, Math.floor(rawLimit)) : 50;
  return c.json({ results: searchSessions(q, { workspace, limit }) });
});
app.get('/api/sessions/:id/export', (c) => {
  const s = getSession(c.req.param('id'));
  if (!s) return c.json({ error: 'not found' }, 404);
  // 跨机导出剔除本机分叉指针 forkFrom，避免导入异机形成悬空父会话引用
  const { forkFrom: _omitFork, ...exportable } = s;
  const safeTitle = (s.title || 'session').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 32) || 'session';
  const day = new Date().toISOString().slice(0, 10);
  const filename = `paw-session-${safeTitle}-${day}.json`;
  c.header('Content-Type', 'application/json; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return c.body(JSON.stringify(exportable, null, 2));
});
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_SESSIONS = 200;
async function readBoundedUtf8(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf-8');
}
app.post('/api/sessions/import', async (c) => {
  const cl = Number(c.req.header('content-length') || 0);
  if (Number.isFinite(cl) && cl > MAX_IMPORT_BYTES) {
    return c.json({ error: '导入体积超过 20 MB 上限' }, 413);
  }
  const raw = await readBoundedUtf8(c.req.raw, MAX_IMPORT_BYTES);
  if (raw === null) {
    return c.json({ error: '导入体积超过 20 MB 上限' }, 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.json({ error: '导入内容不是合法 JSON' }, 400);
  }
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { sessions?: unknown }).sessions))
      ? (parsed as { sessions: unknown[] }).sessions
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { messages?: unknown }).messages))
        ? [parsed]
        : [];
  if (!list.length) return c.json({ error: '缺少可导入的会话数组' }, 400);
  if (list.length > MAX_IMPORT_SESSIONS) {
    return c.json({ error: `单次最多导入 ${MAX_IMPORT_SESSIONS} 个会话` }, 400);
  }

  const existingIds = new Set(listSessionSummaries().map((s) => s.id));
  const prepared: Session[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') {
      return c.json({ error: `第 ${i + 1} 条会话格式无效` }, 400);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id.trim()
      || typeof r.title !== 'string'
      || typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)
      || !Array.isArray(r.messages)) {
      return c.json({ error: `第 ${i + 1} 条会话缺少必需字段（id/title/updatedAt/messages）` }, 400);
    }
    const collided = existingIds.has(r.id);
    const id = collided ? randomUUID() : r.id;
    existingIds.add(id);
    const baseTitle = r.title.trim() || '未命名会话';
    const title = collided ? `${baseTitle}（导入）` : baseTitle;
    const messages = r.messages.map((m) =>
      normalizeMessage((m && typeof m === 'object' ? m : { role: 'user', content: '' }) as Record<string, unknown>));
    const permission = parseSessionPermission(r.permission);
    prepared.push({
      id,
      title,
      messages,
      updatedAt: r.updatedAt,
      ...(typeof r.workspace === 'string' && r.workspace ? { workspace: r.workspace } : {}),
      ...(permission ? { permission } : {}),
    });
  }
  upsertSessions(prepared);
  const imported: SessionSummary[] = prepared.map((s) => ({
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    ...(s.workspace ? { workspace: s.workspace } : {}),
    ...(s.permission ? { permission: s.permission } : {}),
  }));
  return c.json({ ok: true, count: imported.length, imported });
});
app.get('/api/permissions/global', async (c) => c.json({ allow: await loadGlobalAllow() }));
app.put('/api/permissions/global', async (c) => {
  const body = await c.req.json<{ allow?: unknown }>().catch(() => null);
  const allow = await saveGlobalAllow(body?.allow);
  return c.json({ ok: true, allow });
});
app.patch('/api/sessions/:id/permission', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ permission?: SessionPermission }>().catch(() => null);
  const clean = parseSessionPermission(body?.permission);
  if (!clean) return c.json({ ok: false, error: '无效的权限配置' }, 400);
  const conflicts = detectPermissionConflicts(body?.permission ?? clean);
  const updated = updateSessionPermission(id, clean);
  if (!updated) return c.json({ ok: false, error: '会话不存在' }, 404);
  return c.json({ ok: true, permission: updated, conflicts });
});
/**
 * 从指定历史消息创建会话分叉（非破坏性）：
 *   1. 原会话消息与快照完整保留，新会话截断到选中消息为止并写入 forkFrom 指针；
 *   2. 计算工作区文件回退基线 baselineTs：
 *      - 选中 user 消息：退回到该 user 消息发送前（撤销它触发的那一轮及之后改动）；
 *      - 选中中间某条 assistant 消息：退回到下一条消息开始前（保留该轮刚做完的改动）；
 *      - 选中最后一条 assistant 消息：保留当前全部工作区改动，不回退，只把基线设为最新快照时间；
 *   3. 拷贝 <= baselineTs 的历史快照给新分支，供以后跨分叉切换（LCA）时使用。
 */
app.post('/api/sessions/:id/fork', async (c) => {
  const id = c.req.param('id');
  const source = getSession(id);
  if (!source) return c.json({ ok: false, error: '会话不存在' }, 404);
  if (source.parentId || source.source === 'subagent') {
    return c.json({ ok: false, error: '子代理内部会话不支持分叉' }, 400);
  }
  if (activeSteerQueues.has(id) || hasPendingApproval(id)) {
    return c.json({ ok: false, error: '会话正在运行或存在未决审批，请先停止或处理后再分叉' }, 409);
  }
  const body = await c.req.json<{ messageId?: string; title?: string }>().catch(() => null);
  const messageId = String(body?.messageId || '').trim();
  if (!messageId) return c.json({ ok: false, error: 'messageId 必填' }, 400);
  const idx = source.messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return c.json({ ok: false, error: '未在该会话中找到指定消息' }, 404);

  const selected = source.messages[idx];
  const isLastAssistant = selected.role === 'assistant' && idx === source.messages.length - 1;
  const baselineTs = selected.role === 'user'
    ? selected.ts
    : !isLastAssistant
      ? Math.max(selected.ts, source.messages[idx + 1].ts)
      : Math.max(Date.now(), await getLatestSnapshotTs(id));

  const revertRes = isLastAssistant
    ? { restored: [] as string[], skipped: [] as string[] }
    : await revertWorkspaceTo(id, baselineTs);

  const forkId = randomUUID();
  await forkSnapshotRecords(id, forkId, baselineTs);

  const now = Date.now();
  const forkTitle = typeof body?.title === 'string' && body.title.trim()
    ? body.title.trim().slice(0, 64)
    : `${source.title || '未命名会话'}（分叉）`;
  const forkFrom = { sessionId: id, messageId, ts: baselineTs };
  const forked: Session = {
    id: forkId,
    title: forkTitle,
    messages: source.messages.slice(0, idx + 1),
    updatedAt: now,
    ...(source.workspace ? { workspace: source.workspace } : {}),
    ...(source.source ? { source: source.source } : {}),
    ...(source.taskId ? { taskId: source.taskId } : {}),
    ...(source.permission ? { permission: source.permission } : {}),
    forkFrom,
  };
  upsertSession(forked);
  const summary: SessionSummary = {
    id: forked.id,
    title: forked.title,
    updatedAt: forked.updatedAt,
    ...(forked.workspace ? { workspace: forked.workspace } : {}),
    ...(forked.source ? { source: forked.source } : {}),
    ...(forked.taskId ? { taskId: forked.taskId } : {}),
    ...(forked.permission ? { permission: forked.permission } : {}),
    forkFrom,
  };
  return c.json({ ok: true, session: summary, restored: revertRes.restored, skipped: revertRes.skipped });
});
/**
 * 跨同源分叉切换工作区文件状态：
 * 前端从会话 fromSessionId 切到目标会话 :id 时调用，服务端通过分叉树 LCA 自动撤销源分支独有改动并重放目标分支改动。
 */
app.post('/api/sessions/:id/switch', async (c) => {
  const toId = c.req.param('id');
  const body = await c.req.json<{ fromSessionId?: string }>().catch(() => null);
  const fromId = String(body?.fromSessionId || '').trim();
  if (!fromId) return c.json({ ok: false, error: 'fromSessionId 必填' }, 400);
  if (activeSteerQueues.has(fromId) || activeSteerQueues.has(toId) || hasPendingApproval(fromId) || hasPendingApproval(toId)) {
    return c.json({ ok: false, error: '源或目标会话正在运行中，无法切换分支工作区状态' }, 409);
  }
  const res = await switchSessionWorkspace(fromId, toId, (sid) => getSession(sid));
  return c.json({ ok: true, ...res });
});
app.get('/api/traces/:sessionId', (c) => {
  return c.json({ traces: listTurnTraces(c.req.param('sessionId')) });
});
app.get('/api/usage/:sessionId', (c) => {
  return c.json(getSessionUsage(c.req.param('sessionId')));
});
app.get('/api/sessions/:id', (c) => {
  const s = getSession(c.req.param('id'));
  return s ? c.json(s) : c.json({ error: 'not found' }, 404);
});
app.put('/api/sessions', async (c) => {
  const body = await c.req.json();
  const incoming: Session[] = Array.isArray(body) ? body : body.sessions || [];
  upsertSessions(incoming);
  return c.json({ ok: true, count: incoming.length });
});
app.delete('/api/sessions/:id', (c) => {
  const id = c.req.param('id');
  cancelPendingApprovals(id, '会话已删除');
  deleteSession(id);
  void deleteSnapshots(id);
  return c.json({ ok: true });
});
app.delete('/api/sessions', (c) => {
  cancelPendingApprovals(undefined, '会话已清空');
  clearSessions();
  void clearSnapshots();
  return c.json({ ok: true });
});
/** 回滚文件：把 beforeTs 之后 AI 改过的文件还原。「编辑消息并重发」前调用。 */
app.post('/api/rewind', async (c) => {
  const { sessionId, beforeTs } = (await c.req.json()) as { sessionId?: string; beforeTs?: number };
  if (!sessionId || typeof beforeTs !== 'number') return c.json({ error: 'sessionId 和 beforeTs 必填' }, 400);
  const r = await rollbackAfter(sessionId, beforeTs);
  console.log(`[rewind] ${sessionId} → 还原 ${r.restored.length} 个文件，跳过 ${r.skipped.length} 个（已被手改）`);
  return c.json(r);
});

// 模型列表：代理网关 /v1/models（网关 key 不暴露给前端）
app.get('/api/models', async (c) => {
  try {
    const r = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/v1/models', {
      headers: { Authorization: 'Bearer ' + cfg.apiKey, 'User-Agent': 'Paw/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`gateway HTTP ${r.status}`);
    const d = (await r.json()) as { data?: Array<{ id: string; owned_by?: string; rate_multiplier?: number | null }> };
    const models = (d.data || []).map((m) => ({ id: m.id, group: m.owned_by || '其它', rate: m.rate_multiplier ?? null }));
    // default 只在网关真返回该模型时才给：本地配置的模型可能已没权限
    const def = models.some((m) => m.id === cfg.model) ? cfg.model : (models[0]?.id ?? null);
    return c.json({ models, default: def });
  } catch (e) {
    return c.json({ error: (e as Error).message, models: [], default: cfg.model }, 502);
  }
});

// 搜索引擎配置：GET 查当前 provider，POST {provider:"deepseek"|"ddg"} 切换（写盘持久化）
app.get('/api/search-config', async (c) => {
  const sc = await loadSearchConfig();
  return c.json({ provider: sc.provider, hasDeepseekKey: !!sc.deepseekKey });
});
app.post('/api/search-config', async (c) => {
  const { provider } = (await c.req.json()) as { provider?: string };
  if (provider !== 'deepseek' && provider !== 'ddg') {
    return c.json({ error: 'provider 必须是 deepseek 或 ddg' }, 400);
  }
  // env 优先级高于配置文件，提示用户
  if (process.env.SEARCH_PROVIDER && process.env.SEARCH_PROVIDER !== provider) {
    return c.json({ error: `SEARCH_PROVIDER 环境变量已固定为 ${process.env.SEARCH_PROVIDER}，配置文件不会生效` }, 400);
  }
  await saveSearchProvider(provider as SearchProviderName);
  return c.json({ ok: true, provider });
});

// 定时任务 API
app.get('/api/skills', async (c) => {
  const wsParam = c.req.query('workspace');
  const workspace = wsParam === undefined ? undefined : (wsParam || null);
  const skills = await loadSkills(workspace);
  return c.json({
    skills: skills.map((s) => ({ id: s.dir, name: s.name, description: s.description, source: s.source })),
    dir: SKILLS_DIR,
  });
});
app.get('/api/skills/:id/content', async (c) => {
  const wsParam = c.req.query('workspace');
  const workspace = wsParam === undefined ? undefined : (wsParam || null);
  const content = await loadSkillContent(c.req.param('id'), workspace);
  return content ? c.json({ content }) : c.json({ error: 'not found' }, 404);
});

app.get('/api/tasks', (c) => c.json({ tasks: listTasks() }));
app.put('/api/tasks', async (c) => {
  const body = await c.req.json();
  const t = body as ScheduledTask;
  if (!t.id || !t.cron || !t.prompt) return c.json({ error: 'id/cron/prompt 必填' }, 400);
  upsertTask(t);
  return c.json({ ok: true });
});
app.post('/api/tasks/:id/run', async (c) => {
  const t = getTask(c.req.param('id'));
  if (!t) return c.json({ error: 'not found' }, 404);
  const r = await runTask(t, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  return c.json(r);
});
// 「立即运行」走聊天流结束后由前端回写一条运行记录（与调度执行同表）
app.post('/api/tasks/:id/runs', async (c) => {
  const t = getTask(c.req.param('id'));
  if (!t) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json() as { id?: string; ok?: boolean; output?: string; seconds?: number };
  if (!b.id) return c.json({ error: 'id 必填' }, 400);
  addRun({ id: b.id, taskId: t.id, at: Date.now(), ok: b.ok !== false, output: String(b.output || ''), seconds: Number(b.seconds || 0) });
  touchTask(t.id, Date.now());
  return c.json({ ok: true });
});
app.delete('/api/tasks/:id', (c) => {
  deleteTask(c.req.param('id'));
  return c.json({ ok: true });
});
app.get('/api/tasks/:id/runs', (c) => c.json({ runs: listRuns(c.req.param('id'), 50) }));
// 所有任务的运行记录（带任务名，给聊天页右侧运行记录面板）
app.get('/api/tasks/runs/all', (c) => {
  const names = new Map(listTasks().map((t) => [t.id, t.name]));
  const runs = listRuns(undefined, 100).map((r) => ({ ...r, taskName: names.get(r.taskId) || '已删除任务' }));
  return c.json({ runs });
});

// 会话标题：单独的第二次模型调用。前端发首条消息后异步调用，拿不到就留字符串兜底标题。
// 不塞进 /api/chat 的流里——那样用户点「停止」会把标题一起掐掉，也不好单独重试。
app.post('/api/title', async (c) => {
  try {
    const { text, model } = await c.req.json() as { text?: string; model?: string };
    if (typeof text !== 'string' || !text.trim()) return c.json({ error: '缺少文本' }, 400);
    const title = await generateTitle(text, { ...cfg, model: model || cfg.model });
    return c.json({ title });
  } catch (e) {
    // 标题失败不该影响对话：回空串，前端保留原兜底标题
    console.warn('[title] 生成失败，前端沿用兜底标题：', (e as Error).message);
    return c.json({ title: '' });
  }
});

app.get('/api/context/:sessionId', (c) => {
  const samples = getContextSamples(c.req.param('sessionId'));
  return c.json({ latest: samples.at(-1) ?? null, samples });
});

app.get('/api/context/:sessionId/usage', (c) => {
  const turnId = c.req.query('turnId');
  const since = Number(c.req.query('since'));
  return c.json({ reading: turnId ? getContextReading(c.req.param('sessionId'), turnId,
    Number.isSafeInteger(since) && since > 0 ? since : undefined) : null });
});

app.post('/api/context/compact', async (c) => {
  const body = await c.req.json<Pick<ChatRequest, 'messages' | 'sessionId' | 'turnId' | 'model' | 'workspace'>>().catch(() => null);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId.trim() || !Array.isArray(body.messages)
      || (body.turnId != null && typeof body.turnId !== 'string') || !isConversationHistory(body.messages) || (body.model != null && typeof body.model !== 'string')
      || (body.workspace != null && typeof body.workspace !== 'string')) return c.json({ error: '无效的会话或消息历史' }, 400);
  const model = body.model || cfg.model;
  if (isImageModel(model)) return c.json({ error: '请先选择对话模型再压缩历史。' }, 400);
  try {
    const ws = body.workspace === undefined ? await getWorkspaceRoot() : body.workspace;
    const [prompt, tools] = await Promise.all([loadPersonaPrompt(ws), getAllToolSchemas(ws)]);
    const plan = await prepareSessionContext({ ...cfg, model }, body.sessionId, body.messages, body.messages,
      prompt ? { role: 'system', content: prompt } : undefined, tools, { manual: true, signal: c.req.raw.signal });
    const reclaimedTokens = plan.beforeTokens - plan.insight.estimatedTokens;
    const insight = { kind: 'manual', model, turnId: body.turnId, ...plan.insight, beforeTokens: plan.beforeTokens, reclaimedTokens, compacted: !!plan.summary };
    addContextSample(body.sessionId, insight);
    const message = plan.summary ? `已压缩 ${plan.newlyCovered} 条历史消息，预计节省 ${reclaimedTokens} tokens。` : '暂无可进一步压缩的历史，已保留最近一轮原文。';
    return c.json({ message, insight });
  } catch (err) {
    return c.json({ error: `上下文压缩未完成：${err instanceof Error ? err.message : '摘要生成失败'}` }, 502);
  }
});

// 记忆与工作日志（按项目区分，存 ~/.paw/paw.db）：查看/编辑页面 + 报工数据源
app.get('/api/memories', (c) => c.json({ items: listMemories(c.req.query('workspace')) }));
app.put('/api/memories', async (c) => {
  const b = await c.req.json<{
    id?: string; title?: string; content?: string; tags?: string; workspace?: string | null; allowDuplicate?: boolean;
  }>().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: '请求体不是合法 JSON' }, 400);
  const title = b.title?.trim();
  const content = b.content?.trim();
  if (!title || !content) return c.json({ error: 'title 和 content 不能为空' }, 400);
  if (!b.allowDuplicate) {
    const scopeWs = b.workspace !== undefined
      ? b.workspace
      : (b.id ? listMemories().find((m) => m.id === b.id)?.workspace : undefined);
    const hit = findMemoryByTitle(title, scopeWs);
    if (hit && hit.id !== b.id) {
      return c.json({
        error: '已存在同名记忆',
        conflict: { existingId: hit.id, existingTitle: hit.title, existingContent: hit.content },
      }, 409);
    }
  }
  try {
    const id = upsertMemoryDirect({ id: b.id, title, content, tags: b.tags?.trim() || '', workspace: b.workspace });
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 404);
  }
});
app.delete('/api/memories/:id', (c) => {
  return deleteMemoryById(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: '记忆不存在' }, 404);
});

app.get('/api/worklogs', (c) => {
  const day = c.req.query('day');
  return c.json({
    items: listWorkLogs({
      workspace: c.req.query('workspace'),
      ...(day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? { day } : {}),
      days: Number(c.req.query('days')) || 7,
    }),
  });
});
app.put('/api/worklogs', async (c) => {
  const b = await c.req.json<{ id?: string; title?: string; content?: string }>();
  if (!b.id) return c.json({ error: '缺少 id' }, 400);
  const patch: { title?: string; content?: string } = {};
  if (b.title !== undefined) patch.title = b.title;
  if (b.content !== undefined) patch.content = b.content;
  try {
    return updateWorkLog(b.id, patch) ? c.json({ ok: true }) : c.json({ error: '日志不存在' }, 404);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
app.delete('/api/worklogs/:id', (c) => {
  return deleteWorkLog(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: '日志不存在' }, 404);
});

app.post('/api/context/handoff', async (c) => {
  const body = await c.req.json<{
    sessionId?: string;
    title?: string;
    messages?: ChatRequest['messages'];
    viewMessages?: Session['messages'];
    goal?: string;
    model?: string;
    workspace?: string | null;
  }>().catch(() => null);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId.trim() || !Array.isArray(body.messages)) {
    return c.json({ error: '无效的会话或消息历史' }, 400);
  }
  const model = body.model || cfg.model;
  if (isImageModel(model)) return c.json({ error: '请先选择对话模型再生成会话交接单。' }, 400);
  try {
    const saved = getSession(body.sessionId);
    const viewMessages = Array.isArray(body.viewMessages) && body.viewMessages.length
      ? body.viewMessages
      : (saved?.messages ?? []);
    const ws = body.workspace !== undefined ? body.workspace : (saved?.workspace ?? null);
    const result = await generateHandoffBrief({ ...cfg, model }, {
      sessionId: body.sessionId,
      sessionTitle: body.title || saved?.title || '原会话',
      chatMessages: body.messages,
      viewMessages,
      goal: body.goal,
      workspace: ws,
      signal: c.req.raw.signal,
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: `生成交接单失败：${err instanceof Error ? err.message : '摘要生成失败'}` }, 502);
  }
});

// 正在运行的会话强行提醒队列（sessionId → 待注入条目列表，带 id 以便未消费时通知前端回滚）
interface SteerEntry { id: string; text: string }
const activeSteerQueues = new Map<string, SteerEntry[]>();

app.post('/api/chat/steer', async (c) => {
  let body: { id?: string; sessionId?: string; text?: string; attachments?: ChatRequest['attachments']; skillIds?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }
  const sid = String(body.sessionId || '').trim();
  const q = sid ? activeSteerQueues.get(sid) : undefined;
  if (!q) return c.json({ ok: true, injected: false });

  const parts: string[] = [];
  if (body.text?.trim()) parts.push(body.text.trim());
  const atts = body.attachments || [];
  if (atts.length) {
    await persistAttachments(atts, { sessionId: sid });
    // 与普通消息一致：只给路径清单，正文由模型按需调 read_image / read_file / document_text 读取
    const attDesc = atts.map((a) => {
      if (a.kind === 'image') return `[附带图片：${a.name}${a.localPath ? ` (${a.localPath}，需要查看画面可调用 read_image)` : ''}]`;
      return `[附带文件：${a.name}${a.localPath ? ` (${a.localPath}，需要读取内容可调用 read_file 或 document_text)` : ''}]`;
    }).join('\n');
    parts.push(attDesc);
  }
  if (body.skillIds?.length) {
    const steerWorkspace = getSession(sid)?.workspace;
    for (const id of body.skillIds) {
      const content = await loadSkillContent(id, steerWorkspace);
      if (content) parts.push(`<skill id="${id}">\n${content}\n</skill>`);
    }
  }
  const combined = parts.join('\n\n').trim();
  if (!combined) return c.json({ ok: false, error: '提醒内容为空' }, 400);
  q.push({ id: String(body.id || ''), text: combined });
  return c.json({ ok: true, injected: true });
});

app.post('/api/chat/approve', async (c) => {
  const body = await c.req.json<{ sessionId?: string; id?: string; decision?: PermissionDecision }>().catch(() => null);
  const sid = String(body?.sessionId || '').trim();
  const id = String(body?.id || '').trim();
  const decision = body?.decision;
  if (!sid || !id || !decision || !['allow_once', 'deny', 'allow_session', 'deny_session'].includes(decision)) {
    return c.json({ ok: false, error: '参数无效' }, 400);
  }
  const r = resolveApproval(sid, id, decision);
  return c.json({ ok: r.ok, decision: r.effectiveDecision });
});

// /btw 只读旁路问答：独立轻量通道，零工具、零附件落盘、零复盘、零持久化，支持主会话忙碌时并行问答
app.post('/api/chat/btw', (c) => {
  return streamSSE(c, async (stream) => {
    const abortCtrl = new AbortController();
    stream.onAbort(() => { abortCtrl.abort(); });
    let body: BtwRequest;
    try {
      body = (await c.req.json()) as BtwRequest;
    } catch {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '请求体不是合法 JSON' }) }).catch(() => {});
      return;
    }
    if (!Array.isArray(body?.messages) || !body.messages.length || !isConversationHistory(body.messages)) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '无效的消息历史' }) }).catch(() => {});
      return;
    }
    const model = body.model || cfg.model;
    if (isImageModel(model)) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '/btw 只读旁路问答不支持生图模型，请切换对话模型' }) }).catch(() => {});
      return;
    }
    const workspace = body.workspace === undefined ? await getWorkspaceRoot() : body.workspace;
    try {
      for await (const ev of runAgent({ ...cfg, model }, body.messages, {
        signal: abortCtrl.signal,
        workspace,
        maxRounds: 1,
        allowedTools: [],
        unattended: true,
        systemOverride: '只读旁路顾问：仅根据已给对话上下文直接回答用户问题，不调用工具、不修改文件、不反问。回答力求准确简洁。',
      })) {
        if (abortCtrl.signal.aborted) break;
        if (ev.type === 'text' || ev.type === 'reasoning' || ev.type === 'done' || ev.type === 'error') {
          await stream.writeSSE({ data: JSON.stringify(ev) });
        }
      }
    } catch (e) {
      if (abortCtrl.signal.aborted || stream.aborted) return;
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: (e as Error).message }) });
    }
  });
});

function unionIntervalsMs(intervals: Array<[number, number]>): number {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curS, curE] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curE) {
      if (e > curE) curE = e;
    } else {
      total += Math.max(0, curE - curS);
      curS = s;
      curE = e;
    }
  }
  total += Math.max(0, curE - curS);
  return total;
}

app.post('/api/chat', (c) => {
  return streamSSE(c, async (stream) => {
    // 前端点停止/断开 SSE → 中断网关上游请求和后续工具轮次（不是只断浏览器连接）
    const abortCtrl = new AbortController();
    stream.onAbort(() => {
      if (!abortCtrl.signal.aborted) console.log('[chat] 客户端断开，已取消上游生成');
      abortCtrl.abort();
    });
    let body: ChatRequest;
    try {
      body = (await c.req.json()) as ChatRequest;
    } catch {
      // 不回这个错误事件的话，前端只会看到“流结束但没有任何事件”，停在半截无从得知原因
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: '请求体不是合法 JSON' }) }).catch(() => {});
      return;
    }
    const model = body.model || cfg.model;
    // 本次运行的工作区在发起瞬间固定，整轮工具都用它——
    // 否则用户切走会话后，进行中的调用会落到新目录。
    // undefined=旧客户端沿用当前工作区；null=明确不用。
    const workspace = body.workspace === undefined ? await getWorkspaceRoot() : body.workspace;

    // 生图模型直出：gpt-image-* 不支持 chat 端点，用户选它就是要生图
    if (isImageModel(model)) {
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const prompt = String(lastUser?.content ?? '').trim();
      // 有图片附件 → 图生图（用第一张图的 data URL）
      const inputImage = body.attachments?.find((a) => a.kind === 'image')?.content;
      try {
        const id = `img-${Date.now()}`;
        await stream.writeSSE({ data: JSON.stringify({ type: 'tool_start', id, name: 'generate_image', summary: '生成图片' }) });
        const res = await executeTool('generate_image', { prompt, model, input_image: inputImage }, id, {
          signal: abortCtrl.signal,
          gateway: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model },
        });
        if (res.isError || res.content.startsWith('Unknown tool:')) {
          throw new Error(res.content.startsWith('Unknown tool:') ? '未安装生图插件（paw-plugin-image-gen），无法直接调用生图模型' : res.content);
        }
        await stream.writeSSE({ data: JSON.stringify({ type: 'tool_done', id, name: 'generate_image', ok: true, output: res.content }) });
        await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: '画好啦 🐾' }) });
        await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
      } catch (e) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: (e as Error).message }) });
      }
      return;
    }

    // 技能加载：发 UI 事件 + 收集全文；正文注入统一交给 composeChatMessages
    const skillBlocks: { id: string; content: string }[] = [];
    for (const id of body.skillIds || []) {
      const content = await loadSkillContent(id, workspace);
      if (!content) continue;
      skillBlocks.push({ id, content });
      const sid = `skill-${id}-${Date.now()}`;
      await stream.writeSSE({ data: JSON.stringify({ type: 'tool_start', id: sid, name: 'load_skill', summary: `加载技能 ${id}` }) });
      await stream.writeSSE({ data: JSON.stringify({ type: 'tool_done', id: sid, name: 'load_skill', ok: true, output: content.slice(0, 3000) }) });
    }

    // 用户这条消息指定了系统连接：拼一段说明，让模型优先用它调接口（凭据仍由服务端注入）
    let connectionBlock: string | undefined;
    if (body.connectionCode) {
      const conn = loadConnections().find((x) => x.code === body.connectionCode);
      if (conn) {
        const authProvider = getConnectionAuthProvider(conn.kind);
        const ssoProvider = getConnectionSsoProvider(conn.sso?.type);
        connectionBlock = [
          `<selected_connection code="${conn.code}" name="${conn.name}">`,
          '用户这条消息指定用这个系统连接。要调它的接口时用 call_api，connection 参数填上面的 code。',
          ...(ssoProvider?.promptHint ? [ssoProvider.promptHint] : []),
          '如果不知道具体接口路径，直接问用户，不要反复试探根路径或 swagger。',
          `地址：${conn.baseUrl}`,
          conn.description ? `说明：${conn.description}` : '',
          authProvider?.promptHint || '认证：由应用自动注入。',
          '</selected_connection>',
        ].filter(Boolean).join('\n');
      } else {
        console.warn(`[chat] 指定的连接不存在，忽略：${body.connectionCode}`);
      }
    }

    // 附件先落盘（~/.paw/attachments/<会话>/）：图片和文件都存一份真实文件，
    // composeChatMessages 把 @ 引用统一改写成这些真实路径，后续轮次模型照路径就能找回。
    await persistAttachments(body.attachments || [], { sessionId: body.sessionId });

    // 已落盘附件的「原名 → 本机路径列表（升序）」索引：同名文件（多张 image.png）按历史顺序一一对应
    const persistedPaths: Record<string, string[]> = {};
    for (const s of await listSessionAttachments(body.sessionId)) {
      (persistedPaths[s.key] ??= []).push(s.path);
    }

    // 图片转交：模型不支持读图但有图片 → 先用视觉模型识别成文字，喂给原模型继续。
    // （网关是单请求单上游转发，做不了跨模型串联；这活在 Agent 编排层做）
    const imageAtts = (body.attachments || []).filter((a) => a.kind === 'image');
    let imageDescriptions: string[] | undefined;
    if (imageAtts.length && !canSeeImages(model)) {
      try {
        const id = `vision-${Date.now()}`;
        await stream.writeSSE({ data: JSON.stringify({ type: 'tool_start', id, name: 'describe_image', summary: '识别图片内容' }) });
        const descriptions: string[] = [];
        for (const [i, att] of imageAtts.entries()) {
          try {
            descriptions.push(`@image#${i + 1}: ${await describeImage(att.content, cfg, abortCtrl.signal)}`);
          } catch (e) {
            descriptions.push(`@image#${i + 1}: 识别失败（${(e as Error).message.slice(0, 60)}）`);
          }
        }
        imageDescriptions = descriptions;
        await stream.writeSSE({ data: JSON.stringify({ type: 'tool_done', id, name: 'describe_image', ok: true, output: descriptions.join('\n') }) });
      } catch (e) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: `图片识别失败：${friendlyGatewayError(502, (e as Error).message)}` }) });
      }
    }

    // 组装最终消息：技能 → 连接 → 交接单 → 附件 → 图片转文字，基于同一条链顺序追加，互不覆盖
    const composed = composeChatMessages({
      messages: body.messages,
      skillBlocks,
      connectionBlock,
      handoff: body.handoff,
      attachments: body.attachments || [],
      imageDescriptions,
      canSeeImages: canSeeImages(model),
      persistedPaths,
    });
    const parentSessionId = body.parentSessionId
      || body.handoff?.fromSessionId
      || (body.sessionId ? getSession(body.sessionId)?.handoffFrom?.sessionId : undefined);

    // 定时任务「立即运行」：本轮结束写一条运行记录（与调度执行同表，runId 关联会话）
    const runMeta = body.taskRun;
    const t0 = Date.now();
    let runOk = true;
    let runOutput = '';
    // 复盘原料：最终回复文本 + 用到的工具名（收尾时提炼记忆和工作日志用）
    let replyText = '';
    const toolNames: string[] = [];
    // 轻量会话轨迹采集（旁路统计，失败不影响主流程）
    let firstTextMs: number | undefined;
    let approvalWaitMs = 0;
    let rounds = 0;
    let observedRounds = 0;
    let finalUsage: { prompt: number; completion: number } | undefined;
    const activeToolStarts = new Map<string, { name: string; start: number }>();
    const perToolWaitMs = new Map<string, number>();
    const traceTools: TurnTraceTool[] = [];

    const sessionPermission = (body.sessionId ? getSession(body.sessionId)?.permission : undefined)
      ?? parseSessionPermission(body.permission);
    const authorize = createSessionAuthorizer({
      sessionId: body.sessionId,
      turnId: body.turnId,
      permission: sessionPermission,
      onWaitMs: (ms, toolCallId) => {
        approvalWaitMs += ms;
        perToolWaitMs.set(toolCallId, (perToolWaitMs.get(toolCallId) || 0) + ms);
      },
    });

    const steerQ: SteerEntry[] = [];
    if (body.sessionId) activeSteerQueues.set(body.sessionId, steerQ);
    // 等待审批期间每 25 秒发注释心跳，防止中间层或客户端超时断开
    const keepalive = body.sessionId ? setInterval(() => {
      if (body.sessionId && hasPendingApproval(body.sessionId, body.turnId) && !abortCtrl.signal.aborted && !stream.aborted) {
        void stream.write(': keepalive\n\n').catch(() => {});
      }
    }, 25_000) : null;
    keepalive?.unref?.();
    try {
      for await (const ev of runAgent({ ...cfg, model }, composed.messages, {
        images: composed.imageUrls.length ? composed.imageUrls : undefined,
        signal: abortCtrl.signal,
        workspace,
        sessionId: body.sessionId,
        parentSessionId,
        turnId: body.turnId,
        connectionCode: body.connectionCode,
        rawHistory: body.messages,
        drainSteering: () => (steerQ.length ? steerQ.splice(0).map((e) => e.text) : []),
        authorize,
        extraSystemNote: sessionPermission?.mode === 'plan'
          ? '[只读计划模式约束] 当前会话处于只读计划模式（plan）：禁止修改、创建或删除文件，禁止 git 提交或运行任何带副作用的命令。请仅使用只读工具（及纯只读查询命令）完成调研，并直接输出结构清晰的实施计划。'
          : undefined,
      })) {
        if (abortCtrl.signal.aborted) break;
        if (ev.type === 'text') {
          if (firstTextMs === undefined) firstTextMs = Date.now() - t0;
          replyText += ev.delta;
          if (runMeta) runOutput += ev.delta;
        }
        if (ev.type === 'context_usage' && ev.reading.estimated) observedRounds++;
        if (ev.type === 'tool_start') {
          toolNames.push(ev.name);
          activeToolStarts.set(ev.id, { name: ev.name, start: Date.now() });
        }
        if (ev.type === 'tool_done') {
          const started = activeToolStarts.get(ev.id);
          activeToolStarts.delete(ev.id);
          const end = Date.now();
          const rawStart = started?.start ?? end;
          const waited = perToolWaitMs.get(ev.id) || 0;
          const effectiveStart = Math.min(end, rawStart + waited);
          const rejectedByUser = !ev.ok && ev.output.startsWith('用户拒绝执行 ');
          traceTools.push({
            id: ev.id,
            name: ev.name,
            start: effectiveStart,
            end,
            ms: Math.max(0, end - effectiveStart),
            ok: ev.ok,
            ...(rejectedByUser ? { rejectedByUser: true } : {}),
          });
        }
        if (ev.type === 'done') {
          finalUsage = ev.usage;
          if (typeof ev.rounds === 'number') rounds = ev.rounds;
        }
        if (ev.type === 'error') runOk = false;
        const outEv = ev.type === 'error' && ev.message.startsWith('__LIMIT__')
          ? { ...ev, message: ev.message.slice(9) } : ev;
        await stream.writeSSE({ data: JSON.stringify(outEv) });
      }
    } catch (e) {
      if (abortCtrl.signal.aborted || stream.aborted) return; // 用户停止，不推错误
      runOk = false;
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: (e as Error).message }) });
    } finally {
      if (keepalive) clearInterval(keepalive);
      if (body.sessionId) cancelPendingApprovals(body.sessionId, '本轮已结束', body.turnId);
      if (body.sessionId && activeSteerQueues.get(body.sessionId) === steerQ) {
        activeSteerQueues.delete(body.sessionId);
      }
      // 落盘轻量轨迹（失败只打日志，不阻断流收尾）
      if (body.sessionId && body.turnId) {
        try {
          const totalMs = Math.max(0, Date.now() - t0);
          const toolMs = unionIntervalsMs(traceTools.map((t) => [t.start, t.end]));
          const modelMs = Math.max(0, totalMs - toolMs - approvalWaitMs);
          const trace: TurnTrace = {
            turnId: body.turnId,
            at: t0,
            totalMs,
            ...(firstTextMs !== undefined ? { firstTextMs } : {}),
            toolMs,
            approvalWaitMs,
            modelMs,
            rounds: rounds || observedRounds || 1,
            ...(finalUsage ? { usage: finalUsage } : {}),
            model,
            tools: traceTools,
          };
          upsertTurnTrace(body.sessionId, trace);
        } catch (err) {
          console.warn('[trace] 写入轨迹失败：', (err as Error).message);
        }
      }
      // 若本轮因 done/error/__LIMIT__/abort 提前退出而 steerQ 里仍有未消费的插话，通知前端回滚进队列，绝不静默丢消息
      if (steerQ.length && !stream.aborted) {
        const ids = steerQ.map((e) => e.id).filter(Boolean);
        if (ids.length) {
          await stream.writeSSE({ data: JSON.stringify({ type: 'steer_unconsumed', ids }) }).catch(() => {});
        }
      }
    }
    if (runMeta && !abortCtrl.signal.aborted) {
      addRun({
        id: runMeta.runId, taskId: runMeta.taskId, at: Date.now(), ok: runOk,
        output: runOutput || '（无文本输出）', seconds: (Date.now() - t0) / 1000,
      });
      touchTask(runMeta.taskId, Date.now());
    }
    // 轮次收尾：异步提炼记忆 + 工作日志（fire-and-forget，失败不影响对话）
    if (!abortCtrl.signal.aborted && !stream.aborted) {
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
      // ChatMessage.content 可能是 string（新消息）也可能是块数组（历史），都能取纯文本
      const userText = lastUser
        ? (typeof lastUser.content === 'string' ? lastUser.content : messageText(lastUser as never)).trim()
        : '';
      if (userText) {
        void reflectTurn(cfg, {
          workspace, sessionId: body.sessionId, turnId: body.turnId,
          userText, assistantText: replyText, toolNames,
        });
      }
    }
  });
});

// 后台任务（Agent 用 run_command(background=true) 起的进程）：前端徽标轮询展示 + 手动终止
app.get('/api/jobs', (c) => c.json({ jobs: jobViews() }));
app.post('/api/jobs/:id/kill', (c) => c.json({ ok: killJobById(c.req.param('id')) }));

// 浏览器版的桌面通知（没有桌面壳时前端回落这里）：由前端在「本轮结束」那一刻调用——
// 窗口焦点只有前端知道，前端只在窗口不在前台时才发这个请求，服务端只管弹。
app.get('/api/plugins', (c) => c.json(getPluginInventory()));
app.get('/api/widgets', (c) => c.json({ widgets: getWidgetInventory() }));

const PLUGIN_UI_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

// 托管外部插件自定义页面静态资源：/api/plugins/:dir/ui/<relPath>
app.get('/api/plugins/:dir/ui/*', async (c) => {
  const dirName = decodeURIComponent(c.req.param('dir'));
  if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName === '.' || dirName === '..') {
    return c.text('Invalid plugin directory', 400);
  }
  const prefix = `/api/plugins/${c.req.param('dir')}/ui/`;
  const rawRel = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
  const rel = decodeURIComponent(rawRel || 'index.html');
  const pluginRoot = path.resolve(getPluginsDir(), dirName);
  const abs = path.resolve(pluginRoot, rel);
  if (abs !== pluginRoot && !abs.startsWith(pluginRoot + path.sep)) {
    return c.text('Forbidden', 403);
  }
  try {
    const st = await stat(abs);
    if (!st.isFile()) return c.notFound();
    const buf = await readFile(abs);
    const mime = PLUGIN_UI_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    return new Response(buf, { headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' } });
  } catch {
    return c.notFound();
  }
});

// 外部插件自定义后端 API 路由：/api/plugin-api/:name/*
async function dispatchPluginApi(c: import('hono').Context) {
  const rawParam = c.req.param('name') ?? '';
  const name = decodeURIComponent(rawParam);
  const router = getPluginRouter(name);
  if (!router) return c.json({ error: `插件 ${name} 未注册 HTTP 路由` }, 404);
  const url = new URL(c.req.url);
  const mountPrefix = `/api/plugin-api/${encodeURIComponent(name)}`;
  const rawPrefix = `/api/plugin-api/${rawParam}`;
  let subPath = url.pathname;
  if (subPath.startsWith(rawPrefix)) subPath = subPath.slice(rawPrefix.length) || '/';
  else if (subPath.startsWith(mountPrefix)) subPath = subPath.slice(mountPrefix.length) || '/';
  url.pathname = subPath.startsWith('/') ? subPath : '/' + subPath;
  const forwarded = new Request(url.toString(), c.req.raw);
  return router.fetch(forwarded);
}
app.all('/api/plugin-api/:name', dispatchPluginApi);
app.all('/api/plugin-api/:name/*', dispatchPluginApi);
app.post('/api/plugins/reload', async (c) => {
  await reloadExternalPlugins();
  return c.json(getPluginInventory());
});
app.put('/api/plugins/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: '请求体必须是 JSON 对象' }, 400);
  }
  try {
    const patch: { enabled?: boolean; config?: Record<string, unknown> } = {};
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled 必须是布尔值' }, 400);
      patch.enabled = body.enabled;
    }
    if ('config' in body) {
      if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
        return c.json({ error: 'config 必须是 JSON 对象' }, 400);
      }
      patch.config = body.config as Record<string, unknown>;
    }
    const inventory = await updateExternalPlugin(name, patch);
    return c.json(inventory);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post('/api/notify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = String(body?.body ?? '').slice(0, 300) || '这一轮回答完成了';
  notifyDone(text);
  return c.json({ ok: true });
});

// 生产模式：托管前端构建产物（Electron 桌面版直接加载，无需另起 vite）
app.use('/*', serveStatic({ root: '../web/dist' }));
// SPA fallback：非 /api 的未命中路由返回 index.html（前端路由用）
app.get('*', async (c) => {
  if (c.req.path.startsWith('/api/')) return c.notFound();
  const { readFile } = await import('node:fs/promises');
  try {
    const html = await readFile(path.resolve(import.meta.dirname, '../../web/dist/index.html'), 'utf-8');
    return c.html(html);
  } catch { return c.text('前端未构建，先运行 pnpm build', 500); }
});

// 退出时杀掉后台命令 job，不留孤儿进程
process.on('SIGTERM', () => { killAllJobs(); process.exit(0); });
process.on('SIGINT', () => { killAllJobs(); process.exit(0); });

await loadExternalPlugins();
const port = Number(process.env.PORT || 8787);
// 默认只监听回环地址：本服务能读文件、跑命令，不该默认暴露到局域网；确需远程访问设 PAW_HOST
const host = process.env.PAW_HOST || '127.0.0.1';
const httpServer = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`Paw server on http://${host}:${info.port}  model=${cfg.model}`);
});
// IDE 内置终端：复用同一个 http server 的 upgrade 通道（不另开端口）
attachTerminal(httpServer as import('node:http').Server);
