<div align="center">
  <img src="./desktop/assets/Paw.png" width="88" height="88" alt="Paw" />
  <h1>Paw</h1>
  <p><strong>开源、可插拔的本地工作区 AI Agent 桌面与 Web 应用。</strong></p>
  <p>
    <img src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&logoColor=white" alt="Node.js 24+" />
    <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Kernel-Zero--Dep-6E56CF" alt="Zero-Dep Kernel" />
    <img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT License" />
  </p>
  <p>
    <a href="#快速上手">快速上手</a> ·
    <a href="#核心能力">核心能力</a> ·
    <a href="#项目结构">项目结构</a> ·
    <a href="#文档">文档</a>
  </p>
</div>

---

Paw 是一个面向本地代码库与日常工程任务的 AI Agent：在浏览器或桌面端打开项目目录，即可读代码、改文件、跑终端、调用 MCP 与外部系统接口，并通过 `~/.paw/plugins/` 自由扩展工具与自定义页面。

## 核心能力

- **零依赖 Agent 内核（`@paw/kernel`）**：ReAct 主循环、因果并发调度、防死循环护栏、五层上下文管理、会话交接与子代理编排全部独立封装，可直接嵌入其他宿主。
- **开箱即用的工作区 + 内置 IDE**：流式对话与工具卡片、Monaco 编辑器、`node-pty` 终端、Git/检索/后台任务管理，并支持直接用**腾讯文档**打开预览 Word / Excel / PPT 等 Office 文档。
- **会话治理与可观测工作台**：上下文六类分项用量、历史消息正文检索与定位、会话 JSON 导入导出、`/btw` 只读旁路问答、每轮耗时轨迹分解，以及按会话开启的严格工具权限确认卡。
- **免编译外置插件体系**：将 `.mjs` 插件放入 `~/.paw/plugins/` 即可热加载，支持扩展 Agent 工具、自定义会话部件、左侧栏自定义页面（可拖拽排序）、专属后端路由及系统连接协议。
- **生态与自动化**：原生接入 STDIO / HTTP MCP、本地 `SKILL.md`、通用 HTTP 系统连接（密钥 `0600` 隔离不进上下文）、按工作区隔离的记忆/工作日志与定时任务。

## 快速上手

环境要求：**Node.js 24+** 与 **pnpm**。

```bash
git clone https://github.com/CBQZOVO/PawAgent.git && cd PawAgent
pnpm install
pnpm build
pnpm dev
```

1. 打开 **http://127.0.0.1:8787**。
2. 首次启动在登录页填入 `GATEWAY_KEY` 即可进入（验证通过后自动保存至 `~/.paw/gateway-config.json`；使用自建网关时，登录失败可点击 **「自定义网关？」** 填写 `GATEWAY_URL`）。
3. 点击左侧 **「工作区 +」** 选择本地项目目录，新建会话即可开始。

> **桌面端启动**：执行 `pnpm build && pnpm desktop`；打包 macOS `.app` 执行 `pnpm package-app`。

## 项目结构

```text
├── kernel/      # @paw/kernel — 零运行时依赖的 Agent 运行时与 PluginRegistry
├── shared/      # @paw/shared — 前后端共享类型与协议契约
├── server/      # @paw/server — Hono + SSE 本地服务、内置插件、外置插件加载器、SQLite
├── web/         # @paw/web    — React + Vite 前端、Monaco IDE、插件与连接管理页
├── desktop/     # @paw/desktop — Electron 桌面壳
└── docs/        # 架构设计、插件开发与使用文档
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` / `pnpm dev:web` | 启动后端热重载 / 启动前端 Vite 开发服（`5173`） |
| `pnpm typecheck` | 全仓库 TypeScript 类型检查 |
| `pnpm test` | 运行 `@paw/kernel` 与 `@paw/server` 全部测试 |
| `pnpm package-app` | 打包自包含 macOS `Paw.app` |

## 文档

| 文档 | 内容 |
| --- | --- |
| [技术架构与运行时设计](./docs/architecture.md) | `@paw/kernel` 分层、ReAct 主循环、护栏、五层上下文管理、子代理与配置清单 |
| [Agent 工作台体验增强设计](./docs/agent-workbench-design.md) | 上下文分项、历史检索与导入导出、`/btw` 旁路问答、轻量轨迹与权限确认卡设计 |
| [插件开发指南](./docs/plugin-development.md) | 外置插件开发、侧栏自定义页面、后端路由与 `PluginHostApi` 完整参考 |
| [自定义部件架构设计](./docs/custom-widgets.md) | 沙箱 iframe + Bridge 协议、双展示位与系统连接透传代理设计 |
| [技能规范与创建指南](./docs/skills.md) | `~/.paw/skill` 技能目录规范、`SKILL.md` 格式与 `create_skill` |
| [系统连接说明](./docs/connections.md) | 通用 HTTP 连接、`0600` 凭据隔离、SSRF 防护与插件协议扩展 |

## License

[MIT](./LICENSE)
