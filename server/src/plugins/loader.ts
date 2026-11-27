// 外部插件动态加载器：扫描 ~/.paw/plugins/*/（或 PAW_PLUGINS_DIR），
// 支持 plugins.json 启停与私有配置，单个插件出错只记诊断不拖垮主服务。
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginRegistry } from '@paw/kernel';
import { Hono } from 'hono';
import { DATA_DIR } from '../paths.js';
import {
  callConnection,
  getConnection,
  loadConnections,
  registerConnectionAuthProvider,
  registerConnectionSsoProvider,
  unregisterConnectionAuthProvider,
  unregisterConnectionSsoProvider,
} from '../connections.js';
import { getSession, getTask, listRuns, listSessionSummaries, listTasks } from '../db.js';
import { executeMcpTool, mcpServerViews, mcpToolSchemas } from '../mcp.js';
import { notifyDone } from '../notify.js';
import { loadSkillContent, loadSkills } from '../skills.js';
import { deleteMemoryById, listMemories, upsertMemoryDirect } from '../tools/memory.js';
import { deleteWorkLog, insertWorkLog, listWorkLogs, updateWorkLog } from '../tools/worklog.js';
import { getWorkspaceRoot, listWorkspaces, resolveToolPath } from '../workspace.js';
import type {
  ExternalPluginExport,
  PluginHostApi,
  PluginPageSpec,
  PluginWidgetSpec,
  ResolvedPluginPage,
  ResolvedPluginWidget,
  ServerPawPlugin,
  ServerToolExecCtx,
} from './types.js';

export interface PluginConfigEntry {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface LoadedExternalPluginInfo {
  name: string;
  version?: string;
  description?: string;
  dir: string;
  entry: string;
  tools: string[];
  pages: ResolvedPluginPage[];
  widgets: ResolvedPluginWidget[];
  config: Record<string, unknown>;
}

export interface DisabledExternalPluginInfo {
  dir: string;
  name: string;
  version?: string;
  description?: string;
  config: Record<string, unknown>;
}

export interface FailedExternalPluginInfo {
  dir: string;
  name?: string;
  version?: string;
  description?: string;
  config: Record<string, unknown>;
  error: string;
}

export interface ExternalLoadReport {
  pluginsDir: string;
  loaded: LoadedExternalPluginInfo[];
  disabled: DisabledExternalPluginInfo[];
  skipped: string[];
  failed: FailedExternalPluginInfo[];
  /** 已注册的插件实例（供宿主在 reload 前调用 onDispose） */
  instances?: ServerPawPlugin[];
  /** 已注册的插件专属 HTTP 路由（key = plugin.name） */
  routers?: Map<string, Hono>;
}

function resolvePluginPages(
  pluginName: string,
  pluginDirName: string,
  pluginDirAbs: string,
  specs?: PluginPageSpec[],
): ResolvedPluginPage[] {
  if (!Array.isArray(specs) || !specs.length) return [];
  const root = path.resolve(pluginDirAbs);
  const out: ResolvedPluginPage[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') continue;
    const id = String(spec.id ?? '').trim();
    const label = String(spec.label ?? '').trim();
    const entry = String(spec.entry ?? '').trim();
    if (!id || !label || !entry || seen.has(id)) continue;
    seen.add(id);

    let url = '';
    if (/^https?:\/\//i.test(entry)) {
      url = entry;
    } else {
      const rel = entry.replace(/^\/+/, '');
      const resolved = path.resolve(root, rel);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        console.warn(`[plugins] 插件 ${pluginName} 的页面入口越界，已忽略：${entry}`);
        continue;
      }
      const normalizedRel = path.relative(root, resolved).split(path.sep).map(encodeURIComponent).join('/');
      url = `/api/plugins/${encodeURIComponent(pluginDirName)}/ui/${normalizedRel}`;
    }

    const order = typeof spec.order === 'number' && Number.isFinite(spec.order) ? spec.order : 50;
    out.push({
      key: `plugin:${pluginDirName}:${id}`,
      pluginDir: pluginDirName,
      pluginName,
      id,
      label,
      icon: typeof spec.icon === 'string' && spec.icon.trim() ? spec.icon.trim() : undefined,
      order,
      url,
    });
  }
  return out;
}

