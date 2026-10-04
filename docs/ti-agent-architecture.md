# Ti Agent Architecture & Partners E2B Integration

This document defines the architectural redesign for the Task Weaver server-side **Ti Agent**, its integration with **Partners** (E2B-compatible sandbox compute layer), multi-session Chat management, token usage accounting, and storage optimization.

---

## 1. Executive Summary & Design Principles

### 1.1 Separation of Brain and Compute
- **Brain (Decision & Orchestration)**: The models configured by users/agents in the Web UI (`OpenAI`, `Anthropic`, `Gemini`, `DeepSeek`, etc.) serve exclusively as the "Brain". The Brain is responsible for ReAct loops, planning, reflection, tool invocation, and generating executable code/commands.
- **Compute (Sandbox & Execution Environment)**: **Partners** serves exclusively as the "Hands and Environment" (isolated compute layer). It provides an E2B-compatible runtime environment: process execution, file system operations, code interpretation, and sandboxed networks. Partners does not dictate LLM decisions; it executes what the Brain decides.

### 1.2 Non-Smooth Retirement of Legacy "Pi"
- Legacy references to "Pi" (`pi_agent_model_configs`, `pi_agent_runs`, `pi_agent_policies`, `actual_pi_provider`, etc.) are dropped directly without backwards compatibility or migration layers. The database schema, API routes, contracts, and CLI commands are cleanly renamed and rebuilt around `ti_agent`.

### 1.3 Storage & Resource Pressure Minimization
- **On-Demand Artifact Collection**: By default, runs stream events and standard output interactively without persisting voluminous artifacts into Task Weaver database storage. Artifacts (diffs, reports, summaries) are only collected when explicitly requested by the task specification.
- **Persistent Workspace Lifecycle**: If a persistent sandbox workspace is allocated during execution, it must be explicitly closed and deleted upon run completion or failure, avoiding stranded storage leaks in Partners.

### 1.4 Comprehensive Chat History & Session Lifecycle
- Chat conversations (`assistant_conversations`) support full lifecycle operations:
  - User can view previous conversation histories.
  - User can start fresh conversations with custom titles or scope presets.
  - User can delete individual conversations and cascade-delete messages and proposed actions.
  - Conversation list and message histories are persisted and queryable per user/scope.

### 1.5 Unified Token Accounting
- Ti Agent executions are integrated into Task Weaver's `agent_usage_runs` ledger.
- For both Chat interactions and autonomous Ti Agent runs, exact input, output, cache-read, and cache-write tokens are captured and reported.

---

## 2. Architecture Overview

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Task Weaver Application                         │
│   Web UI (Chat / Tasks / Schedules)  │  tw CLI (Direct Run & Debug)    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    Ti Agent Orchestrator (Brain)                       │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Model Router: Loads user-configured LLM (OpenAI / Claude / etc.) │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ ReAct Engine: Prompt -> Thought -> Tool/Code Generation -> Exec  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Token Meter: Tracks input/output/cache tokens -> agent_usage_runs│  │
│  └──────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ E2B-Compatible Protocol
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                Partners Gateway (Compute / Sandbox Layer)              │
│  ┌──────────────────────┐  ┌───────────────────┐  ┌─────────────────┐  │
│  │ Commands (Bash/PTY)  │  │ Filesystem (FS)   │  │ Code Interpreter│  │
│  └──────────────────────┘  └───────────────────┘  └─────────────────┘  │
│  Lifecycle: Spawn -> Warm Pool -> Execute -> On-demand Artifacts -> Purge│
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Schema & Naming Overhaul

### 3.1 Dropping Legacy Pi Tables
The following tables are dropped and removed:
- `pi_agent_model_configs`
- `pi_agent_runs`
- `pi_agent_policies`
- Columns: `requested_pi_provider`, `requested_pi_model`, `actual_pi_provider`, `actual_pi_model`, `pi_session_id`, `pi_agent_run_id`

### 3.2 Canonical Ti Agent Schema

