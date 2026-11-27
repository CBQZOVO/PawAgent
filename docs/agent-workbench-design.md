# Agent 工作台体验增强设计

> 本文记录 Paw 围绕会话治理与可观测性的五项工作台能力设计（上下文用量分项、历史消息检索与会话导入导出、`/btw` 只读旁路问答、轻量会话轨迹、确认卡与按会话工具权限），目前均已落地实现。

## 0. 目标与原则

**目标**：补上会话级的可观测性、检索迁移与执行治理，让复杂任务敢交出去、过程看得清、事后查得到、换机带得走。

**非目标**：不引入 OS 级沙箱，不做独立 CLI，不做主对话 Fork，不做浏览器 DOM 注入自动化。

**工程原则**：

1. **复用现有零件**：`PluginToolMeta.readOnly/mutating`、`allowedTools`、`inspectContext`、`ConfirmDialog` 视觉语义、`ContextMeter`、`ComposerEditor` 斜杠命令体系、`ViewMessage.durationMs`、`upsertSessions`。
2. **向后兼容（additive）**：新 SSE 事件老客户端忽略，新字段缺失走原有兜底。
3. **安全默认保守（fail-closed）**：权限默认保持 `default` 不打扰；一旦用户在会话内开启 `strict`，未显式声明 `readOnly: true` 的工具（含 MCP 与外置插件）默认需要确认。
4. **旁路零污染、失败不阻断**：`/btw` 走独立接口零落库；轨迹写库失败只记日志；权限更新走专用 `PATCH` 避免覆盖未加载消息；导入校验失败整批回滚。
5. **规则朴素**：搜索用简单扫描，不上 FTS；权限规则先按工具名管理（并对 `run_command` 与 `call_api` 做最小必要护栏），暂不做复杂路径通配符。

---

## 1. 上下文用量分项（P0）

### 1.1 现状与坑点

- `inspectContext`（`kernel/src/context.ts:11`）已产出 `byCategory: { system, user, assistant, tool, tools, images }`，并已随 `ContextSampleRecord` 落入 `context_samples`。
- 当前存在 **3 处断层**：
  1. `ContextReading`（`shared/src/index.ts:111`）只有 `{ tokens, estimated }`，没有 `byCategory`。
  2. `kernel/src/loop.ts:172` 发出 `estimated: true` 后，`kernel/src/loop.ts:221` 收到网关真实 `usage.prompt` 时会再发一次 `{ tokens: usage.prompt, estimated: false }`；前端 `App.tsx:612` 是整对象替换，会导致 `byCategory` 在每轮结束瞬间被冲掉。
  3. 历史回查 `getContextReading`（`server/src/db.ts:244-264`）与手动压缩客户端 `compactContext`（`web/src/api/client.ts:39-40`）都没透传 `byCategory`，刷新页面或手动压缩后分项会丢失。

### 1.2 改动

- **契约（`shared/src/index.ts`、`kernel/src/types.ts`）**：
  - 定义 `ContextCategory = { system: number; user: number; assistant: number; tool: number; tools: number; images: number }`。
  - `ContextReading` 扩展为 `{ tokens: number; estimated: boolean; byCategory?: ContextCategory }`。
- **内核与服务端**：
  - `kernel/src/loop.ts:172` 的 `context_usage` 带上 `byCategory: plan.insight.byCategory`。
  - `kernel/src/loop.ts:221` 拿到真实 `usage.prompt` 时，**保留本轮 `byCategory: plan.insight.byCategory`**（不清空）。
  - `server/src/db.ts:244` 的 `getContextReading` 从 `context_samples.data` 同时解析并返回 `byCategory`（老样本缺该字段时省略）。
  - `server/src/index.ts:567` 的 `/api/context/compact` 已返回完整 `insight`，前端 `web/src/api/client.ts:39` 的 `compactContext` 同步透传 `byCategory`。
