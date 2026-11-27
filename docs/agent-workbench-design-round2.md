# Agent 工作台增强设计（第二轮）

> 本文设计并记录 Paw 第二轮工作台增强的五项核心能力：**任意轮次 checkpoint 与会话分叉、只读计划模式、审批体验增强、每轮用量统计、可编辑记忆与来源治理**。五项能力均已落地；货币成本仍待网关计费口径确认（见 §5.3 / §8.4）。

## 0. 目标、原则与范围

**目标**：复用 Paw 现有运行时与工作区零件，补齐长任务与多轮协作的关键体验——让长任务敢交出去（可回退、可只读规划）、过程看得清（审批与用量）、事后改得动（记忆可编辑可溯源）。

**非目标**（本轮明确不做）：

- 不做 git worktree / 目录级工作区隔离（见 §2.3 的取舍）；
- 不做 OS 级沙箱、独立 CLI、多引擎外壳；
- 不在未确认计费口径前臆造货币成本（见 §5.3）；
- 不把 SQLite 记忆迁成 Markdown 文件，不合并 `~/.paw/persona/MEMORY.md` 与数据库记忆（见 §6.2 第 4 点）；
- 不做记忆图谱、不做 dry-run 引擎。

**工程原则**：

1. **复用现有零件**：`snapshots.ts` 的 before/after 记录、`SessionPermission.allow/deny`、`PluginToolMeta.readOnly/mutating`、`allowedTools`、`context_samples` / `turn_traces`、`MarkdownPreview` / `CodeEditor`、`upsertSessions`。
2. **additive 向后兼容**：新增字段均可选；老会话、老样本、老审批卡缺字段时走原兜底，不要求数据迁移停机。
3. **安全默认保守**：计划模式 fail-closed；`run_command` 与 `call_api` 的三重护栏不放宽；全局许可只影响之后新建的会话，不追溯已有会话。
4. **朴素优先**：不新增抽象层、不新增向量栈、不新增价格表；能用现有 JSON 列/表承载的就不建新表。

---

## 1. 能力范围与设计取舍

| 能力模块 | 核心目标 | 本轮实现方式 | 明确不做 |
| --- | --- | --- | --- |
| Checkpoint 与会话分叉 | 从任意历史消息安全试错与探索分支 | §2 的「从消息分叉 + 文件回退 + LCA 跨分支切换」 | worktree 目录级隔离、多会话分屏 |
| 只读计划模式 | 先调研出方案、再确认执行，避免直接改文件 | §3 新增 `plan` 只读模式 + 纯只读前台命令静态校验 | 独立目标模式、自定义规划协议面板 |
| 审批体验增强 | 减少重复弹窗、清晰区分超时与拒绝 | §4 全局新会话默认许可 + MCP 只读映射 + 超时实时事件 | 追溯修改已有会话权限、放宽 `run_command` 常驻放行 |
| 每轮用量统计 | 让每轮与整会话的 token 消耗及模型倍率透明可见 | §5 倍率透传 + 基于 `turn_traces` 的本地聚合统计 | 未确认计费口径前的货币成本估算 |
| 记忆可编辑与溯源 | 记忆可查出处、防撞名覆盖、支持 Markdown 预览 | §6 来源字段 + 三端冲突策略 + Markdown 编辑器 | 迁移成文件知识库、记忆图谱可视化 |

---

## 2. 功能一：任意轮次 checkpoint 与会话分叉

### 2.1 现状

- `server/src/snapshots.ts:13-88` 已有完整文件级回滚原语：`FileChange { at, path, before, after }`，记录上限 300 条，落盘于 `~/.paw/rollback/<sessionId>.json`；`rollbackAfter(sessionId, afterTs)` 倒序回放，当前内容不等于 `after` 的文件跳过（用户手改保护）。
- 唯一记录方是 `server/src/plugins/workspace-fs.ts:59-74`，只覆盖 `write_file` / `edit_file` / `delete_file`。
- 唯一触发方是 `POST /api/rewind`（`server/src/index.ts:583-590`），前端在「编辑并重发」（`web/src/App.tsx:842-872`）与「纯回退」（`App.tsx:874-903`）时调用，基线为用户消息 `ts`，**在原会话上截断消息并裁剪快照记录，是破坏性的**。
- 没有会话分叉 API。`SessionMeta`（`server/src/db.ts:94-95`）有 `parentId`，但语义已固定为子代理会话，不复用；`handoff` 是新建会话 + 双向锚点，不是拷贝消息。
- 可复用的旁路记录：`ViewMessage.content` 中的 `tool-call` 块（`shared/src/index.ts:377-392`）、`extractDeterministicState()`（`kernel/src/handoff.ts:6-61`）、`upsertSessions`（`db.ts:292-309`）。

