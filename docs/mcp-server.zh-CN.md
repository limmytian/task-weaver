# 通过 MCP 客户端使用 Task Weaver

0.3.10 的 MCP Server 通过本地 stdio 或远程 Streamable HTTP 提供 29 个协作工具。
已有 MCP Registry 用于把外部工具接入 Task Weaver，原有 `tw mcp` 命令保持兼容。
英文规范见 [MCP Server](mcp-server.md)，工具契约见 [实现契约](mcp-server-contract.md)。

## 认证与接入

两种方式都需要包含 0.3.10 MCP 实现的 API 服务。本地方式还需要匹配的 CLI。
首版使用绑定主体的 scoped API Key；只读授权使用 `resource.read`，需要写入时再增加
`resource.write`。项目选择不会扩大密钥权限。代理使用独立身份、项目成员关系及密钥；
个人空间归属来自服务端核验的管理者身份，仍需明确的个人空间授权。

在客户端秘密设置或已有 CLI 配置中保存密钥，不要写入仓库、URL 或截图。
撤销密钥后，已连接客户端的后续调用也会被拒绝。浏览器 Cookie、OAuth-only 接入及
动态客户端注册不在首版范围内。

### 本地 stdio

通过已有 `tw auth` 设置配置 API 地址和密钥，或在客户端的进程环境中设置
`TW_API_URL`、`TW_API_KEY`。API 地址不包含 `/api/v1`。

```sh
tw mcp serve --read-only
```

通用客户端配置如下；密钥另外通过客户端秘密管理或 CLI 配置提供：

```json
{
  "mcpServers": {
    "task-weaver": {
      "command": "tw",
      "args": ["mcp", "serve", "--read-only"],
      "env": {
        "TW_API_URL": "https://api.task-weaver.example.com"
      }
    }
  }
}
```

客户端无法找到命令时使用 `tw` 的绝对路径。需要写入时移除 `--read-only`，并确认密钥
具有写权限。CLI 初始化前校验密钥，每次工具调用再次通过认证 REST 校验权限。
stdout 仅包含 MCP 协议，日志写入 stderr；EOF、SIGINT、SIGTERM 会关闭传输。

### 远程 Streamable HTTP

客户端地址为 `https://api.task-weaver.example.com/api/v1/mcp-server`，每次请求都必须
携带 `Authorization: Bearer <API_KEY>`。在客户端秘密设置中配置此请求头。
客户端应按官方协议设置 Accept 和协商后的 MCP-Protocol-Version。

远程入口无持久会话和重放机制，POST 返回 JSON；GET/DELETE 返回 405。
部署时使用 TLS。Host 必须与 `TW_AUTH_BASE_URL` 的主机匹配，或明确设置
`TW_MCP_ALLOWED_HOSTS`（逗号分隔的完整 `host[:port]`）；转发请求头不授予权限。
如果请求包含 Origin，必须通过现有 `TW_AUTH_TRUSTED_ORIGINS` 校验。
设置 `TW_MCP_READ_ONLY=true` 可让远程入口和本地调用所用的 REST 入口一起拒绝写入。
代理超时应大于工具调用的 30 秒期限。

## 部署位置与配置

HTTP MCP 运行在 `apps/api` 的 Hono API 服务中，使用同一进程和 3001 端口。
它不在 3000 端口的 Next.js Web 服务中，Web 默认也不会代理此路径。
入口代理需要把 `/api/v1/mcp-server` 转发到 API。API 域名与 `TW_AUTH_BASE_URL`
不同时，必须把实际 API 的 `host[:port]` 加入 `TW_MCP_ALLOWED_HOSTS`。

Compose 已透传 `TW_MCP_ALLOWED_HOSTS` 与 `TW_MCP_READ_ONLY`；主机配置为空时使用
认证基准 URL 的主机。Kubernetes 模板从可选的 `task-weaver-mcp` ConfigMap 读取
`allowed-hosts`、`read-only`：

