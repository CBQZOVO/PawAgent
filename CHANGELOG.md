# Changelog

本文件记录 Paw 的重要变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本规范。

---

## [1.0.0-rc.2] - 2026-11-26

### Added
- **Windows (x64) 全面适配与打包**：新增 [build-app.ps1](./build-app.ps1)、[stage-app.mjs](./desktop/scripts/stage-app.mjs) 与 `Paw.ico`，补全 Windows 下的进程树终止（`taskkill`）、隐藏子进程黑窗（`windowsHide`）、PowerShell/cmd 终端参数、Conda/PATH 大小写探测、文件夹选择弹窗及前后端跨平台路径处理。
- **GitHub Actions 双平台自动构建与 Release**：新增 [.github/workflows/build.yml](./.github/workflows/build.yml)，推送 `v*` tag 时自动并行打包 `Paw-v<version>-macos-arm64.zip` 与 `Paw-v<version>-windows-x64.zip`，校验 tag 与 `package.json` 版本一致后自动发布 GitHub Release。
- **超长工具输出全文落盘、可按需读回**：工具结果被三档裁剪时，全文自动保存到 `~/.paw/truncated/`（滚动保留最近 100 份），裁剪提示附带落盘路径，模型可用 `read_file` 读回被省略的中段；落盘失败静默降级为原有提示，不影响主流程。
- **输入草稿与模型选择按会话隔离**：切换会话时自动保存当前会话的输入草稿并恢复目标会话的草稿与上次所选模型，会话之间互不串扰、草稿不再丢失。
- **模型空回复明确提示**：模型正常结束但正文一个字没有、工具也未调用时，消息区给出明确错误提示，不再静默结束。

### Changed
- **技能目录统一归拢**：默认技能目录从 `~/pawskill` 迁移至 `~/.paw/skill`（支持 `PAW_DATA_DIR` / `PAW_SKILLS_DIR` 覆盖）。

### Fixed
- 模型选择器仅展示网关实际返回的模型列表，避免硬编码默认模型在网关不可用时误导用户。

---

## [1.0.0-rc.1] - 2026-11-25

Paw 首个开源候选基线版本，完成了零依赖内核 `@paw/kernel` 抽离、免编译外置插件体系、五层上下文管理、独立上下文子代理、内置 IDE 与本地 Office 预览，以及完整开源清理。

### Added

#### 核心架构（`@paw/kernel`）
- **零运行时依赖内核包**：抽离独立 [`@paw/kernel`](./kernel/)，内置 ReAct 主循环（`runAgent`）、因果分批并发调度、防死循环护栏、工具结果三档裁剪、上下文压缩、会话交接、子代理编排与声明式 `PluginRegistry`。
- **因果分批并发与防重护栏**：
  - 同一轮工具调用按因果切分批次：连续 `subagent`（并发上限 4）、连续只读工具（并发上限 10）、写类/有状态工具（严格串行屏障）。
  - 归一化工具参数去重（忽略展示用 `summary`）、冲突 `tool_call_id` 自动重写、`parseToolArguments` 严格校验。
  - 默认 `200` 轮高预算兜底，配合连续重复（3/5/8 次）、乒乓窗口（4/6/9 次，写操作成功清空）与连续失败的非阻断 `<system-reminder>` 提醒。
- **特殊控制流**：主对话交互模式支持 `ask_user` 结构化提问暂停与恢复、`todo_write` 未完成项收尾提醒、子代理 `structured_output` 校验通过提前收尾。

#### 插件体系与可定制界面
- **免编译外置插件加载器**：启动时自动扫描 `~/.paw/plugins/*/`（或 `PAW_PLUGINS_DIR`），原生 ESM 动态加载，单插件异常隔离不拖垮主服务；支持 `plugins.json` 启停与私有配置注入。
- **Web 插件管理页与热重载**：新增 **MCP · SKILL · 插件 → 插件** 管理页与 `GET /api/plugins`、`PUT /api/plugins/:name`、`POST /api/plugins/reload` 接口，支持一键启停、在线编辑 JSON 配置与带 `hooks.onDispose()` 清理的热重载。
- **可定制侧栏菜单与自定义页面**：外部插件可声明 `pages`（指定默认 `order`、内置图标或 emoji）与专属 Hono 后端路由 `routes(router)`（自动挂载至 `/api/plugin-api/<plugin.name>/*` 并静态托管 `/api/plugins/:dir/ui/*`）；左侧菜单支持用户直接拖拽排序并持久化。
- **完整宿主扩展 API（`PluginHostApi`）**：向外部插件统一暴露 `workspace`、`mcp`、`tools`、`connections`（含 `call` 与自定义认证/SSO 提供器注册）、`memory`、`worklog`、`sessions`、`tasks`、`skills`、`notify` 与 `getGateway()`。

