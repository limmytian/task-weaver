# Task Weaver 设计文档

> 人机协作的项目管理工具 —— 让人类和 AI Agent 在同一个平台上协同工作。

## 1. 项目概述

Task Weaver 是一个面向人机协作场景的项目管理平台。人类通过 Web UI 操作，AI Agent 通过 REST API 接入，两者是平等的参与者，共享同一套数据和业务逻辑。

### 1.1 核心能力

- **项目管理**：创建和管理多个项目，每个项目有独立的需求、任务集和看板视图
- **需求管理**：需求挂在项目下，任务必须挂在需求上，需求可与文档双向关联
- **任务系统**：完整的任务生命周期管理，支持状态流转、依赖关系、备注评论
- **知识库**：支持全局文档和项目文档，文档间双向关联，文档与任务/需求多对多关联，文档版本管理
- **双重搜索**：精准关键词搜索 + 向量语义搜索
- **实时协作**：人类可实时查看 AI Agent 的工作进展，反之亦然
- **MCP 管理**：注册和管理第三方 MCP Server，代理调用其工具
- **Memory 系统**：AI Agent 的记忆存储与检索
- **Skills 管理**：技能文件导入 DB，按 intent 语义搜索
- **Daemon 系统**：CLI daemon 注册、心跳、任务 claiming/locking
- **Webhooks**：事件驱动的外部通知，支持重试

### 1.2 核心原则

- **接口平等**：人和 AI 走同一套业务逻辑，不存在"二等公民"
- **灵活不死板**：任务状态允许自由跳转，不强制线性流转
- **关联即价值**：文档与文档、文档与任务之间的双向关联构成知识网络
- **渐进复杂度**：单 PostgreSQL 即可运行，按需扩展

---

## 2. 系统架构

### 2.1 整体架构图

```
                        ┌──────────────────────────────────────┐
                        │          @task-weaver/core           │
                        │   (业务逻辑 · Zod Schema · 类型定义)   │
                        └──────────┬───────────┬───────────────┘
                                   │           │
                 ┌─────────────────┼───────────┼─────────────────┐
                 │                 │           │                 │
                 ▼                 ▼           ▼                 ▼
          ┌────────────┐  ┌─────────────┐  ┌──────────┐  ┌───────────┐
          │  Next.js   │  │  Hono API   │  │   CLI    │  │  MCP Pool │
          │  Web App   │  │  (tRPC +    │  │  Daemon  │  │  (第三方   │
          │            │  │   REST +    │  │          │  │   MCP 连接) │
          │  apps/web  │  │   GraphQL)  │  │ apps/cli │  │           │
          └─────┬──────┘  └──────┬──────┘  └────┬─────┘  └─────┬─────┘
                │                │              │              │
                │     tRPC       │    REST API  │              │
                └───────────────►│◄─────────────┘              │
                                 │                             │
                                 ▼                             ▼
                        ┌──────────────────────────────────────┐
                        │          @task-weaver/db              │
                        │     (Drizzle ORM · 数据库访问层)       │
                        └──────────────────┬───────────────────┘
                                           │
                                           ▼
                        ┌──────────────────────────────────────┐
                        │       PostgreSQL + pgvector           │
                        │  (数据存储 · 全文搜索 · 向量搜索)       │
                        └──────────────────────────────────────┘
```

### 2.2 Monorepo 结构

```
task-weaver/
├── apps/
│   ├── web/                    # Next.js 前端应用
│   ├── api/                    # Hono API 服务 (tRPC + REST + GraphQL)
│   └── cli/                    # CLI 工具 & Daemon
├── packages/
│   ├── core/                   # 核心业务逻辑、Zod Schema、类型定义
│   ├── db/                     # Drizzle Schema、迁移、数据库客户端
│   ├── realtime/               # 实时事件类型与发布订阅抽象
│   └── ui/                     # 共享 UI 组件 (shadcn/ui)
├── skills/                     # AI Agent Skills（SKILL.md 格式）
├── docs/                       # 项目文档
├── turbo.json                  # Turborepo 配置
├── pnpm-workspace.yaml         # pnpm workspace 配置
└── package.json
```

### 2.3 技术选型