- **前端（`web/src/components/composer/ContextMeter.tsx`）**：
  - 菜单内展示 6 项分解：系统提示 / 用户消息 / 助手回复 / 工具结果 / 工具定义 / 图片，显示 token 数与占比。
  - 当 `reading.estimated === false` 时，明确标注「总量为网关实测，分项按本地估算占比」（因网关 tokenizer 与本地字节估算存在差异，不强行拼凑使两者相等）。

### 1.3 边界与测试

- 现有分类是 **role 维度**，一期不引入「技能 / MCP / 会话」来源维度；若后续需要，再并列新增 `bySource`。
- 测试：
  - `estimated: true` 时，`byCategory` 各项之和严格等于 `tokens`；
  - `estimated: false` 时，`byCategory` 不被二次事件冲掉；
  - `getContextReading` 能从 `context_samples` 还原 `byCategory`；老样本缺字段时 `ContextMeter` 沿用原展示不报错。

---

## 2. 历史消息搜索 + 会话导入导出（搜索 P0 / 导入导出 P1）

### 2.1 历史消息搜索（P0）

`sessions.messages` 存完整 JSON（`server/src/db.ts:20`），`listSessionSummaries` 故意不解析正文，因此搜索走独立接口，不影响侧栏加载速度。

- **接口**：新增 `GET /api/sessions/search?q=&workspace=&limit=50`。
  - **路由顺序约束**：在 `server/src/index.ts` 中必须注册在 `GET /api/sessions/:id`（第 428 行）**之前**，避免 `:id` 吞掉 `/search`。
  - 默认排除 `source === 'task' || source === 'subagent'`（与 `Sidebar.tsx:243` 的侧栏口径一致），避免搜出定时任务与子代理内部会话。
  - 若传 `workspace`，先按 `meta.workspace` 过滤再扫正文；用 `messageText()` 摊平 `ViewMessage.content`，只匹配 user / assistant 文本块，不扫工具输出。
  - 使用不区分大小写的 `String.prototype.includes`，不引入 FTS；按 `updated_at DESC` 扫描，凑满 `limit`（上限 50）提前停止。
  - 返回：`{ results: Array<{ sessionId, title, updatedAt, workspace?, messageId, role, snippet }> }`，`snippet` 为命中词前后各约 60 字截断。
- **前端**：
  - `Sidebar.tsx` 顶部增加搜索框：标题命中继续本地即时过滤；输入防抖后请求 `/api/sessions/search`，在下方展示「消息命中」分组。
  - `MessageRow.tsx` 根节点补 `data-message-id={m.id}`；点击命中项后调用 `onSelect(sessionId)`，待 `ensureLoaded` 完成，滚动定位并短暂高亮对应消息节点。

### 2.2 会话导入导出（P1）

- **接口**：
  - `GET /api/sessions/:id/export` → 返回单条 `Session` JSON，设置 `Content-Disposition: attachment`（文件名 `paw-session-<title>-<date>.json`）。
  - `POST /api/sessions/import` → body `{ sessions: Session[] }`，支持单个或批量导入，返回 `{ ok: true, imported: SessionSummary[] }`。
- **校验与安全规则**：
  - **体积与数量硬上限**：Hono 默认无全局 bodyLimit，路由内需显式校验 `Content-Length` 与实际读取字节数（上限 **20 MB**）以及数组长度（上限 **200** 条）；任一条非法则整批拒绝返回 400。
  - **形状清洗**：校验 `id / title / updatedAt / messages`（必须为数组），逐条消息经 `normalizeMessage` 规范化兼容旧版格式。
  - **绝不覆盖**：若 `id` 已存在，生成新 UUID，标题追加 `（导入）`；通过现有 `upsertSessions`（`server/src/db.ts:197`）事务写入。
  - **附件与敏感数据边界**：
    - 不导出/不导入 `context_checkpoints`、`context_samples`、`turn_traces`、`secrets.json`；
    - JSON 导出**不打包** `~/.paw/attachments/` 下的本机落盘附件；换机导入后历史附件的 `localPath` 失效属于已知边界；导出时若单条消息含超大内联 base64 图片附件，给出提示或裁剪避免超体积；
    - 导出/导入界面提示「工具输出可能含敏感信息，请确认后再分享」；
    - `workspace` 原样保留，换机后目录不存在时侧栏仍按路径分组，打开会话只读浏览不报错。
