# Ti Agent 架构设计与 Partners E2B 集成方案

本文档定义了 Task Weaver 服务端 **Ti Agent** 的重构架构，涵盖其与 **Partners**（兼容 E2B 生态的沙箱算力层）的深度集成、Chat 多会话历史管理、Token 开销统计核算以及存储优化策略。

---

## 1. 核心设计原则与定位纠偏

### 1.1 大脑 (Brain) 与算力 (Compute) 彻底分离
- **大脑（决策与编排）**：Web 界面配置的模型（`OpenAI`、`Anthropic`、`Gemini`、`DeepSeek` 等）全权充当 Agent 的“大脑”。大脑负责 ReAct 循环、任务拆解规划、反思评估、工具选择以及生成待执行的代码/脚本。
- **算力（沙箱与执行环境）**：**Partners** 全权充当 Agent 的“手脚与运行环境”（隔离算力层）。它提供标准且兼容 E2B 的沙箱能力：进程命令执行、文件系统操作、代码解释器及隔离网络。Partners 不做决策，只忠实执行大脑下发的指令。

### 1.2 彻底告别旧有“Pi”包袱（非平滑彻底切换）
- 对所有遗留的“Pi”命名（`pi_agent_model_configs`、`pi_agent_runs`、`pi_agent_policies`、`actual_pi_provider` 等）不搞平滑过渡与兼容包袱，直接彻底清除。数据库表、API 路由、前端契约及 CLI 统一重构为 `ti_agent`。

### 1.3 存储与资源极致降压策略
- **按需索取产物（On-demand Artifact Collection）**：默认情况下通过实时交互流（stdout/stderr 事件流）透传执行动态，不盲目往 Task Weaver 数据库全量存放大体积日志或产物。仅当任务明确指定产物要求（如需要提交 diff、生成测试报告、打包文件）时才收集制品。
- **持久化工作区生命周期管理**：若执行过程中申请了持久化沙箱工作区，在任务完成（无论成功或失败）后，必须显式调用清理与销毁接口，避免在 Partners 侧造成存储与容器残留泄露。

### 1.4 Chat 对话完整生命周期管理
- 针对 Chat 会话（`assistant_conversations`）提供完整管理能力：
  - 用户可随时回看历史会话。
  - 用户可开启新会话，支持自定义标题或基于首轮对话自动命名。
  - 用户可删除过期会话，级联清理关联的消息与未执行建议操作。
  - 会话与消息严格按当前用户及上下文作用域进行隔离与管理。

### 1.5 统一 Token 计量核算
- Ti Agent 的所有任务执行与 Chat 交互均统一纳入 Task Weaver 的 `agent_usage_runs` 账本体系。
- 精准统计并回填 inputTokens、outputTokens、cacheReadTokens 及 cacheWriteTokens，并在项目用量面板中统一展示。

---

## 2. 整体架构全景

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Task Weaver 业务入口                            │
│   Web 界面 (Chat / Task 委派 / Schedule) │  tw CLI (直接运行与调试)     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    Ti Agent 编排引擎 (Brain)                           │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 模型路由器: 驱动界面配置的大模型 (OpenAI / Claude / Gemini 等)    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ ReAct 决策循环: 思考 -> 工具选择 -> 生成代码 -> 观察反馈         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Token 计量器: 累计 Token 消耗并上报至 agent_usage_runs           │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ E2B 兼容通信协议
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                Partners Gateway (算力 / E2B 沙箱环境)                  │
│  ┌──────────────────────┐  ┌───────────────────┐  ┌─────────────────┐  │
│  │ 进程/终端 (Bash/PTY) │  │ 文件系统 (FS)     │  │ 代码解释器      │  │
│  └──────────────────────┘  └───────────────────┘  └─────────────────┘  │
│  生命周期: 秒级创建 -> 预热池 -> 指令执行 -> 按需取件 -> 销毁释放       │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Partners v0.1.2 驱动接口映射规范