#### 上下文管理、子代理与记忆
- **五层上下文管理**：
  - 按 `mtime` 缓存加载 `~/.paw/persona/`（可选）与内置证据纪律、执行手册及动态环境索引。
  - 单轮大结果三档动态头尾裁剪（`10k/2k`、`6k/1.5k`、`2.5k/700`），前端卡片保留全文。
  - `1,000,000` token 窗口估算、80% 阈值自动压缩与手动 `/compact`、原子工具组边界切分与 SHA-256 `context_checkpoints` 持久化。
  - 跨轮历史保留最近 4 轮精简真实 `tool_calls` 对，剥离旧思维链与纯文本伪造记录。
  - 双层会话交接（确定性工程状态快照 + 目标导向 LLM 摘要），新会话自动解锁 `search_parent_session` 按需回查源会话。
- **独立上下文子代理**：三层 Markdown + YAML frontmatter 定义加载（内置 `code-explorer` 与 `code-review`），支持 `spawn` / `fork` 双模式、双层工具白名单拦截、`depth >= 1` 防递归、`output_schema` 结构化输出校验与子会话落库查看。
- **按工作区隔离的记忆与工作日志**：新增记忆与工作日志管理页（支持搜索、标签、时间轴与项目归属），每轮对话结束后异步复盘提炼。

#### 工作区、内置 IDE 与桌面体验
- **内置 IDE 模式**：支持在对话与 IDE 模式间切换，集成 Monaco 编辑器（亮/暗主题、Diff 视图、代码片段右键引用）、`node-pty` 内置终端与多标签内置浏览器面板。
- **本地 Office 预览**：支持 docx / xlsx / csv / pptx / pdf / xmind 本地预览；引擎二进制不再内置进仓库，支持打包时与运行时首次预览按需从 `PAW_OFFICE_URL` 流式下载并原子落盘。
- **后台与常驻任务**：`run_command` 支持 `background` 与 `daemon` 模式、整组进程终止、跨平台 Conda/虚拟环境 PATH 探测，以及轮次/定时任务结束的系统桌面通知。

#### 系统连接、MCP、技能与网关
- **通用 HTTP 系统连接**：支持 `none` / `bearer` / `header` / `basic` / `query` 认证、`call_api` 大文件 `body_file` 上传、连接实发探测与 SSRF 域名/前缀锁死；密钥独立存于 `~/.paw/secrets.json`（`0600` 权限，永不进模型上下文）；专有认证与页面 SSO 通过插件扩展。
- **MCP、技能与定时任务**：支持 STDIO / Streamable HTTP MCP 客户端、本地 `~/.paw/skill/` 技能扫描与 `create_skill` 对话创建（含内置 lint 与路径穿越拦截）、cron 与双周定时任务调度。
- **统一网关配置与登录页**：网关地址与密钥统一存储于 `~/.paw/gateway-config.json`（`0600`）；未配置 `GATEWAY_KEY` 时启动进入登录页，先请求 `/v1/models` 验证通过再落盘，登录失败可一键展开自定义 `GATEWAY_URL`。

### Documentation & Open-Source Readiness
- 精简 [README.md](./README.md) 为开源快速上手与导航首页。
- 整理 4 篇正式文档：[技术架构与运行时设计](./docs/architecture.md)、[插件开发指南](./docs/plugin-development.md)、[技能规范与创建指南](./docs/skills.md)、[系统连接说明](./docs/connections.md)。
- 迁出全部个人人设与私有扩展模块，清理硬编码 IP 与本机路径，新增 [MIT LICENSE](./LICENSE)。