| 层级 | 技术 | 选型理由 |
|------|------|----------|
| 构建 / Monorepo | Turborepo + pnpm | 智能缓存、并行构建、严格依赖隔离 |
| 后端框架 | Hono | TypeScript 原生、极快、运行时无关 |
| 数据库 | PostgreSQL + pgvector | JSONB 存文档、tsvector 全文搜索、pgvector 向量搜索、LISTEN/NOTIFY 实时通知 |
| ORM | Drizzle ORM | 类型安全、SQL-like API、轻量无引擎二进制 |
| 前端 API | tRPC v11 | 端到端类型安全、SSE 订阅支持实时更新 |
| 通用 API | REST (Hono Routes) | 通用兼容，任何语言/工具均可调用 |
| GraphQL | Hono route | 灵活查询 |
| 前端框架 | Next.js 15 (App Router) | RSC 性能优化、文件路由 |
| UI 组件 | shadcn/ui + Tailwind CSS | 代码可控、无许可证限制、基于 Radix 可访问性原语 |
| 数据校验 | Zod | tRPC/REST 共用同一套 Schema |
| 文档编辑 | Markdown (CodeMirror + react-markdown + Mermaid) | AI-friendly, 支持 `[[wiki-link]]`、Mermaid 图表 |
| 向量 Embedding | OpenAI text-embedding-3-small 或可替换 | 1536 维，成本低 |

---

## 3. 数据模型

### 3.1 ER 关系总览

```
┌──────────┐       ┌────────────────┐       ┌──────────────┐
│ projects │──1:N──│ requirements   │──1:N──│    tasks      │
└────┬─────┘       └───────┬────────┘       └──────┬───────┘
     │                     │                       │
     │              ┌──────┴───────┐         ┌─────┴──────┐
     │              │ doc_req_links│         │  comments  │
     │              └──────────────┘         ├────────────┤
     │                                       │  task_deps │
     │                                       ├────────────┤
     │                                       │ task_notes │
     │                                       ├────────────┤
     │                                       │ status_log │
     │                                       └────────────┘
     │
     └──1:N──┌──────────────┐    ┌──────────────┐
             │  documents   │    │   memories   │
             └──────┬───────┘    └──────────────┘
                    │
              ┌─────┴──────┐    ┌──────────────────┐
              │  doc_links │    │  document_versions│
              └────────────┘    └──────────────────┘

项目可见或独立实体：
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  mcp_servers │  │   daemons    │  │   webhooks   │  │   api_keys   │
├──────────────┤  └──────────────┘  ├──────────────┤  └──────────────┘
│  mcp_tools   │                    │  deliveries  │
├──────────────┤                    └──────────────┘
│mcp_tool_calls│
└──────────────┘
```

核心约束：
- requirements 必须关联 project
- project-scoped tasks must link to a requirement under the same project; personal tasks use `scope = personal` and owner fields instead of fake projects/requirements
- documents 可以不关联 project（全局文档），也可以关联（项目文档）
- documents 有 `docType` 区分类型：`requirement` / `design` / `meeting` / `guide` / `reference` / `skill` / `other`
- document_versions 实现乐观并发控制的版本历史
- retrieval assets（MCP tools、Skills、Memories）统一使用 global/project/personal/actor/node/client scope 语义

### 3.2 核心表

详细字段定义见 `packages/db/src/schema/` 下各文件。以下列出主要表和关键字段：

