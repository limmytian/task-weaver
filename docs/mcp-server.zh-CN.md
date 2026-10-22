# 通过 MCP 客户端使用 Task Weaver

MCP Server 通过本地 stdio 或远程 Streamable HTTP 提供协作工具，实际清单以实时发现为准。
已有 MCP Registry 用于把外部工具接入 Task Weaver，原有 `tw mcp` 命令保持兼容。
英文规范见 [MCP Server](mcp-server.md)，工具契约见 [实现契约](mcp-server-contract.md)。

可先调用 `tw_context_bootstrap` 获取小体积、按权限过滤的能力提示。
它区分可读取的技能指导与可执行的托管能力；CLI/REST 引导中的 `capabilityBootstrap`
返回同一对象。契约与加载预算见[英文规范](capabilities.md)。

## 认证与接入

两种方式都需要支持实时授权工具清单的 API 服务，本地方式还需要匹配的 CLI。
使用绑定主体的 scoped API Key；只读授权使用 `resource.read`，需要写入时再增加
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

## 规划与上下文

规划与上下文工具支持技能发现、执行切片、原子计划和有界上下文；实际清单按实时授权过滤。
API 必须在工具清单中提供对应能力，stdio 还需匹配的 CLI；最低版本边界见[升级说明](ce-upgrades.md)。

| 工具 | 用途 |
| --- | --- |
| `tw_context_bootstrap`、`tw_context_search`、`tw_context_get` | 获取使用规范、检索技能摘要、读取单个技能 |
| `tw_skill_packages_list`、`tw_skill_packages_get`、`tw_skill_package_files`、`tw_skill_package_read` | 查询活动技能包、文件元数据和有界文本 |
| `tw_execution_slices_list`、`tw_execution_slices_create`、`tw_execution_slices_update` | 规划执行阶段、更新交接摘要 |
| `tw_plan_validate`、`tw_plan_apply` | 无写入预览与原子应用计划 |
| `tw_tasks_context`、`tw_requirements_context` | 按需聚合任务或需求背景 |

先用 `tw_context_search` 的 `intent` 搜索，可指定 `projectId`、`includeGlobal`、
`includePersonal` 和 `limit`，再通过 `tw_context_get` 的 `id` 读取正文。
技能包工具使用 `packageId`，文件工具可选 `version`。文件列表用 `offset`、
`limit` 分页，返回 `nextOffset`。仅提供活动包版本和可读相对文本路径，单个文本
最多 32 KiB，不返回存储位置、主机路径和任意 manifest。检索内容本身不构成执行授权。