/**
 * 解析部件清单：与页面不同，entry 允许带 ?query（桥接页据此找脚本），
 * 所以先把 query 摘出来，只对纯路径部分做越界校验。
 */
function resolvePluginWidgets(
  pluginName: string,
  pluginDirName: string,
  pluginDirAbs: string,
  specs?: PluginWidgetSpec[],
): ResolvedPluginWidget[] {
  if (!Array.isArray(specs) || !specs.length) return [];
  const root = path.resolve(pluginDirAbs);
  const out: ResolvedPluginWidget[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') continue;
    const id = String(spec.id ?? '').trim();
    const entry = String(spec.entry ?? '').trim();
    if (!id || !entry || seen.has(id)) continue;
    seen.add(id);

    const qIdx = entry.indexOf('?');
    const entryPath = qIdx >= 0 ? entry.slice(0, qIdx) : entry;
    const query = qIdx >= 0 ? entry.slice(qIdx) : '';
    let url = '';
    let remote = false;
    if (/^https?:\/\//i.test(entryPath)) {
      url = entryPath + query;
      remote = true;
    } else {
      const resolved = path.resolve(root, entryPath.replace(/^\/+/, ''));
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        console.warn(`[plugins] 插件 ${pluginName} 的部件入口越界，已忽略：${entry}`);
        continue;
      }
      const rel = path.relative(root, resolved).split(path.sep).map(encodeURIComponent).join('/');
      url = `/api/plugins/${encodeURIComponent(pluginDirName)}/ui/${rel}${query}`;
    }

    const clamp = (v: unknown, fallback: number, min: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(2000, Math.max(min, Math.floor(v))) : fallback;
    const defaultHeight = clamp(spec.defaultHeight, 240, 80);
    const maxHeight = Math.max(defaultHeight, clamp(spec.maxHeight, 800, 80));
    const allowed = Array.isArray(spec.allowedConnections)
      ? spec.allowedConnections.filter((v): v is string => typeof v === 'string' && !!v.trim())
      : undefined;
    out.push({
      key: `${pluginName}:${id}`,
      pluginDir: pluginDirName,
      pluginName,
      id,
      title: typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim() : undefined,
      description: typeof spec.description === 'string' ? spec.description : undefined,
      url,
      placement: spec.placement === 'panel' ? 'panel' : 'inline',
      defaultHeight,
      maxHeight,
      // 远程页面无法获得宿主同源权限，即使插件声明了也强制关掉
      sameOrigin: !remote && spec.sameOrigin === true,
      defaultConnection: typeof spec.defaultConnection === 'string' && spec.defaultConnection.trim()
        ? spec.defaultConnection.trim() : undefined,
      allowedConnections: allowed?.length ? allowed : undefined,
      sso: spec.sso === true,
    });
  }
  return out;
}

export function getPluginsDir(): string {
  return process.env.PAW_PLUGINS_DIR
    ? path.resolve(process.env.PAW_PLUGINS_DIR)
    : path.join(DATA_DIR, 'plugins');
}

export async function readPluginsConfig(dir = getPluginsDir()): Promise<Record<string, PluginConfigEntry>> {
  try {
    const raw = await readFile(path.join(dir, 'plugins.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, PluginConfigEntry>)
      : {};
  } catch {
    return {};
  }
}

export async function writePluginsConfig(
  cfg: Record<string, PluginConfigEntry>,
  dir = getPluginsDir(),
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, 'plugins.json');
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  await rename(tmp, target);
}

export async function updatePluginConfigEntry(
  key: string,
  patch: PluginConfigEntry,
  dir = getPluginsDir(),
): Promise<Record<string, PluginConfigEntry>> {
  const cleanKey = key.trim();
  if (!cleanKey || cleanKey.includes('/') || cleanKey.includes('\\') || cleanKey === '..' || cleanKey === '.') {
    throw new Error('无效的插件标识');
  }
  const cfg = await readPluginsConfig(dir);
  const prev = cfg[cleanKey] ?? {};
  const next: PluginConfigEntry = { ...prev };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.config !== undefined) {
    if (!patch.config || typeof patch.config !== 'object' || Array.isArray(patch.config)) {
      throw new Error('config 必须是 JSON 对象');
    }
    next.config = patch.config;
  }
  cfg[cleanKey] = next;
  await writePluginsConfig(cfg, dir);
  return cfg;
}