```typescript
export interface SandboxSession {
  readonly id: string;
  commands: {
    // POST /v1/jobs (executionMode: "workspace_session") 单次命令执行
    run(command: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult>;
    // GET /v1/jobs/:id/events (SSE) 交互流式监听
    runStream(command: string, onStdout: (chunk: string) => void, onStderr: (chunk: string) => void): Promise<ExecResult>;
    // POST /v1/sessions/:id/pty -> 升级 ws://host/v1/sessions/:id/pty (双向 PTY WebSocket)
    attachPty(options?: { command?: string; cols?: number; rows?: number }): Promise<PtyStream>;
  };
  workspace: {
    // POST /v1/sessions/:id/workspace/sync (JSON 或 tar.gz 流) 秒级写入沙箱 /workspace
    syncFiles(files: Array<{ path: string; content: string }>): Promise<{ written: string[]; totalBytes: number }>;
    // GET /v1/sessions/:id/workspace/file?path=... 按需读取文件
    readFile(path: string): Promise<string>;
    // GET /v1/sessions/:id/workspace/tree?path=... 读取工作区目录树
    listTree(subpath?: string, depth?: number): Promise<WorkspaceTree>;
    // GET /v1/sessions/:id/workspace/download?path=...&archive=true 流式下载 tar.gz 产物包
    downloadArchive(paths?: string[]): Promise<NodeJS.ReadableStream>;
  };
  snapshots: {
    // POST /v1/sessions/:id/snapshots 毫秒级创建快照
    createSnapshot(metadata?: Record<string, unknown>): Promise<{ id: string; snapshotId: string }>;
  };
  preview: {
    // 反向代理映射 /preview/:sessionId/:port/* 实时预览 Web Demo
    getPreviewUrl(port: number, subpath?: string): string;
  };
  // DELETE /v1/sessions/:id 销毁沙箱并彻底回收存储工作区
  close(): Promise<void>;
}
```


---

## 3. 业务赋能深度规划 (Personal / Schedule / Task)

### 3.1 Personal (个人收件箱与日常助手)
- **智能分拣 (Inbox Triage)**：自动整理碎片化笔记与闪念待办，归纳优先级并给出关联建议。
- **轻量事务代办**：直接在个人待办中指派 Ti Agent 撰写调研摘要、初稿并附在任务详情中。

### 3.2 Schedule (周期自动化与巡检)
- **结构化模板库**：支持配置带有明确目标与脚本的巡检模板（如：代码规范检查、依赖过时巡检、周度看板汇总）。
- **执行闭环**：Ti Agent 启动 E2B 沙箱执行诊断脚本，将分析总结回填在 Task 评论区，若发现严重异常自动提醒责任人。

### 3.3 Task (任务自动化委派)
- **委派流转闭环**：
  1. 人类用户将任务负责人指定为 `task-weaver:ti-agent`。
  2. Runner 领取任务并分配 Partners E2B 沙箱。
  3. 大脑模型研读需求上下文，在沙箱中阅读代码、编写测试、实施变更。
  4. 产出结构化变更摘要（Summary + Diff + 结果报告），释放沙箱。
  5. 任务状态自动流转为 `in_review`，等待人类验收合并。

---

## 4. Partners 团队回执与跨系统任务联动备忘

### 4.1 官方回执元数据
- **收件方**：Task Weaver 研发组
- **发件方**：Partners 架构与研发团队
- **版本归属**：Partners `v0.1.2`（Git 分支：`v0.1.2`）
- **Task Weaver 需求 ID**：`a41926bd-6bc9-4f0c-85cf-048696c439f6`
- **Partners 项目 ID**：`b6da0fce-6f62-4746-b4db-2c1fbb78800e`

### 4.2 建议落地评估与对接规划