### 2.2 设计

**接口**：`POST /api/sessions/:id/fork`，body `{ messageId: string; title?: string }`，返回 `{ session: SessionSummary }`。

**服务端步骤**（全部在 `server/src/index.ts` 会话路由区）：

1. 校验会话存在、`messageId` 属于该会话、该会话没有未决审批（`hasPendingApproval`）且不在运行中（复用 `server/src/index.ts:1078` 的 `activeSteerQueues.has(id)` 判定，或抽为 `isSessionRunning(id)`）。
2. 取消息下标 `idx`；新会话 `messages = 原 messages.slice(0, idx + 1)`（含选中消息），不修改原会话任何字段。
3. **计算文件回退基线 `baselineTs`**（避免选中助手消息时误回退该轮刚完成的改动）：
   - 若选中消息为 `user`：`baselineTs = message.ts`（回退该消息之后的所有文件写入）；
   - 若选中消息为 `assistant`：`assistant.ts` 是该轮**开始生成**的时间，早于该轮工具写入；若它不是最后一条消息，取 `baselineTs = messages[idx + 1].ts`（下一条消息开始前）；若它是最后一条消息，则**不执行文件回退**，直接继承全部快照。
4. 新会话 `id` 用 `randomUUID()`；`meta` 复制 `workspace / source / taskId / permission`，新增 `forkFrom: { sessionId, messageId, ts: baselineTs }`。`shared/src/index.ts:658-686`、`server/src/db.ts:94-95, 123-140, 252-263` 同步扩类型与解析/序列化。新会话**不复制 `context_checkpoints`**（避免 `covered > messages.length` 越界，由后续对话按需重新压缩）。
5. 文件状态还原到基线：`snapshots.ts` 增加 `revertWorkspaceTo(sessionId, baselineTs)`——复用 `rollbackAfter` 的回放逻辑，但 `prune = false`，**不裁剪原会话的快照记录**。
6. 快照继承：`forkSnapshotRecords(sourceId, targetId, baselineTs)` 把 `at <= baselineTs` 的记录复制一份写入新会话的 rollback JSON；`at > baselineTs` 的记录不继承，避免新分支后续回滚时回放错误状态。
7. `upsertSessions` 写入新会话；不导出 `forkFrom`（跨机导入会形成悬空引用，沿用现有导入只保留 `workspace` / `permission` 的边界）。

**顺带修正**：

- `rollbackAfter` 当前 `keep = c.at <= afterTs` 会把因「用户手改」而 skipped 的记录一并丢弃，导致重复回滚失去感知。改为按记录引用保留未还原项（`keep = list.filter((c) => c.at <= afterTs || skippedChanges.has(c))`），避免同路径多条记录错删。
- `snapshots.ts` 补齐 `deleteSnapshots(sessionId)` / `clearSnapshots()`，并在 `DELETE /api/sessions/:id` 与 `DELETE /api/sessions` 调用（`server/src/index.ts:572-582`），避免删除会话后残留孤立 rollback JSON。

**前端**：

- `web/src/components/MessageRow.tsx:178-194` 的消息 hover 操作栏增加「从此分叉」；api client 增加 `forkSession`。
- `web/src/App.tsx` 成功后刷新列表并切到新会话，原会话保持原样。
- 确认框必须明示三点：①原会话消息不变；②**若分叉点之后有文件改动，工作区文件会回退到分叉点状态，两个分支共用同一目录**；③建议先 `git commit` / `git stash`（并提示 `run_command` 产生的文件修改不在快照覆盖内）。

### 2.3 边界与测试

