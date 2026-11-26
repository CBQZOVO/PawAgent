# Paw 插件开发指南

Paw 通过外置动态插件机制将「通用开源内核」与「个人/企业专属能力」彻底解耦。你可以在**不修改、不重新编译 Paw 源码**的前提下，通过插件为 Paw 扩展：

- **Agent 工具（`tools`）**：让模型直接调用新工具，自动接入并发池、三档裁剪、防重护栏与工具卡片渲染。
- **左侧栏菜单与自定义页面（`pages`）**：在侧栏指定位置注入入口，点开独立页面，支持用户拖拽调整顺序。
- **插件专属后端接口（`routes`）**：注册 HTTP API 供自定义页面或外部调用，支持热重载无缝切换。
- **系统连接协议与页面 SSO（`host.connections`）**：为「系统连接」扩展自定义签名认证或免密换票登录。
- **提示词块、子代理目录与生命周期钩子（`promptBlocks` / `subagentDirs` / `hooks`）**。

---

## 1. 目录结构与加载机制

### 1.1 插件目录

Paw 启动时会自动扫描外部插件目录（默认 `~/.paw/plugins/`，可通过环境变量 `PAW_PLUGINS_DIR` 覆盖）：

```text
~/.paw/plugins/
├── plugins.json                 # 可选：启停开关与各插件私有配置
├── paw-plugin-hello/            # 每个子目录（或软链）为一个独立插件
│   ├── package.json             # 推荐：声明 name / version / description / paw.entry
│   ├── index.mjs                # 插件入口（原生 ESM）
│   └── ui/                      # 可选：自定义页面静态资源
│       └── index.html
└── paw-plugin-work-center/
    └── ...
```

### 1.2 入口解析顺序

加载器按以下顺序定位插件入口文件（均通过 Node 原生 ESM `import()` 加载）：

1. `package.json` 中的 `paw.entry`
2. `package.json` 中的 `main`
3. 目录下的 `index.mjs`
4. 目录下的 `index.js`

以 `.` 开头的隐藏目录和 `node_modules` 会自动跳过。单个插件加载失败只会记录诊断信息到「插件管理」页，**不会影响 Paw 主服务及其他插件运行**。

### 1.3 导出格式

入口文件需导出 `default`（或具名 `plugin`），支持**工厂函数（推荐，可接收 `host`）**或静态对象：

```js
// 推荐：工厂函数（可同步或 async），宿主会注入 PluginHostApi
export default async function createPlugin(host) {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    tools: [/* ... */],
    pages: [/* ... */],
    routes(router) { /* ... */ },
    hooks: {
      onInit() {},
      onDispose() {},
    },
  };
}
```

---

## 2. 5 分钟快速上手

### 2.1 示例一：最小工具插件

创建 `~/.paw/plugins/paw-plugin-hello/package.json`：

```json
{
  "name": "paw-plugin-hello",
  "version": "1.0.0",
  "type": "module",
  "description": "示例：给 Agent 添加一个打招呼工具",
  "paw": { "entry": "index.mjs" }
}
```

创建 `~/.paw/plugins/paw-plugin-hello/index.mjs`：

```js
export default function createHelloPlugin(host) {
  return {
    name: 'hello',
    version: '1.0.0',
    tools: [
      {
        schema: {
          name: 'say_hello',
          description: '向指定用户打招呼，并返回当前工作区路径',
          parameters: {
            type: 'object',
            properties: {
              who: { type: 'string', description: '称呼' },
            },
            required: ['who'],
          },
        },
        meta: { readOnly: true },
        async execute(args, _toolCallId, ctx) {
          const ws = ctx.workspace || (await host.workspace.getRoot()) || '未选择工作区';
          const prefix = String(host.config.greeting || '你好');
          return `${prefix}，${args.who}！当前工作区：${ws}`;
        },
      },
    ],
  };
}
```

保存后无需重启 Paw：打开左侧 **MCP · SKILL · 插件 → 插件**，点击右上角 **「重新扫描」** 即可热加载生效。