- **前端同步闭环**：
  - 导入成功后刷新会话列表，并将新导入会话 ID 同步加入 `useSessions.ts` 的 `pushableRef`（避免后续编辑无法同步或被旧快照覆盖）。

### 2.3 测试

- 搜索：大小写不敏感、排除 task/subagent、`limit` 截断、`/api/sessions/search` 不与 `/:id` 冲突。
- 导入导出：导出再导入生成新 id 且原会话不变；超体积 / 非法结构整批回滚不污染库；导入后列表可见且可正常打开。

---

## 3. `/btw` 只读旁路问答（P1）

### 3.1 行为

一问一答的临时咨询（例如“为什么这里要这样写”“这段报错什么意思”）：**零工具调用、零文件修改、不进主会话消息列表、不落库、不触发复盘记忆**，并且**支持主会话正在运行长任务时并行提问**。

### 3.2 为什么不复用 `POST /api/chat`

直接给 `POST /api/chat` 加 `mode: 'btw'` 会误触发多条主链路副作用：
- `server/src/index.ts:891-903` 轮次结束自动运行 `reflectTurn`，会往 SQLite 写记忆和工作日志（违反零落库）；
- `server/src/index.ts:731` 生图模型分支会直接执行 `generate_image`；
- `server/src/index.ts:756-819` 会触发技能加载事件、附件落盘 `persistAttachments`、视觉转文字事件；
- `server/src/index.ts:846` 会覆盖当前会话的 `activeSteerQueues`。

因此新增**独立轻量接口 `POST /api/chat/btw`**。

### 3.3 实现

- **请求契约（`shared/src/index.ts`）**：
  ```ts
  export interface BtwRequest {
    messages: ChatMessage[]; // 前端按最近 N 轮完整对话裁剪后的上下文 + 本次提问
    model?: string;
    workspace?: string | null;
  }
  ```
- **后端（`POST /api/chat/btw`）**：
  - 若 `isImageModel(model)`，直接返回 400（提示切换到对话模型）；
  - 不接受附件落盘、不注册 `activeSteerQueues`、不写 `context_samples`、不调用 `reflectTurn`；
  - 调用 `runAgent(cfg, body.messages, { maxRounds: 1, allowedTools: [], unattended: true, workspace: body.workspace, systemOverride: '只读旁路顾问：仅根据已给对话上下文直接回答用户问题，不调用工具、不修改文件、不反问。' })`（`sessionId`、`rawHistory` 均不传）；
  - 双层工具拦截：`kernel/src/loop.ts:140` 过滤全部 tool schema，`server/src/tools/index.ts:76` 在执行入口硬拒绝任何模型幻觉调用。
- **前端**：
  - 接入现有 `ComposerEditor.tsx:41` 的 `/` 命令补全（新增 `/btw `，与 `/compact`、`/handoff` 并列），并在工具条提供可选快捷切换徽标；
  - 上下文切片复用 `toChatMessages` 按**完整轮次**截取最近若干轮（避免截断产生孤立 `tool` 消息导致网关报错），再追加当前提问；
  - 使用独立 `AbortController` 与流状态，**不占用 `runningIds`，主会话忙碌时也可随时发起和停止 `/btw`**；
  - 回答渲染在输入框上方的轻量临时卡片（支持复制、关闭，刷新后自动消失，不生成工具卡片）。

### 3.4 测试

- 调用 `/api/chat/btw` 时，模型即便伪造 `write_file` / `run_command` 也被双层拦截；
- 请求完成后 SQLite 的 `sessions`、`context_samples`、`memories`、`work_logs` 均无新增记录；
- 传入生图模型返回 400；主会话运行中并行调用 `/btw` 不干扰主会话的 `activeSteerQueues` 与消息流。