| 表 | 文件 | 说明 |
|------|------|------|
| `projects` | `projects.ts` | 项目。status: `active` / `archived` |
| `requirements` | `requirements.ts` | 需求。status: `draft` / `approved` / `in_progress` / `in_review` / `ready_to_merge` / `done` / `cancelled` / `archived` |
| `tasks` | `tasks.ts` | 任务。`scope`: `project` / `personal`; status: `todo` / `in_progress` / `in_review` / `done` / `cancelled` |
| `task_status_log` | `tasks.ts` | 状态变更日志 |
| `task_dependencies` | `tasks.ts` | 任务依赖（`blocks` / `related`） |
| `requirement_dependencies` | `requirements.ts` | Requirement-to-requirement dependencies (`blocks` / `related`) |
| `execution_slices` | `requirements.ts` | Ordered AI execution slices inside a requirement lane |
| `task_comments` | `tasks.ts` | 任务评论 |
| `task_notes` | `tasks.ts` | 任务备注 |
| `documents` | `documents.ts` | 知识库文档，含 `docType` / `version` / `summary` / `keywords` |
| `document_versions` | `documents.ts` | 文档版本历史 |
| `document_links` | `documents.ts` | 文档↔文档双向关联 |
| `document_task_links` | `documents.ts` | 文档↔任务多对多 |
| `document_requirement_links` | `documents.ts` | 文档↔需求多对多 |
| `memories` | `memories.ts` | AI 记忆。类型：`user` / `feedback` / `project` / `reference` / `other` |
| `mcp_servers` | `mcp-servers.ts` | 第三方 MCP Server 注册表 |
| `mcp_tools` | `mcp-servers.ts` | 从 MCP Server 同步的工具列表 |
| `mcp_tool_calls` | `mcp-servers.ts` | MCP 工具调用记录 |
| `skill_packages` | `skill-packages.ts` | Filesystem-shaped skill package identity and scope metadata |
| `skill_package_versions` | `skill-packages.ts` | Immutable package version manifests and storage summaries |
| `skill_package_storage_objects` | `skill-packages.ts` | Server-owned storage object metadata for archives and files |
| `skill_package_files` | `skill-packages.ts` | Per-version file manifest with hashes, readability, executability, and indexed document links |
| `daemons` | `daemons.ts` | CLI daemon registry (heartbeat, capabilities, active workers) |
| `requirement_claims` | `requirements.ts` | Distributed leases for daemon-owned requirement lanes |
| `repositories` | `repositories.ts` | Instance catalog identity, safe endpoints, visibility, and non-secret auth policy |
| `requirement_repositories` | `repositories.ts` | Requirement workspace membership and per-repository delivery lifecycle |
| `task_repositories` | `repositories.ts` | Optional Task scope hints into the Requirement workspace |
| `schedules` | `schedules.ts` | One-off and recurring task generation templates |
| `schedule_runs` | `schedules.ts` | Idempotent schedule occurrences and generated task links |
| `ti_model_configs` | `ti-agent.ts` | User-scoped Ti provider/model configuration and default model selection |
| `ti_agent_policies` | `ti-agent.ts` | Owner-scoped Ti execution policy, limits, and safety controls |
| `ti_agent_runs` | `ti-agent.ts` | Bounded server-side Ti execution queue, leases, and audit results |
| `assistant_conversations` | `assistant.ts` | Contextual Ti assistant dialog sessions linked to project/requirement/task/schedule surfaces |
| `assistant_messages` | `assistant.ts` | Assistant dialog messages with optional context snapshots and Ti run metadata |
| `assistant_actions` | `assistant.ts` | Structured assistant action proposals, approvals, execution results, and audit links |
| `webhooks` | `webhooks.ts` | Webhook 配置（URL、事件、密钥） |
| `webhook_deliveries` | `webhooks.ts` | Webhook 投递记录（含重试） |
| `api_keys` | `api-keys.ts` | API Key 管理 |
| `activity_log` | `activity.ts` | 全局操作日志 |

---

### 3.3 Assistant Dialog Foundations

The contextual assistant is a management copilot backed by bounded Task Weaver context and Ti execution records. Conversation storage is separate from task comments so exploratory chat does not pollute durable task history, while important outcomes can still be linked back through action targets and activity log entries.

- `assistant_conversations` stores the dialog session and its current UI context: global, project, requirement, task, or schedule.
- `assistant_messages` stores user/assistant/system/tool messages, optional context snapshots, and provider/model metadata for Ti-backed answers.
- `assistant_actions` stores machine-readable proposals such as task creation, task updates, schedule changes, Ti run queueing, comments/notes, and document drafts.
- Proposed actions start in `proposed`. Human approval moves them through `approved` and `executing`; execution status, result payloads, validation errors, and target entity references are recorded for replay/debugging. Automatic execution stays disabled until policy controls explicitly allow it.
- The first approved action set covers creating tasks, updating task status/priority/content fields, creating or pausing schedules, queueing Ti runs, adding task comments/notes, and creating reviewable document drafts.
- Management workflows provide focused prompts for project health, stale task follow-up, failed Ti run triage, schedule maintenance, requirement next steps, and personal inbox cleanup. They may return read-only analysis plus structured action proposals that remain approval-gated.
- Assistant automatic maintenance is controlled through owner-scoped Ti policy fields and is disabled by default. Policy controls include dry-run/live mode, action allowlists, per-day action limits, timeout/retry settings, and routing uncertain actions to review.
- `buildAssistantContext` assembles bounded context from project state, current artifacts, schedules, activity, documents, memories, MCP tools, Ti policy, failed Ti runs, and recent conversation messages. It applies item limits, text truncation, and simple secret-key redaction before passing data to a model.

---

### 3.4 Scheduled and Recurring Task Model

Scheduled work is modeled as templates plus occurrence runs:

- `schedules` stores the durable definition for one-off scheduled jobs and recurring templates.
- `schedule_runs` stores each planned occurrence, its idempotency key, generated task link, and execution/audit outcome.
- Generated work remains a normal `tasks` row, so existing task status, claim, daemon, realtime, webhook, and activity-log flows continue to apply.

#### Schedule Template