#### `ti_agent_model_configs`
Configures models available for Chat and Ti Agent automation:
- `id` (UUID PK)
- `owner_id` (Text) & `owner_type` (Enum: `human` | `agent`)
- `provider` (Text: e.g. `openai`, `anthropic`, `gemini`, `deepseek`)
- `model` (Text: e.g. `gpt-4o`, `claude-3-7-sonnet`, `gemini-2.5-pro`)
- `base_url` (Text, optional)
- `api_key_ref` (Text: env reference or vault pointer)
- `enabled` (Boolean, default true)
- `is_default_chat` (Boolean, default false) - Default model for Assistant Chat
- `is_default_agent` (Boolean, default false) - Default model for Ti Agent tasks
- `capabilities` (Text array: e.g. `["code", "tools", "vision"]`)
- `created_at` / `updated_at` (Timestamp with timezone)

#### `ti_agent_runs`
Tracks autonomous server-side task executions:
- `id` (UUID PK)
- `task_id` (UUID FK -> `tasks.id`, nullable)
- `schedule_run_id` (UUID FK -> `schedule_runs.id`, nullable)
- `assigned_agent_id` (Text: default `task-weaver:ti-agent`)
- `status` (Enum: `queued` | `running` | `succeeded` | `failed` | `in_review` | `cancelled`)
- `requested_provider` / `requested_model` (Text, nullable)
- `actual_provider` / `actual_model` (Text, nullable)
- `sandbox_session_id` (Text, nullable: Partners/E2B sandbox instance ID)
- `workspace_policy` (Enum: `ephemeral` | `persistent_purged_on_finish`)
- `event_log` (JSONB: execution logs and structured steps)
- `output_summary` (Text, nullable: concise outcome summary)
- `error_message` (Text, nullable)
- `token_usage_id` (UUID FK -> `agent_usage_runs.id`, nullable)
- `lease_owner_id` / `lease_expires_at` (Worker leasing)
- `created_at` / `started_at` / `completed_at` (Timestamps with timezone)

#### `ti_agent_policies`
Owner-scoped quotas and security boundaries:
- `owner_id` / `owner_type`
- `enabled` (Boolean)
- `execution_mode` (Enum: `disabled` | `dry_run` | `live`)
- `max_concurrent_runs` (Integer)
- `daily_run_limit` / `monthly_run_limit` (Integer)
- `run_timeout_seconds` (Integer)
- `sandbox_template` (Text: Partners template / Dockerfile identifier)
- `allow_network` (Boolean, default false)
- `allowed_tools` / `denied_tools` (Text array)

---

## 4. Chat Multi-Session Management

### 4.1 Conversation Schema Enhancements
Existing `assistant_conversations` table is enhanced with full management capabilities:
- User-driven titles with auto-generation from first prompt.
- Status flag: `active` | `archived`.
- Cascade deletion: Deleting a conversation removes all `assistant_messages` and unexecuted `assistant_actions`.

### 4.2 tRPC Router Operations (`trpc.assistant.*`)
1. `listConversations`: Query conversations by actor, project, or context kind, sorted by `lastMessageAt DESC`.
2. `getConversation`: Fetch a specific conversation with ordered messages and proposed action cards.
3. `createConversation`: Create an explicit new conversation with specified scope (`global`, `project`, `requirement`, `task`, `personal`).
4. `deleteConversation`: Permanently delete a conversation and its messages.
5. `renameConversation`: Update conversation title.

### 4.3 Web UI Interaction Flow
- **Drawer / Sidebar Session Switcher**: The Chat Dialog includes a session selector showing active and past conversations.
- **"New Chat" Button**: Clears the active thread and spawns a fresh session.
- **Session Management**: Each session item provides rename and delete buttons.

---

## 5. Partners E2B Sandbox Compute & Storage Policy

### 5.1 Driver Contract & Partners v0.1.2 Endpoints (`@task-weaver/core`)

The sandbox execution layer maps cleanly to verified Partners Gateway v0.1.2 HTTP & WebSocket endpoints:

```typescript
export interface SandboxDriver {
  createSession(options: {
    template?: string;
    timeoutSeconds?: number;
    env?: Record<string, string>;
    snapshotId?: string;
  }): Promise<SandboxSession>;
}

export interface SandboxSession {
  readonly id: string;
  commands: {
    // POST /v1/jobs with executionMode: "workspace_session" & sessionId
    run(command: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult>;
    // GET /v1/jobs/:id/events (SSE)
    runStream(command: string, onStdout: (chunk: string) => void, onStderr: (chunk: string) => void): Promise<ExecResult>;
    // POST /v1/sessions/:id/pty -> Upgrade ws://host/v1/sessions/:id/pty (WebSocket PTY bidirectional stream)
    attachPty(options?: { command?: string; cols?: number; rows?: number }): Promise<PtyStream>;
  };
  workspace: {
    // POST /v1/sessions/:id/workspace/sync (JSON or tarball stream)
    syncFiles(files: Array<{ path: string; content: string }>): Promise<{ written: string[]; totalBytes: number }>;
    // GET /v1/sessions/:id/workspace/file?path=...
    readFile(path: string): Promise<string>;
    // GET /v1/sessions/:id/workspace/tree?path=...
    listTree(subpath?: string, depth?: number): Promise<WorkspaceTree>;
    // GET /v1/sessions/:id/workspace/download?path=...&archive=true (tar.gz streaming)
    downloadArchive(paths?: string[]): Promise<NodeJS.ReadableStream>;
  };
  snapshots: {
    // POST /v1/sessions/:id/snapshots
    createSnapshot(metadata?: Record<string, unknown>): Promise<{ id: string; snapshotId: string }>;
  };
  preview: {
    // Resolves /preview/:sessionId/:port/* reverse-proxy endpoint
    getPreviewUrl(port: number, subpath?: string): string;
  };
  // DELETE /v1/sessions/:id (Guaranteed cleanup and persistent workspace teardown)
  close(): Promise<void>;
}
```


### 5.2 Storage & Artifact Optimization
1. **Interactive Streaming**: Stdout/stderr lines from sandboxed commands are streamed directly to listeners (CLI/UI SSE) rather than accumulated unconditionally into bulky database records.
2. **On-Demand Artifact Ingestion**: Task Weaver specifies `collectArtifacts` only when:
   - The task requires a deliverable file (e.g. `dist/`, `report.md`, patch/diff).
   - A review action specifically flags a file to be attached to the task.
3. **Workspace Cleanup Guarantee**:
   - Every session runs in a `try...finally` block that guarantees `session.close()` is invoked.
   - For temporary or persistent worktrees, an explicit purge call is dispatched to Partners to wipe filesystem allocations.

---

## 6. Token Usage Metering Integration

1. When Ti Agent runs execute ReAct turns or Chat processes messages:
   - Raw model responses return usage statistics: `prompt_tokens`, `completion_tokens`, and cache tokens.
   - Counters are accumulated per execution session.
2. At the end of each run or chat turn:
   - A record is published to `agent_usage_runs`:
     - `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`.
     - `actorId`, `projectId`, `requirementId`, `taskId`.
     - `coverage`: `complete`.
3. Token usage is immediately visible on the `/projects/usage` dashboard.

---

## 7. Business Integration (Personal / Schedule / Task)

### 7.1 Personal Inbox
- **Smart Triage (`ti triage`)**: Analyzes unstructured notes in Personal Inbox, categorizes priority, and suggests project/requirement affiliation.
- **Personal Task Delegation**: Users can assign personal research or note drafting to Ti Agent.

### 7.2 Schedules
- **Structured Maintenance Templates**: Schedules carry execution templates (e.g., dependency check, documentation consistency, daily health audit).
- **Execution & Feedback**: Ti Agent boots the E2B sandbox, runs diagnostic scripts, posts findings as comments, and marks tasks `in_review` if anomalies are found.

### 7.3 Tasks
- **Full Delegation Pipeline**:
  1. Task assigned to `task-weaver:ti-agent`.
  2. Runner leases `ti_agent_run` and starts Partners E2B sandbox.
  3. Brain loops through requirements, inspects code, applies changes, and runs tests.
  4. Collects minimal summary & diff, closes and wipes sandbox.
  5. Transitions Task to `in_review` with structured verification notes for human approval.

---