---

## 4. 轻量会话轨迹（P1）

### 4.1 数据模型与生命周期

`ViewMessage.durationMs`（`shared/src/index.ts:344`）已有整轮总耗时，但缺分解。新增独立表，不污染 `context_samples`：

```sql
CREATE TABLE IF NOT EXISTS turn_traces (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_turn_traces ON turn_traces(session_id, at DESC);
```

- **清理与防膨胀（`server/src/db.ts`）**：
  - `removeSessionData()`（`server/src/db.ts:266`）删除单会话或清空会话时，**同步删除 `turn_traces`**；
  - 参照 `context_samples`，通过触发器或写后清理每个会话最多保留最近 **100** 条轨迹。
- **共享类型（`shared/src/index.ts`）**：
  ```ts
  export interface TurnTraceTool {
    id: string;
    name: string;
    start: number;
    end: number;
    ms: number;
    ok: boolean;
    rejectedByUser?: boolean;
  }

  export interface TurnTrace {
    turnId: string;
    at: number;
    totalMs: number;
    firstTextMs?: number;
    toolMs: number;          // 工具执行区间的并集耗时（并发不重复累加，不含等待审批时间）
    approvalWaitMs: number;  // 等待用户确认卡决策的累计耗时
    modelMs: number;         // 估算值：max(0, totalMs - toolMs - approvalWaitMs)
    rounds: number;
    usage?: { prompt: number; completion: number };
    model?: string;
    tools: TurnTraceTool[];
  }
  ```

### 4.2 采集

- **内核最小补充**：`kernel/src/loop.ts` 的 `done` 事件增加可选字段 `rounds?: number`（仅 2 行向后兼容改动），避免服务端去猜 `context_usage` 次数。
- **服务端旁路统计（`server/src/index.ts:848` 事件循环）**：
  - 记录 `turnStart = Date.now()`；
  - 首个 `text` 事件记录 `firstTextMs`；
  - 收到 `permission_ask` 记录等待起点，对应审批结束（或取消/超时）累加 `approvalWaitMs`，确保等待人决策的时间不污染 `toolMs` 与 `modelMs`；
  - 工具执行区间按 `tool_start`（若经过审批则从放行时刻起算）到 `tool_done` 记录，最终求时间区间**并集**得到 `toolMs`；
  - 从 `done` 取 `usage` 与 `rounds`（异常提前结束时按已观察轮次兜底）；
  - 轮次结束写 `upsertTurnTrace(sessionId, trace)`，用 `try/catch` 包住，失败只 `console.warn`，绝不阻断流收尾。
- `modelMs = Math.max(0, totalMs - toolMs - approvalWaitMs)` 在界面明确标注「模型耗时（估算）」；缓存命中字段待网关支持后再扩展。

### 4.3 接口与展示

- 新增 `GET /api/traces/:sessionId`（返回该会话的 `TurnTrace[]`）。
- **前端入口**：不往已较饱满的 `ContextMeter.tsx` 菜单继续塞入口，改为挂在 `MessageRow.tsx` 每条助手消息底部的 `durationMs` 耗时徽标（“已处理 Xs”，点击弹出或展开 `web/src/components/TracePanel.tsx`），上方汇总卡（总耗时 / 首字 / 模型估算 / 工具 / 等待确认 / 轮次 / token），下方工具调用时间线。

### 4.4 测试

- 并行工具调用时 `toolMs` 取时间区间并集而非简单求和；
- 含权限确认等待时，`approvalWaitMs` 单独计出且不计入 `modelMs`；
- 无工具轮次 `toolMs = 0`；写库异常不影响 `done` 事件；删除会话时 `turn_traces` 同步清空。

---

## 5. 确认卡与按会话工具权限（P1）

### 5.1 目标与关键约束

对有副作用的工具提供「看清具体参数再放行」。默认模式保持现状（零额外弹窗），用户在会话内显式切到严格模式。