- **工作区不隔离**是本设计的明确取舍：分支只隔离会话历史，不隔离文件。要目录级隔离就得引入 worktree 与合并流程，复杂度和异常面都显著上升，本轮不做。切回旧分支前由用户用 git 管理文件状态。
- `run_command` 写文件不在快照覆盖内，分叉无法还原；确认框需提示。IDE 手动保存（`PUT /api/fs/file`）同理，但会被 `cur !== after` 的自改保护跳过，不会覆盖用户手写内容。
- `delete_file` 走 `~/.paw-trash`，回滚按路径重写内容、不还原废纸篓原件——沿用现状，不在本轮改。
- 定位用 `messageId`，`baselineTs` 只用于快照过滤；保留严格 `>` 的时间边界，同毫秒写入仍可能漏回滚，属已知边界。
- 子代理会话（`parentId` 非空）不提供分叉入口；会话删除/清空时同步清理对应 rollback JSON。
- 测试模板沿用 `server/tests/context-flow.test.ts:176-190`：①分叉后原会话消息与快照记录不变；②新会话消息截断到选中消息且无越界 `context_checkpoints`；③从 user 消息分叉回退该轮改动、从最后一条 assistant 消息分叉不误回退本轮改动；④用户手改文件被跳过且该条记录保留；⑤运行中会话拒绝分叉；⑥删除会话清理 rollback JSON。

---

## 3. 功能二：只读计划模式

### 3.1 现状

- `SessionPermission.mode` 已扩展为 `'default' | 'strict' | 'plan'`（`shared/src/index.ts`、`kernel/src/types.ts`）；`web/src/components/ModeMenu.tsx` 的 `agent/ide` 是布局模式，与权限无关。
- `strict` 是「交互式逐次确认」，不是只读。`evaluateToolPermission`（`server/src/agent/permission.ts:21-34`）已能按 `pawPlugins.isReadOnly/isMutating` 区分工具，并已有 `allow` 列表——但 `allow` 命中会直接放行，不能直接拿来做只读模式。
- `/btw`（`server/src/index.ts:880-884`）用 `allowedTools: []` 实现了零工具只读问答，但是一次性旁路，不能承载多轮调研与计划输出。
- 子代理通过 `authorize` 闭包继承父会话权限，`depth >= 1 || unattended` 时 `ask` 直接 deny（`permission.ts:152-164`）。

### 3.2 设计

**模式定义**：`SessionPermission.mode` 增加 `'plan'`，与 `default` / `strict` 互斥。`parseSessionPermission`（`server/src/db.ts:111-121`）放行新值，非法值仍回落 `default`。

**判定规则**（在 `evaluateToolPermission` 开头加 `mode === 'plan'` 分支，其余路径不动）：

1. `deny` 命中 → deny；
2. 内部只读/交互控制工具 `INTERNAL_SAFE_TOOLS`（`todo_write` / `ask_user` / `structured_output` / `subagent`）→ allow（计划阶段需要澄清需求、拆解待办及派发只读子代理调研，子代理内部仍继承 `plan` 限制）；
3. 只读工具放行：`name !== 'run_command'` 且满足以下任一条件 → allow：
   - `pawPlugins.isReadOnly(name) === true`；
   - `isMcpToolReadOnly(name) === true`（见 §4.3）；
   - `name === 'call_api' && !pawPlugins.isMutating('call_api', args)`（GET 类只读接口）；
4. 其余一律 deny——包括 `write_file` / `edit_file` / `delete_file` / `git_commit` / `memory_save` / `create_skill` / 未声明只读的 MCP 与外置插件工具；`run_command` 只有经静态验证的前台纯只读命令放行，其余 deny（见下）；
5. **`allow` 列表在 plan 模式下不生效**，避免此前累积的许可让计划模式意外获得写权限。
6. **拒绝文案区分与提示词引导**：
   - `createSessionAuthorizer`（`permission.ts:153-155`）区分 `plan` 模式拒绝与 `deny` 列表拒绝，前者返回「当前处于只读计划模式，禁止修改操作，请只做调研并输出计划」；
   - `/api/chat` 检测到 `permission.mode === 'plan'` 时，向系统提示词追加一段轻量只读计划约束，引导模型先调研并输出结构化方案，避免反复试探写工具碰壁。