### 2.2 示例二：带侧栏入口与自定义页面的「工作中心」插件

```js
// ~/.paw/plugins/paw-plugin-work-center/index.mjs
export default function createWorkCenterPlugin(host) {
  return {
    name: 'work-center',
    version: '1.0.0',
    pages: [
      {
        id: 'home',
        label: '工作中心',
        icon: 'briefcase',
        order: 0,              // 排在左侧栏第 1 位
        entry: 'ui/index.html',
      },
    ],
    routes(router) {
      router.get('/summary', async (c) => {
        const workspace = await host.workspace.getRoot();
        return c.json({
          workspace,
          mcpServers: host.mcp.listServers().length,
          connections: host.connections.load().length,
          recentLogs: host.worklog.list({ days: 3, limit: 10 }),
        });
      });
    },
  };
}
```

配套页面 `~/.paw/plugins/paw-plugin-work-center/ui/index.html` 直接 `fetch('/api/plugin-api/work-center/summary')` 即可拿到数据。修改 `ui/index.html` 后只需点页面右上角 **「刷新」**，无需重编译 Paw 前端。

---

## 3. 插件对象完整契约（`ServerPawPlugin`）

### 3.1 `tools`：注册 Agent 工具

每个工具项的结构如下：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema` | `ToolSchema` | 是 | `{ name, description, parameters }`，遵循 JSON Schema |
| `resolveSchema` | `(ctx) => ToolSchema \| null` | 否 | 动态生成 schema；返回 `null` 时本轮不向模型暴露该工具 |
| `available` | `(ctx) => boolean` | 否 | 动态门控；返回 `false` 时隐藏该工具 |
| `meta` | `PluginToolMeta` | 否 | 调度与上下文元数据（见下表） |
| `execute` | `(args, toolCallId, ctx) => Promise<string \| ToolResult>` | 是 | 工具执行函数；抛错会自动转为 `isError: true` 回填给模型 |
| `formatHistory` | `(content, prunableCountInRound) => string` | 否 | 自定义大结果回填模型历史前的脱敏/裁剪逻辑 |

#### `meta` 调度与裁剪标志

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `readOnly` | `boolean` | 为 `true` 时视为无副作用只读工具，进入主循环滚动并发池（上限 10） |
| `mutating` | `boolean \| ((args) => boolean)` | 为 `true` 且执行成功时，清空防重乒乓计数窗口；支持按参数动态判断（如 `args.dry_run === false`） |
| `prunable` | `boolean` | 为 `true` 时，大结果回填模型历史前自动启用三档头尾裁剪 |
| `pruneHint` | `string` | 裁剪省略处给模型的自定义续读提示 |

#### `execute` 的上下文 `ctx`（`ServerToolExecCtx`）

- `ctx.workspace`：当前会话绑定的工作区根目录（可能为 `null`）
- `ctx.signal`：`AbortSignal`，用户点击停止或超时会触发，长耗时请求/下载务必透传
- `ctx.emit(event)`：向前端流式推送实时事件（如进度条 `tool_progress`、内置浏览器 `open_browser`）
- `ctx.connectionCode`：用户在本条消息里选中的系统连接 `code`
- `ctx.depth`：子代理嵌套深度（主循环为 `0`，子代理为 `1`）
- `ctx.parentSessionId`：交接会话的源会话 ID

发送实时进度卡片示例：

```js
ctx.emit?.({
  type: 'tool_progress',
  id: toolCallId,
  name: 'my_batch_tool',
  progress: { current: 3, total: 10, label: '处理中 3/10', bytes: 102400, totalBytes: 512000 },
});
```

### 3.2 `pages`：侧栏菜单与自定义页面

```ts
interface PluginPageSpec {
  id: string;       // 插件内唯一 id（组合 key 为 plugin:<dir>:<id>）
  label: string;    // 侧栏显示名称
  icon?: string;    // 内置图标名或 emoji
  order?: number;   // 默认排序权重（默认 50）
  entry: string;    // 插件目录内相对路径（如 'ui/index.html'）或 http(s):// URL
}
```

- **默认排序权重**：内置 4 项的默认 `order` 分别为 `10`（MCP · SKILL · 插件）、`20`（系统连接）、`30`（定时任务）、`40`（记忆 · 日志）。因此：
  - `order: 0` → 自动排在第 1 位；
  - `order: 15` → 插入在「MCP · SKILL · 插件」和「系统连接」之间；
  - 用户也可以直接在侧栏**拖拽任意菜单项**自定义顺序（保存在 `localStorage` 中，优先级高于 `order`）。
- **内置图标名**：`briefcase`、`layout`、`globe`、`sparkles`、`compass`、`file`、`bar-chart`、`folder`、`plug`、`box`；传入其他字符串（如 `🧭`、`⚡`）会直接渲染为 emoji/字符图标。
- **静态资源托管**：相对路径 `entry` 会自动映射到 `GET /api/plugins/<dir>/ui/<entry>`，同目录引用的 `.js` / `.css` / 图片等资源均可直接相对加载，且严格拦截 `..` 路径穿越。

### 3.3 `routes(router)`：插件专属后端路由

`router` 是一个独立的 [Hono](https://hono.dev/) 实例，最终自动挂载在 `/api/plugin-api/<plugin.name>/*`：

```js
routes(router) {
  router.get('/items', (c) => c.json({ items: [] }));
  router.post('/items', async (c) => {
    const body = await c.req.json();
    return c.json({ ok: true, received: body });
  });
}
```

前端调用 `GET /api/plugin-api/<plugin.name>/items` 时，宿主会自动剥离前缀并将请求转发给你的 `router`。插件被禁用或热重载时，旧路由会立即卸载替换。

### 3.4 `promptBlocks`、`subagentDirs` 与 `hooks`

- `promptBlocks(ctx)`：返回字符串（或 `null`），可向 Agent 上下文注入领域约定。
- `subagentDirs`：字符串数组，声明附加子代理 Markdown 定义目录。
- `hooks`：
  - `onInit()`：插件注册完成后调用，用于初始化本地状态或连接。
  - `onTurnComplete(turn)`：每轮对话结束后回调。
  - `onDispose()`：插件重载或卸载前调用；**如果你在插件里注册了系统连接提供器、定时器或文件监听器，务必在此释放**。

---

## 4. 宿主能力大全（`PluginHostApi`）

宿主在调用插件工厂函数时传入 `host`，封装了 Paw 所有稳定内部能力，**外部插件不应 `import` Paw 主仓库的相对源码路径**。

### 4.1 基础环境与配置

| 属性 / 方法 | 说明 |
| --- | --- |
| `host.dataDir` | Paw 数据目录绝对路径（默认 `~/.paw`，受 `PAW_DATA_DIR` 控制） |
| `host.pluginDir` | 当前插件自身目录的绝对路径 |
| `host.config` | `plugins.json` 中为当前插件配置的私有 JSON 对象（无配置时为 `{}`） |
| `host.getGateway()` | 返回当前模型网关配置 `{ baseUrl, apiKey }` |
| `host.resolveToolPath(p, workspace?)` | 将相对或绝对路径安全解析为本机绝对路径 |
| `host.getWorkspaceRoot()` | 返回当前选中的工作区根目录（无工作区时为 `null`） |

### 4.2 `host.workspace`：工作区

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `getRoot` | `() => Promise<string \| null>` | 获取当前激活工作区 |
| `list` | `() => Promise<string[]>` | 获取用户已添加的全部工作区列表 |
| `resolvePath` | `(p, workspace?) => Promise<string>` | 解析工作区内/绝对路径 |

### 4.3 `host.mcp`：调用系统内 MCP 服务

插件后端可以直接调用 Paw 已连接的所有 STDIO / Streamable HTTP MCP 工具：

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `listServers` | `() => McpServerView[]` | 获取所有 MCP 服务状态（`connected` / `failed` / `connecting`、`toolCount` 等） |
| `listTools` | `() => ToolSchema[]` | 获取所有 MCP 暴露的工具 schema |
| `callTool` | `(name, args?, signal?) => Promise<ToolResult \| null>` | 调用指定 MCP 工具（名称格式 `<server>__<tool>`）；未命中返回 `null` |

```js
// 示例：在插件路由中调用系统内的 MCP 工具
router.get('/crm-orders', async (c) => {
  const res = await host.mcp.callTool('crm__list_orders', { limit: 20 });
  if (!res || res.isError) return c.json({ error: res?.content || 'MCP 未连接' }, 502);
  return c.json({ data: res.content });
});
```

### 4.4 `host.tools`：统一调用任意已注册工具

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `list` | `(ctx?) => ToolSchema[]` | 列出所有可用工具（内置 + 外部插件 + MCP） |
| `execute` | `(name, args?, ctx?) => Promise<ToolResult>` | 统一执行任意工具（先查插件注册表，再查 MCP） |

```js
const r = await host.tools.execute('git_status', {}, { workspace: await host.workspace.getRoot() });
```

### 4.5 `host.connections`：系统连接与自定义协议扩展

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `load` | `() => Connection[]` | 读取 `~/.paw/connections.json` 中的全部连接（不含密钥） |
| `get` | `(code) => Connection \| undefined` | 按 `code` 获取指定连接 |
| `call` | `(code, opts, signal?) => Promise<CallResult>` | **推荐**：直接用该连接发起 HTTP 请求，自动注入 `~/.paw/secrets.json` 中的密钥或自定义签名，插件代码无需接触凭据 |
| `registerAuthProvider` | `(provider: ConnectionAuthProvider) => void` | 注册自定义连接认证类型（如专有 HMAC 签名） |
| `unregisterAuthProvider` | `(kind: string) => boolean` | 注销自定义认证类型（在 `onDispose` 中调用） |
| `registerSsoProvider` | `(provider: ConnectionSsoProvider) => void` | 注册自定义页面 SSO 类型 |
| `unregisterSsoProvider` | `(type: string) => boolean` | 注销自定义页面 SSO 类型（在 `onDispose` 中调用） |

`host.connections.call` 示例：

```js
const res = await host.connections.call('erp', {
  method: 'GET',
  path: '/api/v1/todos',
  query: { status: 'open' },
});
if (res.ok) {
  const data = JSON.parse(res.text);
}
```

注册自定义连接认证提供器（`ConnectionAuthProvider`）后，Web 端「系统连接」页面的类型下拉框和表单字段会自动根据你声明的 `fields` 动态渲染：

```js
host.connections.registerAuthProvider({
  kind: 'my-hmac',
  label: '企业网关（HMAC 签名）',
  configKey: 'myHmac',
  fields: [
    { key: 'appId', label: 'App ID', placeholder: 'app-xxxx', required: true },
  ],
  secretLabel: 'App Secret',
  autoHeaders: ['x-my-signature', 'x-my-timestamp'],
  applyAuth({ conn, url, method, body, secret, setHeader }) {
    const appId = conn.myHmac?.appId;
    // 计算签名并注入请求头
    setHeader('X-My-App-Id', String(appId || ''));
    if (secret) setHeader('X-My-Signature', computeSign(method, url.pathname, body, secret));
  },
});
```

### 4.6 `host.memory` 与 `host.worklog`：记忆库与工作日志

| 命名空间 | 方法 | 说明 |
| --- | --- | --- |
| `host.memory` | `list(workspace?, limit?)` | 列出长期记忆条目 |
| `host.memory` | `upsert({ id?, title, content, tags?, workspace? })` | 新增或更新记忆，返回 ID |
| `host.memory` | `remove(id)` | 删除记忆 |
| `host.worklog` | `list({ workspace?, day?, days?, limit? })` | 查询工作日志（`days` 默认最近 7 天） |
| `host.worklog` | `insert({ workspace?, sessionId?, title, content, day? })` | 写入一条工作日志，返回 ID |
| `host.worklog` | `update(id, { title?, content? })` | 修改工作日志 |
| `host.worklog` | `remove(id)` | 删除工作日志 |

### 4.7 `host.sessions`、`host.tasks`、`host.skills` 与 `host.notify`

| 命名空间 | 方法 | 说明 |
| --- | --- | --- |
| `host.sessions` | `list()` / `get(id)` | 只读检索会话摘要列表与完整消息记录 |
| `host.tasks` | `list()` / `get(id)` / `listRuns(taskId?, limit?)` | 只读查询定时任务与运行历史 |
| `host.skills` | `list()` / `read(id)` | 列出 `~/.paw/skill` 下的技能并读取正文 |
| `host.notify` | `notify(text)` | 弹出本机系统桌面通知 |

---

## 5. 插件页面前端与 Paw 的通信

插件页面运行在同源 `http://127.0.0.1:8787/api/plugins/<dir>/ui/...` 下，前端 JS 除了调用自己的 `/api/plugin-api/<plugin.name>/*` 接口外，也可以直接调用 Paw 内置 HTTP API：

- `GET /api/plugins`：获取所有内置/外部插件与页面清单
- `GET /api/mcp`：获取 MCP 服务状态与工具清单
- `GET /api/connections`：获取已登记的系统连接列表（脱敏）
- `GET /api/workspace`：获取当前与全部工作区
- `GET /api/sessions` / `GET /api/sessions/:id`：获取会话列表与详情
- `GET /api/tasks` / `GET /api/task-runs`：获取定时任务与运行记录
- `GET /api/memory` / `GET /api/worklogs`：获取记忆与工作日志

---

## 6. 启停、私有配置与热重载

### 6.1 `~/.paw/plugins/plugins.json`

以插件目录名（或插件 `name`）为键，配置启停开关和私有配置：

```json
{
  "paw-plugin-work-center": {
    "enabled": true,
    "config": {
      "title": "研发工作中心"
    }
  },
  "paw-plugin-hello": {
    "enabled": false
  }
}
```

### 6.2 在 Web UI 与 API 中管理

- **Web 界面**：进入左侧 **MCP · SKILL · 插件 → 插件**，可查看全部内置/外部插件状态、一键启停、在线编辑 JSON `config` 并保存热重载，或点 **「重新扫描」** 发现新放入目录的插件。
- **管理 API**：
  - `GET /api/plugins`：查看插件清单、加载失败诊断与已注册页面
  - `PUT /api/plugins/:dir`：提交 `{ enabled?: boolean, config?: Record<string, unknown> }`，写入 `plugins.json` 并立即热重载
  - `POST /api/plugins/reload`：手动重新扫描 `~/.paw/plugins/` 并热重载所有外部插件

> 热重载时加载器会自动调用旧插件的 `hooks.onDispose()`、卸载旧工具与旧路由，并用新的 ESM 模块 URL 重新加载，侧栏菜单也会同步刷新。

---

## 7. 开发与分发最佳实践

1. **优先零第三方依赖**：Node 24 已内置 `fetch`、`FormData`、`Blob`、`node:crypto`、`node:fs/promises`、`node:sqlite`，纯 `.mjs` 插件无需 `npm install`，在开发态和打包后的 `Paw.app` 中行为完全一致。
2. **如需第三方依赖**：在插件子目录内独立 `npm install`（自带 `node_modules/`），Paw 加载时按 Node 标准 ESM 规则从插件目录向上解析，不污染主应用。
3. **务必传递 `ctx.signal`**：网络请求、子进程或批量循环要监听 `ctx.signal`，保证用户点「停止」时立刻中止。
4. **敏感信息不回显**：密钥走 `host.connections.call` 或 `host.config`（存本机 `plugins.json`），不要把 Token、Cookie 或私钥拼进工具返回文本。
5. **用 `onDispose` 保持热重载干净**：凡是在 `createPlugin` 中注册了 `registerAuthProvider`、`registerSsoProvider` 或定时器，务必在 `hooks.onDispose()` 中对应清理。
6. **私有插件独立分发**：将企业或个人私有插件放到单独的 Git 仓库中，用户只需 `git clone` 或软链（`ln -s`）到 `~/.paw/plugins/<plugin-dir>` 即可接入 Paw。