| Field | Meaning |
|-------|---------|
| `projectId` | Project target for project-scoped schedules. Nullable for future personal schedules. |
| `requirementId` | Requirement used when generating project tasks. Nullable so schedules can survive requirement reshaping. |
| `targetScope` | `project` or `personal`. Project schedules generate project tasks under a requirement; personal schedules generate owner-scoped personal tasks. |
| `kind` | `one_off` or `recurring`. |
| `status` | `active`, `paused`, or `archived`. Only active schedules with `nextRunAt` due are scheduler candidates. |
| `timezone` | IANA timezone used to interpret local calendar rules such as "every weekday at 09:00". |
| `startsAt` / `endsAt` | Inclusive start and optional end boundary for generation. Stored as UTC instants. |
| `nextRunAt` | Next due UTC instant, precomputed after create/update and advanced after each run. |
| `recurrenceSyntax` / `recurrenceRule` | Recurring schedules use RRULE as the canonical syntax. Cron may be accepted as an import/compatibility syntax but should be normalized or clearly labeled. |
| `taskTitle` / `taskDescription` / `taskPriority` | Task template copied into generated task instances. |
| `autoRun` | Whether generated tasks should be offered to execution immediately instead of only being created for human review. |
| `assignedExecutor` / `assignedExecutorType` | Optional explicit executor target for generated work. This supports future server-side assigned agents without letting them claim arbitrary daemon lanes. |
| `requestedTiProvider` / `requestedTiModel` | Optional Ti model request carried to generated runs. Runtime fallback to the user's default Ti model is resolved by the execution layer, not by schedule generation. |

#### Schedule Run

Each run is uniquely identified by `(scheduleId, plannedFor)`, which prevents duplicate task generation when schedulers race or restart. `plannedFor` is the UTC instant for the occurrence, after applying the template timezone and recurrence rule.

Run statuses:

| Status | Meaning |
|--------|---------|
| `pending` | Occurrence was reserved but has not produced a task or terminal result yet. |
| `created` | A normal task was created and linked through `generatedTaskId`. |
| `skipped` | Occurrence was intentionally skipped, for example outside expiry/catch-up policy. |
| `failed` | Scheduler attempted the occurrence but could not create or route work. |
| `cancelled` | Human or system cancelled the occurrence before generation. |

The run stores both requested and actual Ti provider/model fields. Requested values are copied from the schedule at generation time. Actual values are filled by the assigned execution component after fallback and provider availability checks. This keeps audit history stable even if the user's default model later changes.

#### Recurrence Rules

RRULE is the preferred stored format because it represents calendar recurrence with timezone-aware local semantics better than cron. Cron remains useful for operational imports and simple server-side schedules, but cron expressions are ambiguous around timezone and daylight-saving transitions unless paired with `timezone`.

`nextRunAt` is always stored as a UTC timestamp. Scheduler code should compute it by:

1. Interpreting `startsAt`, `endsAt`, and the recurrence rule in `timezone`.
2. Selecting the next occurrence strictly after the last completed or skipped planned occurrence.
3. Converting that occurrence to UTC for `nextRunAt`.
4. Setting `nextRunAt = null` when a one-off schedule has run, the rule is exhausted, or the schedule is archived.

Catch-up and expiry policy is intentionally separate from the core schedule identity. The follow-up scheduler policy task should define whether missed occurrences create all runs, latest-only runs, no runs, or skipped `schedule_runs` records.

---

### 3.4 Server-Side Ti Agent Boundary

Ti is the server-side Task Weaver agent: a bounded assigned-automation worker with a private execution adapter behind it. It is not the same execution path as `tw daemon`, and it must not claim arbitrary requirement lanes or project coding work.

Allowed work:

- Tasks explicitly assigned to the server-agent identity, currently `task-weaver:ti-agent`.
- Schedule runs whose generated task is explicitly assigned to that identity.
- Lightweight automations such as reminders, summaries, metadata maintenance, and safe registered tool calls.

Disallowed work:

- Competing with requirement-lane daemons for unassigned project tasks.
- Running arbitrary repository edits outside an explicit assigned task/run.
- Using machine-global Ti credentials as the product authorization model.
- Executing unattended Ti sessions without Task Weaver-owned timeouts, rate limits, logging, and isolation.

Product naming:

- Stable internal actor id: `task-weaver:ti-agent`.
- Default display label: `Ti Agent`.
- UI category label: `Assigned Automations`.
- The display label is product copy, not an architectural dependency. It can be changed later without changing task assignment, audit, or policy records.

#### Ti Model Configuration

`ti_model_configs` stores the models a user or agent owner may use through Ti:

| Field | Meaning |
|-------|---------|
| `ownerId` / `ownerType` | User or agent that owns this Ti model configuration. |
| `provider` / `model` | Ti provider and model identifiers. |
| `label` | Optional human-readable label. |
| `apiKeyRef` | Reference to stored credentials, not raw secret material. |
| `credentialStatus` | `unknown`, `valid`, `invalid`, or `missing`. Invalid and missing configs are not usable. |
| `enabled` | Disabled configs cannot be selected or used as fallback. |
| `isDefault` | One default model per owner, enforced by a partial unique index. |
| `capabilities` / `costMetadata` | Optional metadata copied from the Ti model catalog or internal policy. |

Runtime model resolution uses the requested provider/model when it is configured, enabled, and has usable credentials. Otherwise it falls back to the owner's default usable model, then to the first usable model. If no model is requested and no usable model exists, execution is rejected before a run is queued.

#### Ti Agent Runs

`ti_agent_runs` is the execution queue and audit record. A run must reference at least one explicit target: `taskId` or `scheduleRunId`.

Run statuses:

| Status | Meaning |
|--------|---------|
| `queued` | Run is ready for the server-side agent but not leased. |
| `running` | A worker has acquired a lease and may execute Ti. |
| `succeeded` | Execution completed successfully. |
| `failed` | Execution failed after the current attempt. |
| `in_review` | Execution produced uncertain or policy-sensitive output for human review. |
| `cancelled` | Run was cancelled before completion. |

Each run records requested and actual Ti provider/model, fallback reason, optional Ti session id, event log, output summary, error message, retry counters, cost metadata, lease owner, lease expiry, and timestamps. The first implementation only queues and audits runs; the actual execution loop must be added behind an isolation boundary.

#### Ti Execution Policy

`ti_agent_policies` is owner-scoped and disabled by default. It controls whether queued runs can be acquired and how far execution may go:

| Field | Meaning |
|-------|---------|
| `enabled` | Worker acquisition is rejected unless this is true. |
| `executionMode` | `disabled`, `dry_run`, or `live`. Dry-run workers lease and audit runs without invoking Ti. |
| `maxConcurrentRuns` | Maximum active leases for the owner/agent. |
| `dailyRunLimit` / `monthlyRunLimit` | Hard run acquisition limits. Zero means no runs for that period. |
| `runTimeoutSeconds` | Maximum execution budget for a worker process. |
| `defaultMaxRetries` | Default retry budget copied into new runs when not specified. |
| `toolAllowlist` / `toolDenylist` | Policy metadata for the execution wrapper; live execution must enforce these before exposing tools. |

The CLI worker path (`tw ti worker run-once`) acquires one queued run, builds a bounded prompt from the explicitly assigned task/run, and either dry-runs or invokes the configured private executor with the resolved provider/model. The worker records structured event lines, output/error summaries, actual model, and terminal status through Ti run records.

---

## 4. Retrieval Scope Model

Task Weaver has several retrieval-style assets that agents discover at runtime: MCP tools, Skills, and Memories. They use one shared scope vocabulary so search behavior is predictable across CLI, REST, tRPC, and UI.

### 4.1 Scope Vocabulary

| Scope | Meaning | Current storage |
|-------|---------|-----------------|
| `global` | Visible across projects, subject to asset-specific access rules | `projectId = null` for documents/memories/MCP servers |
| `project` | Belongs to one project and should be preferred when that project is active | `projectId = <project-id>` |
| `personal` | User-owned private workspace context for inbox tasks, skills, memories, and MCP resources | `personalOwnerId` + `personalOwnerType`, with `projectId = null` |
| `actor` | Belongs to or is most relevant to one human or agent | memory actor/entity fields |
| `node` | Visible only to agents on the same machine/node | MCP stdio `scope = local` + `nodeId` |
| `client` | Visible only to one client process/session | MCP stdio `scope = private` + `clientId` |

Scopes compose from broad to narrow. For example, a project-scoped local stdio MCP server is visible only when both the project filter and node visibility match.

### 4.2 Default Search Semantics

When a request includes `projectId`, retrieval searches return project-specific assets plus global assets by default. Project-specific results rank ahead of global results when scores are otherwise similar. Strict project-only searches use `includeGlobal=false` where the endpoint supports it. Personal assets are included only when `includePersonal=true` and the requested `personalOwnerId`/`personalOwnerType` match.

When a request omits `projectId`, retrieval searches return global assets by default. Personal assets require explicit `includePersonal=true` plus owner filters. Project-bound assets must not leak into projectless discovery, and personal assets must not leak across owners.