**`run_command` 的实际口径**：现有工具声明里 `run_command` 整体是 mutating，无法靠工具级声明判定 `ls` / `git status` 是否只读。实现采用 `kernel/src/policy.ts` 的全称谓词静态验证器（`isSafeReadOnlyShellCommand`）：仅当前台、非 daemon/background 且每个命令段都通过只读白名单/黑名单校验时放行（如 `git status` / `git diff` / `rg`）；重定向、命令替换、写参数一律拦截，Fail-Closed。需要执行有副作用的命令时切回 `strict` 逐条批准。

**UI**：

- `web/src/components/Sidebar.tsx:329-333` 的右键菜单由「严格确认」开关改为三选项：默认 / 严格确认 / 只读计划；同时在 `Composer` 顶部或会话标题栏展示 `只读计划模式` 状态徽标并支持一键切换，避免入口过深、用户忘记当前处于只读模式。切换仍走 `PATCH /api/sessions/:id/permission`（`server/src/index.ts:550-558`），不碰 messages。
- plan 模式下，助手消息卡出现「批准计划并开始执行」按钮，仅在该轮已结束且有文本输出时显示。点击：先等待 `PATCH /api/sessions/:id/permission` 将 mode 切回 `default`（用户可自行再切 `strict`）成功，再发送简短确认消息「已批准上述计划，请按计划开始执行」（**不重复拷贝整段计划正文**，计划已在上一条助手消息上下文中，避免白耗 token）。
- **计划内容就是助手的普通 Markdown 回复**，不新增 `ContentBlock` 类型、不引入 `structured_output` 协议、不加计划专用面板。

**子代理**：`authorize` 闭包读取当前 mode，子代理在 plan 模式下同样只能调用只读工具；`depth >= 1` 的 `ask → deny` 保持不变。

### 3.3 测试

`server/tests/units.test.ts` 增补：plan 模式下写类工具、有副作用的命令、提交、记忆写入、技能创建全部 deny 且返回计划模式专属文案；`read_file` / `search_content` / `git_diff` / `web_fetch` / GET 类 `call_api` / `ask_user` / `todo_write` / `subagent` / `readOnlyHint: true` 的 MCP 工具 allow；此前 `allow` 列表含 `write_file` 时仍 deny；切回 `default` 后原有判定恢复；plan 模式下子代理无法写入。

---

## 4. 功能三：审批体验增强

### 4.1 现状更正

评审前需先纠正一处判断：**Paw 已有「本会话始终允许」按钮**（`web/src/components/PermissionCard.tsx:17-22`，对应 `allow_session`，落库于 `permission.ts:223-246`），无需重做。真实缺口是：

- 许可不能跨新会话生效；前端没有 allow/deny 的可视化管理；
- MCP 工具（`server/src/mcp.ts:119-125`）没有 readOnly 声明，strict 下一律弹卡；
- 服务端超时与前端取消在卡片上都显示为 `cancelled`，用户不知道是超时。

`run_command` 已有三重护栏：`evaluateToolPermission` 跳过 allow 命中、审批卡不给 `allow_session` 按钮、`resolveApproval` 二次降级（`permission.ts:28, 112-114, 169-171`）——本轮全部保留。

### 4.2 全局「始终允许」（只对新会话生效）

- 新增 `GET /api/permissions/global`、`PUT /api/permissions/global`，body `{ allow: string[] }`，存于 `~/.paw/permissions.json`（沿用 `server/src/paths.ts:18-22` 的 `DATA_DIR`），只存工具名，无密钥，不设特殊权限位。**服务端强校验并过滤 `run_command` 与 `call_api`**，不依赖前端隐藏按钮作为唯一防线。
- 审批卡新增按钮「所有新会话允许」（`run_command` 与 `call_api` **不显示**，理由同 §3.2 的不可静态判定），点击走 `ConfirmDialog` 二次确认后写入全局列表，同时加入当前会话的 `allow`。
- 前端在启动及 Settings 修改时缓存全局 `allow` 列表，`createSession`（`web/src/hooks/useSessions.ts:162-181`）保持同步签名，新建会话时把缓存的全局列表合并进初始 `permission.allow`；**已有会话不追溯生效**，避免静默扩权。
- Settings 增加「全局工具许可」只读列表 + 移除按钮；移除只影响之后新建的会话。
- **不新增 `PermissionDecision`、不改 `evaluateToolPermission`**：全局列表只是新会话 `allow` 的默认值来源，这是本方案保持简单的关键。

