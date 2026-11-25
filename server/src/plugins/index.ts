// Paw 服务端插件注册中心：
// - STANDARD_PLUGINS：开源通用标准插件
// - EXTENSION_PLUGINS：内置扩展插件
// - 外部插件：启动时通过 loadExternalPlugins() 从 ~/.paw/plugins/（或 PAW_PLUGINS_DIR）动态加载
import { PluginRegistry, type PawPlugin } from '@paw/kernel';
import type { Hono } from 'hono';
import type { ServerPawPlugin, ServerToolExecCtx } from './types.js';
import { workspaceFsPlugin } from './workspace-fs.js';
import { shellPlugin } from './shell.js';
import { gitPlugin } from './git.js';
import { webPlugin } from './web.js';
import { memoryPlugin } from './memory.js';
import { corePlugin } from './core.js';
import { connectionsPlugin } from './connections.js';
import {
  getPluginsDir,
  loadExternalPluginsFromDir,
  updatePluginConfigEntry,
  type ExternalLoadReport,
  type PluginConfigEntry,
} from './loader.js';

export type {
  ServerToolExecCtx,
  ServerPawPlugin,
  PluginHostApi,
  PluginPageSpec,
  ResolvedPluginPage,
  ExternalPluginExport,
} from './types.js';
export {
  getPluginsDir,
  loadExternalPluginsFromDir,
  readPluginsConfig,
  writePluginsConfig,
  updatePluginConfigEntry,
  type ExternalLoadReport,
  type PluginConfigEntry,
} from './loader.js';

let currentGateway: { baseUrl: string; apiKey: string } = { baseUrl: '', apiKey: '' };

export function configurePluginsGateway(cfg: { baseUrl: string; apiKey: string }): void {
  currentGateway = cfg;
}

/** 通用标准插件（可随开源版本直接发布） */
export const STANDARD_PLUGINS: PawPlugin<ServerToolExecCtx>[] = [
  workspaceFsPlugin,
  shellPlugin,
  gitPlugin,
  webPlugin,
  memoryPlugin,
  corePlugin,
];

/** 内置扩展插件 */
export const EXTENSION_PLUGINS: PawPlugin<ServerToolExecCtx>[] = [
  connectionsPlugin,
];

export const pawPlugins = new PluginRegistry<ServerToolExecCtx>()
  .registerAll(STANDARD_PLUGINS)
  .registerAll(EXTENSION_PLUGINS);

let externalLoaded = false;
let loadedExternalInstances: ServerPawPlugin[] = [];
let loadedExternalRouters = new Map<string, Hono>();
let lastExternalReport: ExternalLoadReport = {
  pluginsDir: getPluginsDir(),
  loaded: [],
  disabled: [],
  skipped: [],
  failed: [],
};

/** 启动时加载 ~/.paw/plugins/ 下的外部插件（幂等） */
export async function loadExternalPlugins(force = false): Promise<ExternalLoadReport> {
  if (externalLoaded && !force) return lastExternalReport;
  if (force) {
    for (const p of loadedExternalInstances) {
      try { await p.hooks?.onDispose?.(); } catch { /* ignore */ }
      pawPlugins.unregister(p.name);
    }
    loadedExternalInstances = [];
    loadedExternalRouters = new Map();
  }
  externalLoaded = true;
  lastExternalReport = await loadExternalPluginsFromDir(
    pawPlugins,
    getPluginsDir(),
    () => currentGateway,
    { bustCache: force },
  );
  loadedExternalInstances = lastExternalReport.instances ?? [];
  loadedExternalRouters = lastExternalReport.routers ?? new Map();
  if (lastExternalReport.loaded.length) {
    console.log(`[plugins] 已加载外部插件：${lastExternalReport.loaded.map((p) => p.name).join(', ')}`);
  }
  return lastExternalReport;
}

export function getPluginRouter(pluginName: string): Hono | undefined {
  return loadedExternalRouters.get(pluginName);
}

/** 重新扫描并热重载所有外部插件 */
export async function reloadExternalPlugins(): Promise<ExternalLoadReport> {
  return loadExternalPlugins(true);
}

/** 更新 plugins.json 中的启停状态或私有配置，并立即热重载外部插件 */
export async function updateExternalPlugin(dirOrName: string, patch: PluginConfigEntry) {
  await updatePluginConfigEntry(dirOrName, patch, getPluginsDir());
  await reloadExternalPlugins();
  return getPluginInventory();
}

export function getPluginInventory() {
  const pages = lastExternalReport.loaded
    .flatMap((p) => p.pages || [])
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return {
    pluginsDir: lastExternalReport.pluginsDir,
    builtin: [...STANDARD_PLUGINS, ...EXTENSION_PLUGINS].map((p) => ({
      name: p.name,
      version: p.version,
      tools: (p.tools || []).map((t) => t.schema.name),
    })),
    external: lastExternalReport.loaded,
    disabled: lastExternalReport.disabled,
    skipped: lastExternalReport.skipped,
    failed: lastExternalReport.failed,
    pages,
  };
}