interface ResolvedEntry {
  entry: string;
  pkgName?: string;
  pkgVersion?: string;
  pkgDescription?: string;
}

async function readPkgMeta(pluginDir: string): Promise<{ pkgName?: string; pkgVersion?: string; pkgDescription?: string; relEntry?: string }> {
  const pkgPath = path.join(pluginDir, 'package.json');
  if (!existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as {
      name?: string;
      version?: string;
      description?: string;
      main?: string;
      paw?: { entry?: string };
    };
    return {
      pkgName: pkg.name,
      pkgVersion: pkg.version,
      pkgDescription: pkg.description,
      relEntry: pkg.paw?.entry || pkg.main,
    };
  } catch {
    return {};
  }
}

async function resolvePluginEntry(pluginDir: string): Promise<ResolvedEntry | null> {
  const meta = await readPkgMeta(pluginDir);
  if (meta.relEntry) {
    const candidate = path.resolve(pluginDir, meta.relEntry);
    if (existsSync(candidate)) {
      return { entry: candidate, pkgName: meta.pkgName, pkgVersion: meta.pkgVersion, pkgDescription: meta.pkgDescription };
    }
  }
  for (const fallback of ['index.mjs', 'index.js']) {
    const candidate = path.join(pluginDir, fallback);
    if (existsSync(candidate)) {
      return { entry: candidate, pkgName: meta.pkgName, pkgVersion: meta.pkgVersion, pkgDescription: meta.pkgDescription };
    }
  }
  return null;
}