### 4.3 MCP 只读声明与超时状态

- **MCP 只读声明**（注意：`server/src/mcp.ts` 中的工具未注册到 `pawPlugins`）：
  - `server/src/mcp.ts:94-105` 缓存 MCP 工具时增加 `readOnly: t.annotations?.readOnlyHint === true`，并导出 `isMcpToolReadOnly(name: string): boolean`；
  - `evaluateToolPermission`（`server/src/agent/permission.ts:30`）与 `loop.ts:47` 的 `isReadOnly` 统一改为 `pawPlugins.isReadOnly(name) || isMcpToolReadOnly(name)`；
  - `annotations.readOnlyHint` 缺失或不为 `true` 时保持现有 fail-closed（逐次确认），不从工具描述文本猜测只读性。
- **超时状态实时同步**：
  - 现状中 `permission.ts:198-204` 超时后未通知前端，且超时返回 deny 后本轮仍继续运行，导致前端卡片一直停在 `pending` 直到整轮 `finally` 才被统一改成 `cancelled`（`web/src/App.tsx:791-797`）；
  - 在 `shared/src/index.ts` 的 `AgentEvent` 新增轻量事件 `{ type: 'permission_resolved'; id: string; status: 'timeout' | 'cancelled' }`；
  - `permission.ts` 超时分支触发时 `ctx.emit({ type: 'permission_resolved', id: approvalId, status: 'timeout' })` 并以 `reason: '等待确认超时'` 结束；前端 `App.tsx` 收到事件立即将对应 `PermissionAskItem.status` 置为 `'timeout'` 并递减 `pendingPermCountRef`，卡片显示「已超时，按拒绝处理」。心跳与前端 watchdog 不变。

### 4.4 边界与测试

测试：`global allow` 只出现在新建会话；服务端 `PUT /api/permissions/global` 强过滤 `run_command` / `call_api`；移除后已有会话不受影响；MCP `readOnlyHint: true` 在 strict / plan 下不弹卡且放行、缺失时仍弹卡/拒绝；超时发出 `permission_resolved(timeout)` 事件、卡片实时显示 timeout 且底层按 deny 处理；原有 allow_session / deny_session 行为不变。

---

## 5. 功能四：每轮用量统计（成本暂缓）

### 5.1 现状

- 7 类上下文分项（`system / skills / dialog / toolResult / agentTools / mcp / images`）由 `kernel/src/context.ts:27-60` 计算，经 `context_usage` SSE 事件、`context_samples`、API `GET /api/context/:sessionId` 到 `web/src/components/composer/ContextMeter.tsx` 全链路贯通。
- 真实 token 来自网关 SSE 末尾 usage chunk（`server/src/gateway/client.ts:128-139, 189-192`），已按轮写入 `turn_traces`（`server/src/db.ts:36-48, 277-290`）与 `context_samples`（含 `usage / model`）。`TracePanel.tsx:80-85` 已显示「Token（输入/输出）」。
- 网关 `/v1/models` 带 `rate_multiplier`（`server/src/index.ts:600-604`），已用于挑便宜的复盘模型（`server/src/reflection.ts:44-65`），但前端 `ModelInfo`（`web/src/api/client.ts:293-296`）把 `rate` 丢了。
- 没有单价、货币、累计费用概念。

### 5.2 设计

1. **透传倍率**：`ModelInfo` 增加 `rate?: number | null`，`server/src/index.ts:600-604` 返回的 `rate` 不再丢弃；`web/src/components/ModelMenu.tsx` 在模型项上显示倍率（不显示货币符号）。
2. **聚合接口**：新增 `GET /api/usage/:sessionId`，返回 `{ turns: [{ turnId, at, model, prompt, completion, rounds }], total: { prompt, completion, rounds } }`。**只读 `turn_traces`**（主键已为 `(session_id, turn_id)`，且 `usage` 已经是 `kernel/src/loop.ts:276` 整轮累计的 `usageTotal`，已有每会话 100 条裁剪触发器），**不新建表、也不混读 `context_samples`**（后者记录的是单次模型调用的上下文窗口快照，并非整轮累计用量）。接口保持纯本地 SQLite 读取，不触发外网请求。
3. **展示**：前端利用已拉取的 `/api/models` 列表按 `model` 映射倍率（未命中显示「—」）；`TracePanel` 每轮显示输入/输出 token + 倍率；`ContextMeter` 菜单增加本会话累计 token。已有「总量为网关实测，分项按本地估算占比」的口径说明保留，不强行对齐两套口径。