**为什么不复用 `ask_user`**：`ask_user` 是终止当前轮次的控制信号（`server/src/tools/ask-user.ts:6`、`kernel/src/loop.ts:303`），用户答复作为下一条 user 消息开启新一轮，无法在**同一轮**内挂起并恢复某次工具调用。因此必须新增独立的 `permission_ask` 事件与审批回执链路。

### 5.2 工具风险分类（Fail-Closed）

现状中只有部分内置工具声明了 `mutating: true`：`call_api`（`server/src/plugins/connections.ts:11`）、`memory_save`/`worklog_add`（`server/src/plugins/memory.ts`）、全部 **MCP 工具**（`server/src/mcp.ts`）及未标 `meta` 的**外置插件工具**均未标 `mutating`。若仅拦 `mutating === true`，会在严格模式下漏放最危险的外部写调用。

因此调整为以下分类规则：

1. **补齐内置工具元数据**：
   - `call_api`（`server/src/plugins/connections.ts`）：利用 `PluginRegistry.isMutating` 已支持函数形态的特性（`kernel/src/plugin.ts:130-134`），声明动态判别：
     ```ts
     meta: {
       prunable: true,
       mutating: (args) => !['GET', 'HEAD', 'OPTIONS'].includes(String(args.method || 'GET').toUpperCase()),
     }
     ```
     `GET/HEAD/OPTIONS` 视为只读放行，`POST/PUT/PATCH/DELETE` 进入确认。
   - `memory_save` / `worklog_add`（`server/src/plugins/memory.ts`）：显式标 `mutating: true`。
2. **内部控制工具白名单**（不直接弹确认卡）：`todo_write`、`ask_user`、`structured_output`、`subagent`（其中 `subagent` 内部执行的所有工具会继承父会话的 `authorize`，见 5.4）。
3. **`strict` 模式判定（fail-closed）**：
   - 规则优先级：`deny`（直接拒绝） > `allow`（直接放行） > 默认分类；
   - 只读放行：`isReadOnly(name)` 为 `true`，或 `call_api` 且 `isMutating('call_api', args) === false`，或命中内部控制工具白名单 → `allow`；
   - **其余一律 `ask`**（包括全部内置 `mutating` 工具、**未显式声明 `readOnly: true` 的 MCP 工具与外置插件工具**）。
4. **`run_command` 专项安全约束**：
   - `run_command` 危害跨度极大（从 `git status` 到 `rm -rf`），因此**不提供整工具级 `allow_session`**；其确认卡按钮仅提供 `['allow_once', 'deny', 'deny_session']`，避免放行一条无害命令后本会话静默放开危险 shell 命令。

### 5.3 数据模型与防覆盖同步

- **类型扩展（`shared/src/index.ts`）**：
  ```ts
  export interface SessionPermission {
    mode: 'default' | 'strict';
    allow: string[]; // 工具名（不含 run_command）
    deny: string[];  // 工具名，优先级高于 allow
  }
  ```
  在 `Session` 与 `SessionSummary` 增加 `permission?: SessionPermission`。
- **SQLite 持久化（`server/src/db.ts`）**：
  - 同步更新 `SessionMeta`、`parseSessionMeta`、`serializeSessionMeta`；
  - 同步修复 `migrateSessionsOnce`（`server/src/db.ts:159-160`），改用统一 `serializeSessionMeta` 写回，避免迁移时丢弃 `permission` / `handoffFrom` / `handoffTo` 等字段；
  - 新增 `updateSessionPermission(id: string, permission: SessionPermission): boolean`：**只更新 `meta` 里的 `permission` 字段，绝不碰 `messages`**。