## 8. Partners Team Receipt & Cross-System Roadmap Alignment

### 8.1 Official Receipt Metadata
- **Recipient**: Task Weaver R&D Team
- **Sender**: Partners Architecture & R&D Team
- **Version Release Target**: Partners `v0.1.2` (Git branch: `v0.1.2`)
- **Task Weaver Requirement ID**: `a41926bd-6bc9-4f0c-85cf-048696c439f6`
- **Partners Project ID**: `b6da0fce-6f62-4746-b4db-2c1fbb78800e`

### 8.2 Feature Feasibility & Delivery Commitment

| # | Proposal Feature | Partners Foundation (v0.1.1) | Partners v0.1.2 Gateway Delivery Plan | Task Weaver Impact & Linkage |
|---|------------------|------------------------------|---------------------------------------|------------------------------|
| 1 | **Interactive PTY Terminal & Streaming** | Pod/MicroVM native execution channel ready; single-batch command execution exposed. | **[P0 · Immediate]** Add WebSocket upgrade endpoint on HTTP Gateway for bidirectional stdin/stdout & terminal resize. | Unlocks `tw ti sandbox shell` interactive attach & debugging. |
| 2 | **Two-Way Workspace Sync & Safe Git Ingestion** | Git credential memory injection & workspace tree download supported. | **[P0 · Immediate]** Add `POST /v1/sessions/:id/workspace/sync` streaming tarball unpack endpoint. | Unlocks sub-second document/wiki attachment synchronization to sandbox `/workspace`. |
| 3 | **Persistent Templates & Snapshot Reuse** | CubeSandbox MicroVM CubeCoW millisecond memory snapshot & fork protocol verified. | **[P1 · Planned]** Expose `POST /v1/sessions/:id/snapshots` and `POST /v1/templates` in gateway. | Enables project-scoped dependency caching and warm resume. |
| 4 | **Temporary Web Preview & Network Policy** | K8s NetworkPolicy outbound allowlist & internal interception functional. | **[P1 · Planned]** Gateway `/preview/:sessionId/:port/*` reverse-proxy routing. | Enables previewing web apps (Vite/Next.js) directly from sandbox. |
| 5 | **Warm Sandbox Pool & Sub-Second Boot** | MicroVM cold start < 60ms; scheduler pool management pending. | **[P1 · Planned]** Gateway `WarmPoolManager` for Node/Python/Polyglot pools (< 500ms startup). | Eliminates queueing latency on Ti Agent task acquisition. |

### 8.3 Upstream Partners Task Tracking Matrix

| Partners Task UUID | Feature Description | Priority | Task Weaver Integration Point |
|--------------------|---------------------|----------|-------------------------------|
| `08389eb4-815b-4592-9623-0b1660f94836` | Interactive PTY terminal gateway with WebSocket channels | Urgent (P0) | `task-cli-sandbox-debug` (`tw ti sandbox shell`) |
| `6f8ab156-a559-4b85-81ce-b4d0dda1aa65` | Two-way workspace file sync and batch streaming upload | High (P0) | `task-partners-e2b-driver` (Workspace sync) |
| `2284de45-e827-4464-913e-7448c59e339d` | Gateway snapshot management and template reuse API | High (P1) | `task-storage-workspace-cleanup` (Snapshot caching) |
| `1a9090b3-2197-4da6-9aba-bb1d1b6a3c4a` | Web preview reverse proxy with egress isolation policies | Medium (P1) | `task-delegation-review-loop` (Web demo preview) |
| `01a980ee-4bcf-4781-b90f-75a2d22cd1c3` | Warm Sandbox Pool Manager for ultra-fast startup | Medium (P1) | `task-partners-e2b-driver` (Pool acquisition) |

### 8.4 Iterative Delivery Strategy
Task Weaver R&D will prioritize integration with **Partners P0 capabilities** (PTY WebSocket channels and Two-Way Workspace File Sync) in Phase 1 & 2. As Partners v0.1.2 delivers P1 capabilities (Snapshots, Web Preview, and Warm Pools), Task Weaver will roll out incremental optimizations to template caching and demo previews without requiring architectural redesign.

