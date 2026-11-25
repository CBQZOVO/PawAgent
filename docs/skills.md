# 技能（Skills）规范与创建指南

Paw 通过 `SKILL.md` 将可复用的工作流程沉淀为本地技能，供 Agent 在匹配任务时自动加载执行。

---

## 1. 目录结构

默认扫描用户目录 `~/pawskill/`（可通过环境变量 `PAW_SKILLS_DIR` 覆盖），采用扁平目录布局，每个子目录对应一个技能：

```text
~/pawskill/
└── release-check/
    ├── SKILL.md          # 必需：YAML frontmatter + Markdown 正文
    ├── references/       # 可选：参考文档、接口规范
    ├── scripts/          # 可选：辅助脚本
    └── assets/           # 可选：模板、静态资源
```

### `SKILL.md` Frontmatter 规范

```markdown
---
id: release-check
name: release-check
description: "发版前检查流程：当用户说「发版前检查一下」「build 过了吗」时触发"
version: 1.0.0
---

# 发版前检查

1. 运行 `git status` 确认工作区干净
2. 运行 `pnpm typecheck && pnpm test`
...
```

- `name`：技能标识与目录名（支持中文，空格自动转为短横线）。
- `description`：**写清触发场景（什么时候该用）**，Paw 启动与对话时会将其注入 `<available_skills>` 清单，模型据此决定是否读取正文。

---

## 2. 使用方式

- **自动触发**：Paw 按 `mtime` 缓存扫描 `~/pawskill/*/SKILL.md`，将名称与描述注入上下文；命中任务时，Agent 使用 `read_file` 按需读取完整 `SKILL.md`。
- **手动指定**：在输入框工具栏选择指定技能，Paw 会将去掉 frontmatter 后的正文直接注入本轮 `<selected_skills>`。

---

## 3. 通过对话创建技能（`create_skill`）

可以直接让 Paw 将当前流程沉淀为技能，底层调用内置工具：

```ts
create_skill({
  name: string,          // 目录名与技能名（支持中文）
  description: string,   // 触发时机描述（必填）
  content: string,       // Markdown 正文（必填）
  files?: Array<{ path: string; content: string }>, // 可选附加文件（相对路径）
  overwrite?: boolean,   // 已存在时是否覆盖（默认 false）
})
```

### 内置校验（Lint）与安全边界

| 检查项 | 级别 | 说明 |
| --- | --- | --- |
| `name` / `description` / `content` 为空 | 拒绝写入 | 缺少描述或正文将导致技能无法触发或执行 |
| `name` 含 `/` 或 `..` | 拒绝写入 | 防止跳出技能根目录 |
| `files` 含绝对路径或 `..` | 拒绝写入 | 附加文件必须位于当前技能目录内 |
| 目标目录已存在且未传 `overwrite: true` | 拒绝写入 | 防止误覆盖已有技能 |
| `description` 超过 120 字 / 缺一级标题 / 附加文件未在正文引用 | 提示警告 | 不阻断写入，返回建议供模型进一步润色 |