- **消除与前端 `useSessions.ts` 的竞态覆盖**：
  - 侧栏会话可能尚未加载正文（`messages: []`），**禁止**从侧栏直接调用 `PUT /api/sessions` 修改权限（否则会抹空历史消息）；
  - 新增专用接口 **`PATCH /api/sessions/:id/permission`**，侧栏右键菜单切「危险操作需确认」只调此接口；
  - `POST /api/chat/approve` 产生 `allow_session` / `deny_session` 时，服务端调用 `updateSessionPermission` 落库，同时通过当前 SSE 流发射 `{ type: 'permission_updated', permission }`（并在 HTTP 响应里也返回 `{ ok: true, permission }`）；前端收到后直接同步更新内存会话与 `snapshotRef`，不与 800ms 防抖的 `PUT /api/sessions` 产生旧值回写覆盖。

### 5.4 内核与执行链路

1. **下沉到 `@paw/kernel`**：
   - `ToolResult`（`kernel/src/types.ts`、`shared/src/index.ts`）增加可选 `rejectedByUser?: boolean`；
   - `ToolRuntime`（`kernel/src/types.ts:212`）增加可选钩子：
     ```ts
     authorize?: (
       name: string,
       args: Record<string, unknown>,
       toolCallId: string,
       ctx: ToolExecutionContext,
     ) => Promise<{ decision: 'allow' | 'deny'; reason?: string; rejectedByUser?: boolean }>;
     ```
   - `kernel/src/loop.ts` 在调用 `tools.execute` 前若存在 `tools.authorize` 则先鉴权：
     - `allow` → 正常执行 `tools.execute`；
     - `deny` → 跳过执行，直接回填 `{ tool_call_id, content: '用户拒绝执行 <工具名>：<reason>', isError: true, rejectedByUser: true }` 并正常发 `tool_done(ok: false)`。
   - **护栏不误伤（`kernel/src/loop.ts:444-454`）**：计算 `failedNames` 与 `errorRounds` 时**排除 `rejectedByUser === true` 的结果**，避免用户刚拒绝写文件，系统就向模型注入“检查路径/schema 重试”提醒，诱发模型反复弹窗重试。
2. **宿主审批实现（`server/src/agent/loop.ts` + `server/src/index.ts`）**：
   - `RunAgentOptions` 增加 `permission?: SessionPermission` 或 `authorize` 回调；
   - 当命中 `ask` 时：
     - 若 `(ctx.depth ?? 0) >= 1` 或 `unattended === true` → **直接返回 `{ decision: 'deny', reason: '后台/子代理模式不允许弹确认', rejectedByUser: true }`**，防止后台任务卡死或绕过权限；
     - 交互主代理路径 → 通过 `ctx.emit({ type: 'permission_ask', ... })` 推送确认卡，并在 `pendingApprovals: Map<string, PendingApproval>` 中挂起 Promise（key = `${sessionId}:${turnId}:${toolCallId}`，单次决策幂等）。
   - **子代理透传**：`server/src/agent/subagent.ts:44` 构造子代理 `ToolRuntime` 时必须继承父会话的 `authorize`（以 `depth >= 1` / `unattended: true` 运行），彻底封堵“主会话开 `strict` 后派子代理绕过”的漏洞。
3. **超时与连接保活**：
   - 审批超时设为 **5 分钟（300 秒）**（原 60 秒在核对长命令/切屏时过短）；
   - 等待审批期间每 25 秒向 SSE 写一条注释心跳（`: keepalive\n\n`），同时前端 `App.tsx:576` 的 360 秒无事件 watchdog 在存在未决确认卡时暂停计时，避免用户思考时被误断连；
   - 客户端断开、用户点停止、或超过 300 秒未决策 → 统一 resolve 为 `deny`，清理 `pendingApprovals`，前端把卡片标为「已取消 / 已超时」。

### 5.5 SSE 与接口

`shared/src/index.ts` 的 `AgentEvent` 增加：

```ts
| {
    type: 'permission_ask';
    id: string;
    toolCallId: string;
    tool: string;
    title: string;
    detail: string;
    options: Array<'allow_once' | 'deny' | 'allow_session' | 'deny_session'>;
  }
| {
    type: 'permission_updated';
    permission: SessionPermission;
  }
```