```sh
kubectl -n task-weaver create configmap task-weaver-mcp \
  --from-literal=allowed-hosts=api.task-weaver.example.com \
  --from-literal=read-only=true --dry-run=client -o yaml | kubectl apply -f -
```

按正常部署流程选取匹配的 API/Web 镜像，保留现有认证 Secret 和持久卷。
修改 ConfigMap 后需要重新创建 API Pod；建议把镜像与配置一起更新。
私有候选和最终公开镜像都应验证健康、版本/提交号、MCP 初始化/发现/读取、只读拒写
及无效密钥拒绝。参见[升级说明](ce-upgrades.md#039-to-0310-mcp-server-upgrade)。

## 协作与限制

先列出项目、搜索上下文，再创建需求和任务，认领任务、添加评论、更新状态并释放认领。
项目任务必须关联同一项目下的需求；个人任务或个人文档创建使用 `scope=personal`。
列表返回精简分页结果，详情不会展开全部历史；搜索默认最多 20 条，总上限 50 条，
返回 hasMore、匹配实体类型和文档搜索降级信息，不提供页数保证。

任务和文档字段更新可传 `expectedVersion` 检测并发修改；状态变更保留依赖及工作流
检查，但目前没有 expectedVersion 保护。cancelled 仍是终态。完成任务不代表需求验收或整合。
关联操作校验两端访问权限，只读模式同时隐藏写工具并在执行入口拒绝写入。

请求上限 1 MiB，完整工具结果上限 256 KiB（包含文本与结构化副本），每进程最多
8 个活跃工具调用。大结果明确报错，不静默截断 Markdown。超时、取消或断连不能撤销
已经提交的写入；重试前先读取当前状态，服务不会自动重试写操作。
跨独立 HTTP 请求的取消不提供持久会话保证。

| 错误或现象 | 处理 |
| --- | --- |
| 初始化失败、401 | 检查 API 地址、密钥、到期及撤销状态 |
| forbidden / not_found | 检查成员关系和密钥授权范围 |
| read_only | 确认客户端、服务端只读配置及写权限 |
| version_conflict | 重新读取记录并协调修改 |
| dependency_conflict / claim_conflict | 完成依赖或等待持有者释放 |
| validation_error | 检查需求归属、终态和工作流规则 |
| 有效密钥仍返回 403 | 检查 Host 和 Origin 白名单 |
| GET/DELETE 返回 405 | 无持久事件流和会话时的预期行为 |
| busy | 等待正在执行的调用完成 |
| timeout / cancelled / result_too_large / upstream_error | 先核对写入是否已成功，再决定是否重试 |

首版不暴露任意 REST/SQL/命令执行、daemon、Registry 管理、账号管理、发布部署、
专用工作流阶段动作；附件传输、resources、prompts 和订阅也在范围之外。

## 验证

```sh
pnpm --filter @task-weaver/contracts test
pnpm exec tsx --test packages/core/src/mcp-server/protocol.test.ts apps/api/src/routes/mcp-server.test.ts
pnpm test:mcp-postgres
```

数据库验证创建并删除一次性 pgvector 容器，不使用现有业务数据库；覆盖真实密钥、
协作约束、HTTP SDK 和 CLI stdio 子进程。2026-10-18 已在 Node.js 24.17.0 下验证官方 SDK 1.31.0 的双传输，以及 MCP Inspector
2.11.0 CLI 的本地/远程完整协作流程。设置 `TW_MCP_INSPECTOR_BIN` 为该版本的 launcher
JavaScript 入口后执行数据库命令，可复现 Inspector 验收；未设置时仅运行 SDK 验收。
Inspector 使用临时 0600 配置并在结束后删除。Web 使用的详情接口已确认可见写入结果，
浏览器视觉操作仍由用户验收。通用配置示例不代表已验证所有客户端。