### 5.3 成本为什么暂缓

`rate_multiplier` 当前语义是网关渠道倍率，**不能当作单价**。在网关提供可核对的计费口径（输入/输出分别计价、货币单位、生效时间）之前，本轮只展示 token 与倍率，界面不出现任何货币数字。后续若口径明确，再以可选配置 `~/.paw/pricing.json`（默认空）按 `model + usage` 计算成本；默认空配置时仍只显示 token。

### 5.4 边界与测试

子代理 token 与因 `error`/`ask` 未产生 `done` 事件的轮次目前未落 `turn_traces.usage`，本轮不聚合；老记录缺 `model` / `usage` 时跳过累计或显示「—」不报错；聚合接口沿用现有 100 条上限并显式标注「仅最近 100 轮」。测试：多轮汇总准确；缺字段兼容；倍率透传与未命中兜底；无价格配置时不渲染货币。

---

## 6. 功能五：可编辑记忆与来源治理

### 6.1 现状

- 长期记忆与工作日志存 SQLite：`memories(id, title, content, tags, workspace, created_at, updated_at)`（`server/src/tools/memory.ts:11-28`），`work_logs(..., session_id, ...)`（`server/src/tools/worklog.ts:7-18`）；按 `workspace` 精确匹配 + `''` 通用兜底。
- 每轮结束异步复盘自动写记忆/工作日志（`server/src/index.ts:1186-1199`、`server/src/reflection.ts:75-123`），每轮把记忆标题索引注入提示词（`server/src/tools/memory.ts:159-175`）。
- 前端 `web/src/components/MemoryPage.tsx` 已有 CRUD 页面，但编辑是纯 `<textarea>`（`:340-345`），无预览；服务端 API 在 `server/src/index.ts:726-768`。
- 无来源字段、无冲突检测（只有 `reflection.ts:13` 的 prompt 层软约束）；`memory_save` 按 id 直接整条覆盖（`server/src/tools/memory.ts:115-119`）。
- `~/.paw/persona/MEMORY.md` 是独立的人设文件（`server/src/persona.ts:1-14, 104-168`），与数据库记忆是两套，命名容易混淆。

### 6.2 设计

1. **来源字段与透传链路**：
   - `memories` 表按既有 `ALTER TABLE` 迁移写法（`server/src/tools/memory.ts:22-28`）增加 `source_session_id`、`source_turn_id`（均可空 TEXT）；**不增 `supersedes` 列**（原地 `UPDATE` 覆盖时不存在历史副本，保留该列会产生自引用或悬空引用；按 §0 朴素原则不做版本链）。
   - 补齐 `turnId` 透传：`ServerToolExecCtx`（`server/src/plugins/types.ts:15-20`）、`loop.ts:33-46` 的 `execute` 上下文、`memoryPlugin`（`server/src/plugins/memory.ts:12-13`）及 `reflection.ts` 的 `TurnRecord` 统一补上 `turnId?: string`；`memory_save` 工具的来源由服务端 `ctx` 注入，**不接受模型自行填写**，避免伪造溯源。`work_logs` 已有 `session_id`，前端补展示。
2. **冲突提示（按三类调用方明确策略）**：
   - **Agent 工具 `memory_save`（未传 `id`）**：写入前按 `title + workspace` 查同名记忆；若已存在且内容相同则直接返回「已存在相同记忆」去重；若内容不同则返回文本提示（含 `existingId` 与旧内容摘要），指引模型「若要更新请传 `id: existingId` 重调，或修改标题另建」。**不做自动合并、不做向量判重**。
   - **前端管理页（`POST/PUT /api/memories`）**：新建或改标题撞名且未传 `allowDuplicate: true` 时返回 `409 Conflict` 与 `{ conflict: { existingId, existingTitle, existingContent } }`；前端弹「覆盖已有 / 另存为新条」选择——覆盖走 `PUT /api/memories/:existingId`，另存带 `allowDuplicate: true` 写入。
   - **`reflection.ts` 后台自动复盘**：无人值守场景不阻断——同名且内容相同时跳过，同名且内容不同时自动原地更新（沿用 `reflection.ts:13` 的 prompt 语义并刷新 `source_session_id / source_turn_id`）。