export async function loadExternalPluginsFromDir(
  registry: PluginRegistry<ServerToolExecCtx>,
  pluginsDir = getPluginsDir(),
  getGateway: () => { baseUrl: string; apiKey: string } = () => ({ baseUrl: '', apiKey: '' }),
  opts: { bustCache?: boolean } = {},
): Promise<ExternalLoadReport> {
  const report: ExternalLoadReport = {
    pluginsDir,
    loaded: [],
    disabled: [],
    skipped: [],
    failed: [],
    instances: [],
    routers: new Map(),
  };
  if (!existsSync(pluginsDir)) return report;

  const cfgMap = await readPluginsConfig(pluginsDir);
  let entries: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[];
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return report;
  }

  const cacheQuery = opts.bustCache ? `?t=${Date.now()}` : '';

  for (const dirent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;

    const dir = path.join(pluginsDir, dirent.name);
    const meta = await readPkgMeta(dir);
    const dirCfg = cfgMap[dirent.name];
    const effectiveConfig = dirCfg?.config ?? {};
    if (dirCfg?.enabled === false) {
      report.skipped.push(dirent.name);
      report.disabled.push({
        dir: dirent.name,
        name: meta.pkgName || dirent.name,
        version: meta.pkgVersion,
        description: meta.pkgDescription,
        config: effectiveConfig,
      });
      continue;
    }

    try {
      const resolved = await resolvePluginEntry(dir);
      if (!resolved) {
        report.failed.push({
          dir: dirent.name,
          name: meta.pkgName,
          version: meta.pkgVersion,
          description: meta.pkgDescription,
          config: effectiveConfig,
          error: '未找到入口文件（package.json main / index.mjs / index.js）',
        });
        continue;
      }
      const mod = (await import(pathToFileURL(resolved.entry).href + cacheQuery)) as {
        default?: ExternalPluginExport;
        plugin?: ExternalPluginExport;
      };
      const exported = mod.default ?? mod.plugin;
      if (!exported) {
        report.failed.push({
          dir: dirent.name,
          name: resolved.pkgName,
          version: resolved.pkgVersion,
          description: resolved.pkgDescription,
          config: effectiveConfig,
          error: '入口未导出 default 或 plugin',
        });
        continue;
      }
      const host: PluginHostApi = {
        dataDir: DATA_DIR,
        pluginDir: dir,
        config: effectiveConfig,
        getGateway,
        resolveToolPath,
        getWorkspaceRoot,
        workspace: {
          getRoot: getWorkspaceRoot,
          list: listWorkspaces,
          resolvePath: resolveToolPath,
        },
        mcp: {
          listServers: mcpServerViews,
          listTools: mcpToolSchemas,
          callTool: (name, args = {}, signal) => executeMcpTool(name, args, signal),
        },
        tools: {
          list: (ctx = {}) => [...registry.getSchemas(ctx), ...mcpToolSchemas()],
          execute: async (name, args = {}, ctx = {}) => {
            const callId = `plugin-${dirent.name}-${Date.now()}`;
            const execCtx: ServerToolExecCtx = {
              depth: 0,
              emit: () => {},
              ...ctx,
            };
            const built = await registry.execute(name, args, callId, execCtx);
            if (built) return built;
            const mcpRes = await executeMcpTool(name, args, ctx.signal);
            if (mcpRes) return mcpRes;
            return { tool_call_id: callId, content: `Unknown tool: ${name}`, isError: true };
          },
        },
        connections: {
          load: loadConnections,
          get: getConnection,
          call: callConnection,
          registerAuthProvider: registerConnectionAuthProvider,
          unregisterAuthProvider: unregisterConnectionAuthProvider,
          registerSsoProvider: registerConnectionSsoProvider,
          unregisterSsoProvider: unregisterConnectionSsoProvider,
        },
        memory: {
          list: listMemories,
          upsert: upsertMemoryDirect,
          remove: deleteMemoryById,
        },
        worklog: {
          list: listWorkLogs,
          insert: insertWorkLog,
          update: updateWorkLog,
          remove: deleteWorkLog,
        },
        sessions: {
          list: listSessionSummaries,
          get: getSession,
        },
        tasks: {
          list: listTasks,
          get: getTask,
          listRuns,
        },
        skills: {
          list: () => loadSkills(),
          read: (id: string) => loadSkillContent(id),
        },
        notify: notifyDone,
      };
      const plugin: ServerPawPlugin = typeof exported === 'function' ? await exported(host) : exported;
      if (!plugin || typeof plugin.name !== 'string' || !plugin.name.trim()) {
        report.failed.push({
          dir: dirent.name,
          name: resolved.pkgName,
          version: resolved.pkgVersion,
          description: resolved.pkgDescription,
          config: effectiveConfig,
          error: '插件缺少合法的 name 字段',
        });
        continue;
      }
      const byNameCfg = cfgMap[plugin.name];
      if (byNameCfg?.enabled === false) {
        report.skipped.push(plugin.name);
        report.disabled.push({
          dir: dirent.name,
          name: plugin.name,
          version: plugin.version || resolved.pkgVersion,
          description: resolved.pkgDescription,
          config: byNameCfg.config ?? effectiveConfig,
        });
        continue;
      }
      if (!plugin.version && resolved.pkgVersion) plugin.version = resolved.pkgVersion;
      registry.register(plugin);
      await plugin.hooks?.onInit?.();
      report.instances!.push(plugin);
      if (typeof plugin.routes === 'function') {
        const subApp = new Hono();
        plugin.routes(subApp);
        report.routers!.set(plugin.name, subApp);
      }
      const pages = resolvePluginPages(plugin.name, dirent.name, dir, plugin.pages);
      const widgets = resolvePluginWidgets(plugin.name, dirent.name, dir, plugin.widgets);
      report.loaded.push({
        name: plugin.name,
        version: plugin.version,
        description: resolved.pkgDescription,
        dir: dirent.name,
        entry: resolved.entry,
        tools: (plugin.tools || []).map((t) => t.schema.name),
        pages,
        widgets,
        config: byNameCfg?.config ?? effectiveConfig,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report.failed.push({
        dir: dirent.name,
        name: meta.pkgName,
        version: meta.pkgVersion,
        description: meta.pkgDescription,
        config: effectiveConfig,
        error: msg,
      });
      console.warn(`[plugins] 加载外部插件 ${dirent.name} 失败：${msg}`);
    }
  }
  return report;
}