REST search endpoints return a consistent `{ items: [...] }` envelope for machine-readable consumers. Combined search additionally keeps grouped `tasks`, `requirements`, and `documents` arrays for compatibility while exposing typed rows in `items`.

### 4.3 Asset Mapping

- **Skills** are documents with `docType = skill`. `projectId = null` and no personal owner means global skill; `projectId` set means project skill; personal owner set means personal skill. Import/upsert identity includes the effective scope, so same-title global/project/personal skills are independent.
- **Skill packages** are filesystem-shaped distribution records. `skill_packages` owns package identity, effective global/project/personal scope, package status, entry path, package manifest, and optional `primaryDocumentId`. `skill_package_versions` records immutable upload/import versions. `skill_package_files` records normalized relative paths, hashes, size, kind, readability, executable bit, storage object linkage, and optional `indexedDocumentId`. Documents remain the searchable knowledge units; packages remain the source of truth for distribution and local materialization.
- Package distribution uses manifest-backed downloads: clients receive file metadata, hashes, executable flags, and file bytes, then materialize locally after hash verification. Maintenance APIs verify storage object health and can rebuild readable-file search indexes from stored package assets. The server stores and serves package assets but does not execute package-owned scripts or binaries.
- **Memories** use nullable `projectId` plus optional personal owner fields. Actor and entity filters narrow relevance inside the selected global/project/personal set; actor scope is identity memory, while personal scope is a user-owned workspace.
- **MCP servers/tools** use nullable `projectId` plus optional personal owner fields and transport visibility. Non-stdio servers are global, project, or personal depending on scope fields. Stdio servers must additionally satisfy `clientId` for `private` scope or `nodeId` for `local` scope and must not be returned after expiry.

### 4.4 Isolation Rules

- Project-scoped retrieval assets are visible only when the same `projectId` is requested.
- Global assets may be included in project searches when `includeGlobal=true`.
- Personal assets are visible only with explicit personal inclusion and matching owner fields.
- Local stdio MCP sharing requires explicit consent and a stable `nodeId`.
- Private stdio MCP servers are visible only to the registering `clientId`.
- Expired stdio MCP servers are excluded from discovery regardless of project scope.

---

## 5. 任务状态机

### 5.1 状态定义

| 状态 | 含义 |
|------|------|
| `todo` | 待办，尚未开始 |
| `in_progress` | 进行中 |
| `in_review` | 审查中 |
| `ready_to_merge` | 审查通过，等待合并 |
| `done` | 已完成 |
| `cancelled` | 已取消（终态） |

### 5.2 流转规则

**核心原则：允许自由跳转，不强制线性流程。唯一限制：`cancelled` 不可再流转。**

每次状态变更：
1. 更新 `tasks.status`
2. `done` 时自动记录 `completedAt`，离开 `done` 时清空
3. 写入 `task_status_log`
4. 写入 `activity_log`
5. 通过 PG NOTIFY 发送实时事件
6. 触发 Webhook 投递

---

## 6. 知识库与搜索

### 6.1 文档分类

- **全局文档**（`projectId = null`）：不属于任何项目，全局可见
- **项目文档**（`projectId` 指定）：归属特定项目
- **文档类型**（`docType`）：`skill` 类型的文档即为 Skills

### 6.2 双向关联

- **文档↔文档**：通过 `document_links`，支持 `[[wiki-link]]` 语法自动解析
- **文档↔任务**：通过 `document_task_links`（`references` / `documents` / `output`）
- **文档↔需求**：通过 `document_requirement_links`

### 6.3 版本管理

文档通过 `version` 字段实现乐观并发控制，每次变更记录到 `document_versions` 表，支持回滚。

### 6.4 搜索系统

| 模式 | 实现 | 说明 |
|------|------|------|
| `keyword` | PostgreSQL `tsvector` / `tsquery` | 精准全文搜索，触发器自动维护 |
| `semantic` | pgvector + Embedding | 向量语义搜索 |
| `hybrid` | 两者加权融合 | 默认模式，关键词 0.4 + 语义 0.6 |

---

## 7. 接入方式

```
┌──────────────────────────────────────────────────────────────────────┐
│                         接入方式                                      │
├──────────────┬──────────────────┬───────────────┬────────────────────┤
│   Web UI     │   AI Agent       │  CLI Daemon   │   通用工具/脚本     │
│   (人类)     │   (REST API)     │  (REST API)   │   (curl 等)        │
├──────────────┼──────────────────┼───────────────┼────────────────────┤
│   tRPC       │   REST API       │   REST API    │   REST API         │
│   (类型安全)  │  + Skills 指引    │  + 任务认领    │   (JSON, 通用兼容)  │
└──────────────┴──────────────────┴───────────────┴────────────────────┘
```