3. **Markdown 编辑**：`MemoryPage.tsx:327-369` 的编辑弹窗改用项目已有的 `CodeEditor`（markdown） + `MarkdownPreview` 组合，参照 `web/src/components/AgentFilePanel.tsx:301-308`；`content` 仍是纯 Markdown 字符串，存储格式不变。
4. **命名区分**：UI 文案明确「长期记忆（数据库，按工作区隔离）」与「人设文件（`~/.paw/persona/MEMORY.md`）」，不合并两套，也不新增 persona 文件的编辑入口。
5. **顺带修正（限定作用域）**：仅在 **Agent 工具层**（`memory_save(id)` / `memory_delete(id)` / `worklog_*`）校验 `workspace` 归属（只允许改当前 `workspace` 或 `''` 通用记忆），防止模型跨项目误改；管理页 HTTP API 仍允许用户在「全部工作区」视图下编辑或删除任意工作区的记忆。

### 6.3 边界与测试

不迁移 DB 记忆到 Markdown 文件；不做记忆图谱与版本历史链；不做记忆导入导出（沿用会话导入导出不含记忆的边界）；tags 仍是逗号字符串。测试：写入来源（`sourceSessionId / sourceTurnId`）可在列表/编辑弹窗看到；`memory_save` 同名不同内容给出冲突提示且不静默重复新建；管理页撞名返回 409 并支持覆盖/另存；`reflection.ts` 同名不同内容自动更新；Markdown 预览不破坏纯文本老数据；Agent 工具跨工作区 update/delete 被拒绝、管理页仍可正常管理；`''` 通用记忆仍可被所有工作区读取。

---

## 7. 落地顺序

| 批次 | 内容 | 主要文件 | 风险 |
| --- | --- | --- | --- |
| A（低） | 计划模式、MCP 只读映射、审批超时事件与卡片状态、倍率透传 + 每轮用量聚合 | `permission.ts`、`loop.ts`、`shared/index.ts`、`db.ts`、`mcp.ts`、`Sidebar.tsx`、`Composer.tsx`、`PermissionCard.tsx`、`App.tsx`、`ModelMenu.tsx`、`TracePanel.tsx` | 低，均为 additive，老客户端忽略新字段 |
| B（中） | 全局工具许可 + Settings 管理、记忆来源/冲突/Markdown 编辑 | `paths.ts`、`index.ts`、`plugins/types.ts`、`plugins/memory.ts`、`useSessions.ts`、`MemoryPage.tsx`、`memory.ts`、`reflection.ts` | 中，涉及 DB 加列与写入路径，需备份验证 |
| C（高） | checkpoint 与会话分叉 | `snapshots.ts`、`index.ts`、`db.ts`、`MessageRow.tsx`、`App.tsx` | 高，涉及工作区文件状态，需完整测试矩阵 |
| 待前置条件 | 货币成本 | 网关计费口径确认后另写设计 | — |

---

## 8. 评审待定问题

1. **§2 的工作区不隔离**是否可接受？若要目录级隔离就必须引入 worktree 与合并流程，复杂度和异常面会明显上升。
2. **§3 计划模式对 `run_command` 的静态只读放行**是否可接受？当前仅放行通过全称谓词验证的前台只读命令，且 Fail-Closed；若要进一步放宽需扩充命令白名单，属于新的攻击面。
3. **§4 全局许可只对新会话生效**是否可接受？若要求对已有会话立即生效，需要新增决策类型或遍历更新已有会话权限。
4. `rate_multiplier` 的计费口径是什么？确认前本设计不显示任何货币成本。
5. 会话导入导出是否要带上记忆及其来源？当前设计明确不带。
6. §2 顺带修正（`rollbackAfter` 按引用保留 skipped 记录 + 删除会话清理 rollback JSON）是否单独作为一个修复提交，还是随分叉一起上？
