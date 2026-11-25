# 系统连接（Connections）说明

系统连接用于将内部或第三方 HTTP 服务登记为具名连接，供 Agent 通过 `call_api` 工具直接调用。核心目标只有三条：**固定目标域名**、**密钥不进模型上下文**、**调用可观测**。

---

## 1. 配置文件与密钥隔离

连接定义与密钥分离存储在 `~/.paw/` 下：

### `~/.paw/connections.json`（不含任何密钥）

```json
{
  "connections": [
    {
      "code": "crm",
      "kind": "http",
      "name": "CRM 接口",
      "baseUrl": "https://crm.example.com/api",
      "description": "查询客户、订单与合同数据",
      "auth": { "type": "bearer" },
      "headers": {
        "Accept-Language": "zh-CN"
      },
      "timeoutMs": 30000
    }
  ]
}
```

支持的内置 HTTP 认证方式（`auth.type`）：

| 类型 | 注入方式 |
| --- | --- |
| `none` | 不注入凭据 |
| `bearer` | `Authorization: Bearer <secret>` |
| `header` | `<auth.name>: <secret>`（如 `X-API-Key`） |
| `basic` | `Authorization: Basic base64(<secret>)`（密钥格式 `user:password`） |
| `query` | URL 查询参数 `?<auth.name>=<secret>` |

### `~/.paw/secrets.json`（权限 `0600`）

```json
{
  "crm": "sk-live-..."
}
```

- 密钥仅在服务端发请求的那一刻读取并注入，**永远不会进入模型上下文，也不会回传前端**（前端只展示 `hasSecret` 状态）。
- 通过 `body_file` 上传大请求体时，服务端会显式拦截 `secrets.json`（含软链真实路径校验），防止凭据被外发。

---

## 2. 安全边界

1. **域名与路径前缀锁死（防 SSRF）**：`call_api` 的 `path` 仅接受相对路径；带协议（`http://`）、以 `//` 开头、或解析后越出 `baseUrl` origin 与路径前缀的请求一律拒绝。
2. **敏感请求头保护**：模型传入的 `headers` 会自动过滤 `Authorization`、`Host`、`Cookie`、`Content-Length`；所有请求头采用大小写不敏感覆盖合并，避免重复头导致上游报错。
3. **响应体积上限**：读取响应流上限 `2 MB`，回填模型的正文截断至 `16,000` 字符（SSE 流式超时时保留已收到的部分数据）。
4. **URL 脱敏回显**：工具返回只输出 `METHOD <code><path> → status · ms`，不回显完整 URL，避免 `query` 认证密钥泄露到上下文。

---

## 3. 使用与检测

- **Web 管理页**：左侧进入 **系统连接**，可新增/编辑/删除连接、配置密钥与固定请求头，并使用 **「连接检测」** 填入相对路径实发一次探测请求查看状态码与格式化响应片段。
- **在对话中指定**：输入框底部点击连接图标选中目标连接，Paw 会向本轮消息注入 `<selected_connection>` 提示模型优先使用该连接调用 `call_api`。
- **大请求体上传**：当需要发送大 JSON 或二进制文件时，模型可使用 `body_file` 参数指定本地文件路径，避免大内容塞入上下文。

---

## 4. 通过外部插件扩展专有协议与页面 SSO

核心仓库只内置通用 HTTP 连接。如果企业内部系统需要专有请求签名（如 HMAC 签名头）或免密页面 SSO 换票，可通过 `~/.paw/plugins/` 外置插件扩展，无需改动主仓库代码：

- `host.connections.registerAuthProvider(provider)`：注册自定义 `kind`、配置表单字段与 `applyAuth` 签名逻辑；Web「系统连接」页会自动渲染对应类型选项与表单。
- `host.connections.registerSsoProvider(provider)`：注册页面 SSO 类型与配置字段，配合插件工具通过 `ctx.emit({ type: 'open_browser', ... })` 在内置浏览器打开业务页面。
- 未启用对应插件时，`connections.json` 中已有的扩展配置块会在读取/保存时原样透传保留，不会丢失。

具体开发示例见 [插件开发指南](./plugin-development.md#45-hostconnections系统连接与自定义协议扩展)。
