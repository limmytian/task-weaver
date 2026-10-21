# 通过一个 Task Weaver 连接使用托管能力

[English canonical version](hosted-capabilities.md)。

使用限定作用域的凭据连接实例 MCP HTTP 入口 `/api/v1/mcp-server`，或将
`tw mcp serve` 配置为 stdio 服务。两种方式共享同一套授权工具。从
`tw_context_bootstrap` 开始，按需加载相关摘要、指令、依赖清单和工具 schema，
无需在客户端安装每个托管 skill，也无需逐个连接服务端托管的 MCP。
凭据与连接方式见 [MCP 配置](mcp-server.zh-CN.md)。

典型流程：

1. 通过 `tw_context_search` 发现指引，再用 `tw_context_get` 或包的 list、resolve、read
   工具读取精确指令和固定版本的依赖。
2. 用 `tw_memories_search` 搜索记忆，选中后用 `tw_memories_get` 读取，并检查来源是否变化。
   检索结果是参考证据，不会自动获得执行权限。
3. 用 `tw_mcp_search` 查找工具，读取 `tw_mcp_tool`，审核参数与 schema 哈希后确认
   `tw_mcp_call`。
4. 查询 `tw_skill_runtimes_list`，解析可执行包，审核制品哈希、运行镜像和配置哈希后，
   确认 `tw_skills_run`。
5. 审核交接内容，指定作用域与 UUID 重试键，通过 `tw_memories_record` 保存；另一个有权
   会话可直接读取，无需复制本地 skill 文件。

以连接返回的实际工具 schema 为准。每一步都会检查当前凭据、工具策略、包可见性和运行
配置；已缓存的清单不能绕过撤权。只读连接不能调用外部工具或执行 skill。
已安装插件也使用统一代理入口，安装与权限变更另行审核。

## 可用性与本地能力

读取指令无需运行容器。执行符合条件的 skill 或托管 stdio MCP，需要管理员预先配置运行
环境和精确镜像。缺少运行环境、镜像、依赖或 Secret 时会明确显示不可用及处理建议，
不会自动拉镜像或安装依赖。

涉及本机文件、设备或本地服务的能力仍需显式本地桥接；托管 worker 不会读取桌面或借用
本地凭据。通用 MCP 路径不依赖厂商原生 skill 加载；SDK 测试也不代表已验证 OAuth-only
客户端或某个厂商桌面界面。

本地验收覆盖官方 MCP SDK 的 HTTP 客户端，以及连接真实 `tw` 子进程的 stdio 客户端。
stdio 使用空 home/config 目录与无本地工具的 PATH，完成指引和依赖发现、记忆读取、
托管 MCP 调用、隔离 skill 执行及跨传输交接。厂商原生界面需单独具名验收。

## 故障与重试

CLI 对 DNS、TLS、超时、取消、连接和无效 JSON 响应提供稳定错误分类，不输出地址、凭据
或原始响应内容。按分类检查网络、证书、API 和反向代理，不关闭 TLS 校验；一次暂态失败
不足以确定根因。

写请求断线时可能已经提交，应先检查当前状态。只有明确支持幂等回执的操作，才使用相同
请求体和键重试。外部工具和 skill 执行不会自动重放；重新连接服务也不会重试之前的调用。

详细边界见[记忆](memories.md)、[skill 运行环境](skill-runtimes.md)、
[MCP 托管](mcp-hosted-runtimes.md)、[插件管理](plugin-management.md)及
[运维指南](hosted-capability-operations.md)。