- **Web UI** → Next.js 前端通过 tRPC 调用 API
- **AI Agent** → 通过 REST API（Bearer Token 认证）+ Skills 文件指引使用方式
- **CLI Daemon** → 通过 REST API 注册、心跳、认领任务
- **第三方 MCP Server** → Task Weaver 作为 MCP 客户端，通过 MCP Pool 连接和调用外部 MCP Server 的工具

---

## 7. 第三方 MCP Server 管理

Task Weaver 可以注册和管理外部 MCP Server，作为工具的聚合代理：

- **注册**：记录 MCP Server 的连接信息（stdio / sse / streamable-http）
- **连接池**（`mcp-pool`）：维护到各 MCP Server 的长连接，支持空闲回收
- **工具同步**：从已连接的 MCP Server 拉取工具列表，缓存到 `mcp_tools` 表
- **代理调用**：通过 Task Weaver API 代理调用第三方 MCP Server 的工具，记录调用历史
- **TTL & 状态管理**：支持 `clientId` + `expiresAt` + `ttl` 实现临时注册和自动过期

---

## 8. Daemon System

The CLI daemon is the runtime carrier for autonomous AI agents. It registers with the API, advertises local AI tool capabilities, acquires work, spawns an AI CLI, and reports liveness and progress back to Task Weaver.

- **Registration**: `tw daemon start` registers a daemon row and declares capabilities such as `["codex", "claude", "agy"]`.
- **Heartbeat**: the daemon sends process heartbeats and per-worker requirement-claim heartbeats.
- **Requirement lanes**: daemon workers acquire a requirement-level distributed lease instead of racing for isolated tasks.
- **Execution slices**: a claimed requirement can be split into ordered slices; each slice is a bounded AI CLI spawn with its own model tier and handoff summary.
- **Model controls**: workers can map model tiers to concrete Codex models and Codex `model_reasoning_effort`; unsupported tools ignore the think mapping.
- **Local prompt controls**: daemon workers can receive local-only prompt fragments from `--prompt` and `--prompt-file` without storing machine-specific guidance in the API.
- **Composite workspace isolation**: each slice receives a frozen, secret-free manifest and one isolated branch worktree per Requirement repository. Node-local base checkouts are shared, while concurrent Requirement branches remain separate.
- **Independent finalization**: spawned agents leave file changes in repository worktrees; the daemon owns commit, push, provider-specific PR detection/creation, per-link delivery state, partial retry, review comments, and final Requirement routing.
- **Review and merge**: `tw daemon review` combines local checks with normalized GitHub/Gitea checks and approvals, then commit-fences the structured decision. `tw daemon merge` resolves the effective provider/direct/manual policy and marks a Requirement `done` only after every repository is terminal.
- **Worker visibility**: daemon status includes `activeWorkerStates`, which powers the Web Daemons page worker cards and task roadmap.
- **State**: daemon rows use `idle` / `busy` / `offline`; requirement and task status remain the durable project state.

### Requirement-Lane Scheduling

Daemon scheduling uses the requirement as the unit of ownership:

1. A worker calls `POST /api/v1/daemons/:id/apply-requirement`.
2. The server selects a requirement with at least one executable `todo` task.
3. The server atomically inserts/renews a `requirement_claims` lease using the daemon actor id.
4. If execution slices exist, the server selects the next executable slice and moves its first selected task to `in_progress`; otherwise it returns the whole requirement lane roadmap.
5. The daemon freezes the Requirement repository set, provisions one isolated worktree per repository, writes the composite manifest, and spawns the AI CLI at the workspace root for that slice.
6. The spawned agent processes the slice task roadmap sequentially and leaves a handoff summary.
7. On exit, the daemon marks the slice `done` or `in_review`, releases the requirement claim, and performs fallback status routing if needed.
8. When every task under the Requirement is `done` or `cancelled`, the daemon independently finalizes each repository: it commits changes when present, pushes the repository branch, invokes provider-supported PR behavior, records each outcome, preserves successful siblings when one fails, writes an aggregate comment, and moves the Requirement to `in_review`.

This keeps branch granularity at the requirement level while bounding each AI session to a planned slice. Different requirements in the same project can still run concurrently across daemon workers.

Daemon finalization is review-oriented. A successful push with a PR URL gives humans a ready review target. Generic Git remains usable without forge capabilities. If there are no changes or forge access is unavailable, the daemon records the exact per-repository outcome. Commit, push, review, and merge failures stay attached to the affected Requirement repository link and remain independently retryable.