| # | 建议功能点 | Partners 现状与底层支撑 (v0.1.1) | v0.1.2 网关暴露与落地规划 | Task Weaver 联动价值 |
|---|---|---|---|---|
| 1 | **交互式终端 (PTY & Streaming)** | 底层 Pod/MicroVM 具备执行通道，但网关目前仅暴露单次命令批处理，缺少双向交互流。 | **【P0·立即落地】**在 HTTP Gateway 增加 WebSocket 升级端点，支持双向 stdin/stdout 流与 Terminal Resize。 | 彻底打通 `tw ti sandbox shell` 无缝 attach 交互调试。 |
| 2 | **双向文件秒级同步与 Git 凭据安全注入** | Git 凭据已实现严格的内存安全注入与全链路脱敏；工作区已支持文件树拉取与安全下载。 | **【P0·立即落地】**新增 `POST /v1/sessions/:id/workspace/sync` 流式打包解压端点。 | 支持 Task Weaver 将文档/Wiki 附件秒级批量映射到沙箱 `/workspace`。 |
| 3 | **持久化模板与快照复用 (Snapshot / Template)** | 已集成 CubeSandbox MicroVM 的 CubeCoW 毫秒级内存快照与分叉能力（数据面协议已跑通）。 | **【P1·规划暴露】**在网关开放 `POST /v1/sessions/:id/snapshots` 与 `POST /v1/templates`。 | 支持按项目保存依赖环境，后续任务指定 snapshotId/templateId 秒级复用。 |
| 4 | **端口临时 Web 预览与网络策略** | 已支持 K8s NetworkPolicy 出网白名单与内网拦截。 | **【P1·规划暴露】**网关实现 `/preview/:sessionId/:port/*` 反向代理通道。 | 沙箱内启动的 Vite/Next.js 等 Demo 可生成临时公开或带鉴权的预览 URL。 |
| 5 | **预热沙箱池与毫秒级冷启动** | MicroVM 单机启动已达 Sub-60ms，但缺少跨节点调度与 Pod 空转池化管理。 | **【P1·规划暴露】**网关引入 `WarmPoolManager` 维护通用预热池（Node/Python/Polyglot）。 | 使普通 Pod 与 MicroVM 均能实现 < 500ms 秒级接单，消除等待排队感知。 |

### 4.3 Partners 侧任务对应关系清单

| Partners 任务 UUID | 任务名称 | 优先级 | Task Weaver 侧承接与触发任务 |
|---|---|---|---|
| `08389eb4-815b-4592-9623-0b1660f94836` | 交互式 PTY 终端网关与 WebSocket 通道 (支持 tw ti sandbox shell) | 紧急 (P0) | `task-cli-sandbox-debug` (`tw ti sandbox shell`) |
| `6f8ab156-a559-4b85-81ce-b4d0dda1aa65` | 双向工作区文件秒级同步与批量写入接口 | 高 (P0) | `task-partners-e2b-driver` (工作区快速同步) |
| `2284de45-e827-4464-913e-7448c59e339d` | 网关层快照管理与持久化模板复用 API | 高 (P1) | `task-storage-workspace-cleanup` (快照缓存复用) |
| `1a9090b3-2197-4da6-9aba-bb1d1b6a3c4a` | 端口临时 Web 预览反向代理与出网隔离策略增强 | 中 (P1) | `task-delegation-review-loop` (Web 演示预览) |
| `01a980ee-4bcf-4781-b90f-75a2d22cd1c3` | 预热沙箱池管理器 (Warm Sandbox Pool) 与极速拉起 | 中 (P1) | `task-partners-e2b-driver` (极速获取沙箱) |

### 4.4 推进策略与执行节奏
Task Weaver 研发组将在当前第一阶段重点攻坚 **P0 级能力联动**（PTY 终端通道联调与文件批量同步接口）。随着 Partners v0.1.2 的推进，P1 级特性（快照复用、网页预览、预热池）将作为持续渐进式增强，在核心 ReAct 架构稳定后无缝接入。

