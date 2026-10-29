# Ti 执行与 Partners 接入

[English](agent-runtime.md).

Ti 是 Task Weaver 中处理明确分配的任务和定时工作的服务端 Agent，与本地
`tw daemon` 的需求通道执行器不同。服务端在 Task Weaver 内运行有界模型／工具循环，
并通过配置的 Partners Streamable HTTP MCP 后端执行沙箱操作。仅注册普通 MCP 服务
不会配置该沙箱后端。

运行时读取任务和策略，签发有范围与期限的执行委托，并在工具调用前后检查实时权限与
worker 租约。live 模式提供经授权的平台和沙箱工具；dry-run 与 disabled 不授予相同的
执行能力。模型和基础设施凭据留在可信服务中，不进入模型可见的工具参数。沙箱适配器
维护运行尝试与工作区、作业的映射；模型使用本次尝试内的操作键，不能任意选择会话。

沙箱执行、作业状态和文件操作使用 Partners MCP 适配器。当前 MCP 契约没有逐命令的
网络开关，因此任务策略禁止网络时，运行时会拒绝沙箱执行，而不是假装 shell 文本能
提供网络隔离。命令失败或操作结果未确认时运行会进入审阅；命令成功本身不能证明任务
或验收检查通过。

派发检查点和沙箱操作记录保留已接受操作的状态。带检查点的中断尝试会进入审阅，不会
作为新运行重放模型和工具。系统记录自有工作区的异步清理请求；清理未确认或远端结果
未知都不能证明操作已停止。重试或验收前请阅读[执行恢复](live-planning-recovery.md)
和[需求工作流](workflows.zh-CN.md)。

实现位于 `packages/core/src/services/ti-task-runtime.ts`、`ti-sandboxes.ts` 及相关
授权和恢复服务。`scripts/ti-runtime.live-e2e.test.ts` 与相关 PostgreSQL 测试描述了
验证范围。实际执行依赖已配置的模型、执行策略和兼容沙箱服务；源码具备功能不代表
某个部署或提供商已通过这些测试。另见[托管能力运维](hosted-capability-operations.md)
和 [Agent token 用量](agent-token-usage.md)。