Review and merge scheduling use the same server-owned lane model. A review worker calls `POST /api/v1/daemons/:id/apply-review`; the server selects an unclaimed `in_review` Requirement, creates a Requirement claim for the daemon actor, and returns its repository links. The local review daemon processes each repository branch independently. Passing review moves the Requirement to `ready_to_merge`; conflicts, failed checks, or review findings create repository-tagged follow-up tasks and move it back to `in_progress`.

A merge worker calls `POST /api/v1/daemons/:id/apply-merge`; the server selects an unclaimed `ready_to_merge` Requirement and its repository links. Provider mode uses the forge's merge API with an expected-head fence, direct mode pushes a locally merged base branch, and manual mode is excluded from daemon acquisition and surfaced with an action URL. Normalized provider snapshots are synchronized through a revision-checked idempotent endpoint. A merged snapshot is terminal, a closed or reopened pull request is routed back to review as appropriate, and a changed head supersedes earlier review runs before it can be approved.

### Requirement Dependencies

`requirement_dependencies` models requirement-to-requirement links inside one project:

- `requirement_id` is the downstream requirement.
- `depends_on_requirement_id` is the upstream requirement.
- `type` is `blocks` or `related`; only `blocks` affects scheduling.
- Self-dependencies, cross-project dependencies, duplicate links, and cycles are rejected.
- A blocking upstream requirement unblocks downstream work when it is `done` or `cancelled`.
- Deleting a requirement cascades dependency rows through foreign keys.

Daemon requirement-lane scheduling skips downstream requirements that have unfinished `blocks` dependencies. Direct requirement claims perform the same blocker check inside the claim transaction so a worker cannot bypass scheduling and acquire an invalid lane.

### Requirement Claims

`requirement_claims` mirrors `task_claims` semantics:

- One active claim per requirement (`requirement_id` unique index).
- Claims have `expiresAt` and `heartbeatAt`.
- Same holder can renew; different holders get a conflict.
- Only the holder can heartbeat or release.
- Expired claims are cleaned before acquisition/listing.
- `done`, `cancelled`, and `archived` requirements release active requirement claims.

`task_claims` still exist for interactive/manual task-level coordination. Daemon scheduling uses requirement claims so that a worker owns the whole requirement lane and avoids duplicated context loading.

### Daemon Web Visibility

The Web Daemons page shows:

- daemon name, id, status, capabilities, and heartbeat age
- active worker lanes
- current requirement id/title/status/branch
- current active task
- requirement task roadmap with per-task status
- worktree path and lease freshness indicators

---

## 9. Memory 系统

AI Agent 的结构化记忆存储：

- **类型**：`user` / `feedback` / `project` / `reference` / `other`
- **作用域**：可关联到项目，也可以是全局记忆
- **实体关联**：可选关联到具体的 project / requirement / task / document
- **过期机制**：支持 `expiresAt` 自动过期
- **搜索**：支持按类型、标签、关键词检索

---

## 10. 实时系统

```
写入操作（REST API / tRPC）
         │
         ▼
   @task-weaver/core 执行业务逻辑
         │
         ├──► 写入 PostgreSQL
         │
         ├──► pg_notify('realtime_events', ...)
         │
         └──► webhookService.deliverEvent(...)
                    │
                    ▼
              Webhook 投递（HTTP POST + 重试）

pg_notify 路径：
   Hono API / Next.js 监听 PG NOTIFY
         │
         ▼
   tRPC SSE → 浏览器实时更新 UI
```

---

## 11. 认证与权限

| 类型 | 认证方式 | 说明 |
|------|----------|------|
| 人类用户 | Session / JWT（Web UI 登录） | 通过 Web 前端管理 |
| AI Agent | API Key（`Authorization: Bearer tw_xxx`） | 每个 Agent 独立 Key |
| CLI Daemon | API Key + daemon 注册 | 注册后通过 REST API 操作 |

---

## 12. 开发环境

### 依赖

- Node.js >= 20
- pnpm >= 9
- PostgreSQL >= 16（需安装 pgvector 扩展）

### 启动

```bash
pnpm install          # 安装依赖
pnpm dev              # 并行启动所有服务
pnpm build            # 构建
pnpm lint             # 检查
pnpm typecheck        # 类型检查
```

### 端口约定

| 服务 | 端口 | 说明 |
|------|------|------|
| Next.js Web | 3000 | 前端应用 |
| Hono API | 3001 | API 服务（tRPC + REST + GraphQL） |