批量计划用 JSON 的 `plan` 参数提交，包含项目、需求、任务、切片、文档和符号引用。
完整示例见[英文规范](mcp-server.md#planning-and-context-tools)。
`tw_plan_validate` 不写入，但会检查项目及所有已有引用对象的写权限。
只读模式允许有相应写权限的密钥预览，仍拒绝应用。

`tw_plan_apply` 额外要求 UUID `idempotencyKey`。超时或响应丢失后，使用同一密钥、
相同计划和相同 key 重试，已提交结果返回 `replayed=true`；同 key 不同计划返回
`conflict`。去重记录按 API 凭据和项目隔离，在凭据生命周期内保留；轮换凭据会改变
去重范围，换 key 或凭据重试前应核对现有状态。重放仍校验当前权限；重放被拒不代表
原写入失败。业务写入和记录同事务提交，非法计划整体回滚；预览不是状态预留。

计划限制为最多 10 个需求、20 篇文档、每需求 20 个切片与 50 个任务、合计 100 个任务，
每数组最多 100 项、最多 2000 个图容器，同时遵守公共请求大小和超时限制。
仅支持同项目已有对象引用，拒绝嵌套工作流、分支、执行器、身份控制、评论笔记和
`contentFile` 本地路径。新任务从 `todo` 开始，新需求从 `draft` 或 `approved` 开始。

切片创建使用 `{id: requirementId, input: {...}}`；更新使用
`{id: sliceId, expectedUpdatedAt, patch: {...}}`，时间戳须使用读取到的精确 ISO 值。
遵守需求租约、任务归属和阶段顺序，不接管 daemon 执行通道。列表支持 `page/pageSize`，
不展开任务历史。`allowParallel` 表达有意并行的规划，不绕过其他约束。

聚合上下文参数为 `id`、`sections`、`limit`（1–20）、`offset` 和 `maxBytes`
（2048–65536，默认 32768）。分区包括 `parent/tasks/slices/dependencies/documents/claim/activity`，
默认读取 `parent/dependencies/documents/claim`；其中 `activity` 额外要求 `audit.read`。
依赖同时包含上游和下游；文档只返回摘要。标题为最多 128 字符的节选，文档摘要和切片
交接摘要最多 1024 字符，全文通过详情工具读取。

`truncatedSections/omittedSections` 明确标记未完整返回的分区。保留分区提供
`nextOffset` 和续读说明；被省略分区可单独请求并扩大预算。偏移量按分区使用，并发修改
可能改变分页。`read_committed_not_snapshot` 和 `fetchedAt` 不承诺不可变快照。
数据预算之外，完整 MCP 响应还受文本与结构化副本合计 256 KiB 限制。

部署前先备份数据库和对象，并执行新增迁移 `0071_mcp_plan_receipts`。
活动凭据的去重记录不可随意清理，否则重试可能重复写入。临时回退 0.3.10 时可以保留
这张新增表；回退后新增工具不可用，API/CLI 再升级后恢复。

## 授权、审计和审批

HTTP 与 stdio 的工具清单按当前主体、Key、scope、只读配置与禁用策略动态过滤，
每次调用重新检查实际目标。新版 stdio CLI 需要 `/api/v1/mcp-server/catalog`，
接口不可用时拒绝提供清单。工具元数据列出来源和所需权限。

`tw project discover --query NAME --json` 和 `tw_projects_discover` 需要
`global.project.discover`，只返回 ID、名称、状态，每页最多 50 条，不授予项目内容权限。
`project.create` 仍是 instance 权限。人类主体绑定的 Key 创建项目时，只为该 Key
在同一事务内授予新项目的 `resource.read` 与 `resource.write`；其他 Key、Agent、
已有或未来项目均不获权，且仍受实时成员关系、主体和凭据有效性约束。

外部 Registry 的发现要求 `mcp.invoke`、服务器 active/connected、未过期及合法目标路径。
服务器管理者可通过已知 ID 查看注册信息并恢复连接。服务器的 `readOnly=true`
只允许管理员明确声明为只读的工具；未声明工具按写操作处理。使用以下命令声明顶层项目参数：

```sh
tw mcp tool-authorization TOOL_ID --target-project-argument projectId --json
tw mcp tool-authorization READ_TOOL_ID --read-only --json
tw mcp policy tw_plan_apply approval --project PROJECT_ID --json
tw mcp approval APPROVAL_ID --json
tw mcp approve APPROVAL_ID --json
tw mcp call TOOL_ID --params '{"projectId":"PROJECT_ID"}' --approval APPROVAL_ID --json
tw mcp policy '*' deny --project PROJECT_ID --json
```

配置或批准需要有对应 scope 的 `mcp.manage` 的人类凭据。`--personal` 选择个人空间，
省略 scope 选择 global。默认策略为 `allow`，包括现有写操作；高风险操作应显式配置审批。
优先级为 deny、approval、allow；`*` 可紧急禁用整个 scope，停用服务器可禁用其外部调用。

调用返回 `approval_required` 和审批 ID。批准后以相同参数重试，inbound 参数携带
`approvalId`，Registry 使用 `--approval`。审批有效期 10 分钟且仅用一次，绑定调用者、
凭据、工具、目标状态、参数摘要、授权和策略版本。参数、资源、授权或策略变化使审批失效；
执行时重新验证调用者及批准者凭据、当前授权和目标。审批记录不保存参数正文。

`tw mcp audit --project PROJECT_ID --limit 20 --offset 0 --json` 按项目分页查看脱敏审计，
需要 `audit.read`；个人空间需要本人 `mcp.manage`，全局需要 global `audit.read`。
审计仅保存主体/凭据、scope、工具/服务器、时间、耗时、结果和稳定错误类别，
不保存参数、结果正文、密钥或上游异常。运维执行
`tw mcp audit-cleanup --project PROJECT_ID --json` 清理该 scope 超过 30 天的审计和已过期审批；
如需自动保留期限，应由外部调度器定期执行。