- `detail` 必须展示用户可核对的真实参数：文件操作显示目标路径与改动摘要、命令显示完整 `cmd`、`call_api` 显示 `connection + method + path`、MCP/外置工具显示工具名与参数 JSON 摘要（脱敏/截断），不允许只写“执行写操作”。
- `POST /api/chat/approve`：
  - Body：`{ "sessionId": "...", "id": "...", "decision": "allow_once | deny | allow_session | deny_session" }`；
  - 若 `tool === 'run_command'` 收到 `allow_session`，服务端同样降级为 `allow_once`（前后端双重护栏）；
  - 返回 `{ ok: boolean; permission?: SessionPermission }`；未知 id 或重复提交返回 `{ ok: false }` 不抛异常。
- `PATCH /api/sessions/:id/permission`：
  - Body：`{ permission: SessionPermission }`，返回 `{ ok: boolean; permission?: SessionPermission }`。

### 5.6 前端落点

- `web/src/components/PermissionCard.tsx`（新文件）：内联卡片（不遮挡滚动看上下文），展示 `detail` 全文与允许的操作按钮（沿用 `ConfirmDialog.tsx` 的按钮语义）；等待审批期间对应的工具卡显示「等待确认」状态。
- `web/src/App.tsx`：处理 `permission_ask` 与 `permission_updated` 事件；流结束或对应 `tool_done` 到达时将卡片转为已决策/已取消只读态。
- `web/src/components/Sidebar.tsx`：会话更多菜单增加「严格确认模式」开关，调用 `PATCH /api/sessions/:id/permission`，并在会话项显示轻量锁/盾徽标。

### 5.7 测试

- `kernel/tests/kernel.test.ts`：覆盖 `authorize` 的 `allow` / `deny`、以及 `rejectedByUser: true` 不触发 `errorRounds` 连续失败护栏；
- `server/tests/`：覆盖 `call_api` GET 放行 / POST 拦截、MCP/未知外置工具 fail-closed、`run_command` 拒绝升级为 `allow_session`、审批超时/停止取消/重复回执、子代理继承 `strict` 策略自动拒绝、`PATCH /api/sessions/:id/permission` 不破坏消息正文。

---

## 6. 落地状态与验收

| 阶段 | 模块 | 核心验收标准 | 状态 |
| --- | --- | --- | --- |
| **P0** | 1. 上下文用量分项 | `ContextMeter` 展示 6 类分项；真实 `usage.prompt` 到达与页面刷新后分项均不丢失；老会话兼容 | 已实现 |
| **P0** | 2.1 历史消息搜索 | 侧栏可搜历史提问与回复正文并跳回原消息；排除 task/subagent；不与 `/:id` 路由冲突 | 已实现 |
| **P1** | 3. `/btw` 只读旁路问答 | 走独立接口全程零工具调用、零落盘、不写记忆/日志；主会话忙碌时可并行问答 | 已实现 |
| **P1** | 2.2 会话导入导出 | 导出再导入生成新 id 且原会话不变；20MB/200 条硬限制；非法包整批回滚 | 已实现 |
| **P1** | 4. 轻量会话轨迹 | 每条回复可查看总耗时/首字/模型估算/工具并集/等待确认/轮次/token；写库失败不阻断；删会话同步清理 | 已实现 |
| **P1** | 5. 确认卡与工具权限 | `strict` 下未标 `readOnly` 工具 fail-closed 弹卡；`run_command` 禁整工具会话放行；拒绝不触发失败重试护栏；子代理不可绕过；`PATCH` 切权限不抹空历史 | 已实现 |

## 7. 回退开关

- **上下文分项**：缺 `byCategory` 时 `ContextMeter` 沿用旧文案。
- **搜索 / 导入导出**：纯新增接口与侧栏入口，移除入口即回退。
- **`/btw`、轻量轨迹**：独立接口与独立展示入口，不侵入主聊天核心路径。
- **权限确认卡**：默认 `default` 模式完全保持现状；异常时通过 `PATCH /api/sessions/:id/permission` 切回 `default`。
