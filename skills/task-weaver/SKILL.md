---
name: task-weaver-overview
description: Core platform knowledge — data model, authentication, conventions, and quick start guide for Task Weaver.
keywords: ["project management", "data model", "authentication", "conventions", "quick start", "task tracking"]
tags: ["core", "getting-started"]
---

# Task Weaver

Human-AI collaborative project management platform. Humans interact via Web UI, AI agents via the `tw` CLI or REST API. Both are equal participants sharing the same data and business logic.

## Architecture

```
┌─────────────────────────────────────────┐
│         @task-weaver/core               │
│  (Business Logic, Zod Schemas, Types)   │
└─────┬──────────┬──────────────────────-─┘
      │          │
   ┌──▼──┐  ┌───▼───┐
   │tRPC │  │REST   │
   │(Web)│  │API    │
   └─────┘  └───┬───┘
      │         │
      ▼         ▼
┌─────────────────────────────────────────┐
│    PostgreSQL + pgvector                │
│  (Data, Full-text Search, Vectors)      │
└─────────────────────────────────────────┘

AI Agent access:
  tw CLI  ──────► REST API
  (Bash tool)
```

## Choosing an Interface

| Interface | Use When |
|-----------|----------|
| **tw CLI** | You are an AI agent (use via Bash tool); or a human at the terminal |
| **REST API** | You want to make raw HTTP requests; or build integrations |

The CLI wraps the REST API. Both share the same data and authentication.

## Operating Modes

You may be running in one of two modes. **Identify which one you are in before touching tasks**, because the claiming protocol differs.

| Mode | How you got here | Claiming protocol |
|------|------------------|-------------------|
| **Interactive / collaborative** | A human (or another agent) is directing you; you pick what to work on | **You** claim → work → release (see [Task Locking](#task-locking-claiming)) |
| **Daemon / executor** | You were spawned by `tw daemon` to resolve one requirement lane | The daemon **already claimed** the requirement and selected the first task. Do **not** claim or release the requirement yourself |

**How to tell you're in daemon/executor mode:** your launching prompt explicitly names a Requirement ID, branch/worktree, an initial Task ID, and a requirement task roadmap. In that case:

- Do **not** claim or release the requirement lane; the daemon owns `requirement_claims` heartbeat/release.
- Start with the initial task, then continue through remaining unblocked tasks under the same requirement.
- Set each completed task to `done`; use `in_review` for tasks that need human judgment.
- Do **not** commit, push, create a PR, or set the requirement final status. Leave file changes in the daemon-provided worktree.
- When every task under the requirement is `done` or `cancelled`, the daemon commits/pushes the requirement branch, discovers or creates a PR when possible, records the outcome in Task Weaver comments, and moves the requirement to `in_review`.
- The daemon renews the requirement claim while you run and releases it when you exit. If you exit abnormally, the daemon reverts the active task to `todo` for retry; if you exit cleanly without finalizing the active task, it routes that task to `in_review`.

## Data Model

### Entities and Relationships

```
Project (top-level)
├── Requirement (belongs to project)
│   └── Project Task (belongs to project AND requirement; requirementId required)
│       ├── Comment
│       ├── Note
│       └── Dependency → another Task
Personal Space
└── Personal Task (scope=personal; owner-scoped; no fake project/requirement)
└── Document (project-scoped or global)
    └── Links → Document | Task | Requirement
```

### Project

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID | auto | Primary key |
| `name` | string | yes | 1–255 chars |
| `description` | string | no | |
| `status` | enum | auto | `active` \| `archived` (default: `active`) |

### Requirement

Belongs to exactly one project.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID | auto | Primary key |
| `projectId` | UUID | yes | Parent project |
| `title` | string | yes | 1–500 chars |
| `description` | string | no | |
| `status` | enum | default | `draft` \| `approved` \| `in_progress` \| `in_review` \| `ready_to_merge` \| `done` \| `cancelled` \| `archived` |
| `priority` | enum | default | `low` \| `medium` \| `high` \| `critical` |
| `modelTier` | enum | default | `fast` \| `standard` \| `strong` |
| `tags` | string[] | no | |

### Execution Slice

Requirements can be planned into ordered execution slices. A daemon still claims one requirement lane, but spawns a fresh AI CLI process per slice when slices exist. This bounds execution context while keeping branch ownership at requirement granularity.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID | auto | Primary key |
| `requirementId` | UUID | yes | Parent requirement |
| `title` | string | yes | Slice title |
| `description` | string | no | |
| `orderIndex` | number | default | Lower runs earlier |
| `allowParallel` | boolean | default | Defaults to `false`; permits intentional overlap with earlier nonterminal slices |
| `modelTier` | enum | default | `fast` \| `standard` \| `strong`; defaults from requirement |
| `status` | enum | default | `todo` \| `in_progress` \| `in_review` \| `done` \| `cancelled` |
| `resultSummary` | string | no | Handoff summary for later slices |

### Task

Tasks can be project-scoped or personal-scoped. Project tasks belong to a project AND a requirement (both required). Personal tasks use `scope=personal`, `personalOwnerId`, and `personalOwnerType`; they do not belong to a project, requirement, or execution slice.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID | auto | Primary key |
| `scope` | enum | default | `project` \| `personal` |
| `projectId` | UUID | project tasks | Parent project |
| `requirementId` | UUID | project tasks | Parent requirement (required for project tasks, cascade delete) |
| `executionSliceId` | UUID | no | Optional execution slice under the same requirement; project tasks only |
| `personalOwnerId` | string | personal tasks | Owner identity for personal-space tasks |
| `personalOwnerType` | enum | personal tasks | `human` \| `agent` |
| `title` | string | yes | 1–500 chars |
| `description` | string | no | |
| `status` | enum | default | `todo` \| `in_progress` \| `in_review` \| `done` \| `cancelled` |
| `priority` | enum | default | `low` \| `medium` \| `high` \| `urgent` |
| `assignee` | string | no | Human or agent identifier |
| `assigneeType` | enum | no | `human` \| `agent` |
| `tags` | string[] | no | |
| `expectedAt` | date | no | Nullable |
| `completedAt` | timestamp | auto | Set on `done`, cleared on leave `done` |

Sub-entities: **Comments** (taskId + content), **Notes** (taskId + content + pinned), **Dependencies** (taskId + dependsOnTaskId + type: `blocks` \| `related`), **Task Claims** (taskId + claimedBy + expiresAt — one active claim per task).

**Concurrency**: Tasks have a `version` field (auto-incremented on every update). Pass `expectedVersion` when updating to enable optimistic concurrency control — returns 409 Conflict on mismatch.

### Requirement Claims

Daemon workers coordinate at requirement granularity using `requirement_claims`:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID | auto | Primary key |
| `requirementId` | UUID | yes | Unique active lane owner per requirement |
| `claimedBy` | string | yes | Daemon actor id |
| `claimedByType` | enum | yes | `agent` for daemon claims |
| `daemonId` | UUID | no | Owning daemon row |
| `workerIndex` | string | no | Worker index inside the daemon process |
| `expiresAt` | timestamp | yes | Lease expiry |
| `heartbeatAt` | timestamp | yes | Last renewal |

Requirement claims mirror task-claim semantics: row-lock acquisition, expired claim cleanup, same-holder renewal, conflict on different holder, holder-only heartbeat/release, and auto-release when the requirement reaches `done`, `cancelled`, or `archived`.

### Requirement Dependencies

Requirements can depend on other requirements in the same project through `requirement_dependencies`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID | auto | Primary key |
| `requirementId` | UUID | yes | Downstream requirement |
| `dependsOnRequirementId` | UUID | yes | Upstream requirement |
| `type` | enum | default | `blocks` \| `related`; only `blocks` gates scheduling |
| `description` | string | no | |

Rules:

- Dependencies must stay inside one project.
- Self-dependencies and cycles are rejected.
- A `blocks` dependency is unblocked when the upstream requirement is `done` or `cancelled`.
- Daemon `apply-requirement` and direct requirement claim both reject blocked downstream lanes.

### Repository Catalog and Workspaces

Repositories are reusable instance catalog entries identified by normalized `host/namespace/name`. A Requirement can link zero or more repositories; those links define its executable workspace and store independent delivery state. A Task can link zero or more repositories as optional focus hints. Zero Task links means the full Requirement workspace remains available.

Rules:

- Search and reuse the canonical repository before creating one; the same entry may serve unrelated Projects.
- Add a repository to the Requirement explicitly before linking it to a Task. `tw task repo add --add-to-requirement` performs both writes intentionally.
- A running slice receives a frozen repository manifest. Additions apply to the next slice.
- Catalog endpoints and authentication policies contain no credentials. Credential profile references and readiness are actor/node scoped; trusted daemon code performs Git and forge operations.
- Multi-repository delivery is independent. A successful repository remains successful when a sibling fails and only the failed link is retried.

### Document

Project-scoped or global (no project). Supports version history — every update creates a version snapshot.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID | auto | Primary key |
| `projectId` | UUID | no | Null = global document |
| `title` | string | yes | 1–500 chars |
| `content` | string | yes | Markdown, supports `[[wiki-links]]`. Auto-normalized on save. |
| `tags` | string[] | no | |
| `summary` | string | no | Brief summary (1000 chars max). Helps AI judge relevance. |
| `keywords` | string[] | no | Key topics for search/classification |
| `docType` | enum | no | `requirement` \| `design` \| `meeting` \| `guide` \| `reference` \| `other` |
| `language` | string | no | Default: `en` |
| `readingTimeMin` | number | auto | Auto-computed from content length |
| `version` | number | auto | Auto-incremented on each update |
| `generatedBy` | string | no | AI agent ID (metadata) |
| `generationPrompt` | string | no | Prompt used to generate (metadata) |
| `confidence` | number | no | AI confidence 0-1 (metadata) |
| `needsReview` | boolean | no | Default: `false` (metadata) |

### Link Types

| Link | Types | Notes |
|------|-------|-------|
| Document ↔ Document | `reference` \| `related` \| `parent` | Bidirectional |
| Document ↔ Task | `references` \| `documents` \| `output` | |
| Document ↔ Requirement | `references` \| `documents` \| `output` | |
| Task → Task | `blocks` \| `related` | Dependency |

## Retrieval Scope Model

MCP tools, Skills, and Memories share one retrieval scope contract:

| Scope | Meaning | Storage |
|-------|---------|---------|
| `global` | Cross-project asset | `projectId = null` |
| `project` | Asset belongs to one project | `projectId = <project-id>` |
| `personal` | User-owned private workspace context | `personalOwnerId` + `personalOwnerType`, with `projectId = null` |
| `actor` | Memory or context relevant to a specific human/agent | actor/entity metadata |
| `node` | Local MCP server shared on one machine | stdio `scope=local` + `nodeId` |
| `client` | Local MCP server private to one client process | stdio `scope=private` + `clientId` |

Default retrieval behavior:

- With `projectId`: return project-specific assets plus global assets unless `includeGlobal=false` is available and set. Personal assets are included only when `includePersonal=true` and owner fields match.
- Without `projectId`: return global assets only by default. Personal assets require `includePersonal=true` plus matching `personalOwnerId`/`personalOwnerType`.
- Project assets must not leak into other projects or projectless discovery.
- Personal assets must not leak across owners or into shared project retrieval unless explicitly requested.
- Project-scoped results rank ahead of global results when relevance is otherwise similar.
- Stdio MCP visibility composes with project scope: `scope=private` also requires matching `clientId`; `scope=local` also requires matching `nodeId`; expired stdio servers are hidden.
- Sharing a local stdio MCP server with `scope=local` requires explicit consent (`localScopeConsent=true` in REST/API calls or `tw mcp register-local --shared --yes` for non-interactive CLI use).

Asset-specific mapping:

- Skills are documents with `docType=skill`; import/upsert identity includes effective global/project/personal scope, so same-title skills can coexist across scopes.
- Skill packages are filesystem-shaped distribution records. `skill_packages` owns package identity, scope, status, entry path, package manifest, and optional primary skill document linkage. `skill_package_versions` captures immutable version manifests and storage summaries. `skill_package_files` preserves normalized relative paths, hashes, size, kind, readability, executable flags, storage object linkage, and optional indexed document linkage. Documents remain searchable knowledge units; packages remain the distribution and materialization source of truth.
- Memories use nullable `projectId`, optional personal owner fields, and preserve actor/entity filters plus expiry/sliding renewal behavior.
- MCP servers/tools use nullable `projectId`, optional personal owner fields, and the stdio client/node visibility rules above.

### Activity Log

Every mutation is recorded: `entityType`, `entityId`, `action`, `actorId`, `actorType` (`human` \| `agent`), `metadata` (JSON), `createdAt`. Supports filtering by `actorType`, date range (`since`/`until`), and export as JSON or CSV.

## Authentication

### CLI

```bash
tw auth setup   # interactive: set API URL and API key
tw auth status  # show current config and test connection
```

Config stored at `~/.config/tw/config.json`. Override with env vars:
```bash
TW_API_URL=http://localhost:3001 TW_API_KEY=tw_xxx tw task list --project <id>
```

### REST API

```http
Authorization: Bearer tw_your_api_key
Content-Type: application/json
X-Actor-Id: my-agent
X-Actor-Type: agent
```

With a valid API key, actor is auto-set to `apikey:{keyId}`. Without a key, `X-Actor-Id` / `X-Actor-Type` headers are used (defaults: `anonymous` / `human`). Always set `X-Actor-Type: agent`.

## Conventions

### Status Rules

**Tasks and Requirements**: Any status → any other status freely, **except** `cancelled` is terminal.

Side effects on tasks: `done` → sets `completedAt`; leaving `done` → clears it. Every status change → recorded in `task_status_log`.

**Dependency enforcement**: Moving a task to `in_progress`, `in_review`, or `done` is blocked if it has unfinished task-level `blocks` dependencies. Daemon requirement-lane acquisition is blocked if the requirement has unfinished requirement-level `blocks` dependencies. Pass `--force` (CLI) or `force=true` (REST) only for task status transitions.

**Projects**: `active` \| `archived`. Delete = archive.

### IDs and Timestamps

All IDs: UUID v4. All timestamps: ISO 8601 UTC (`2026-03-05T10:30:00.000Z`).

### Pagination

List commands for projects, requirements, tasks, and documents request paginated `summary` views by default. Use `--page` and `--page-size` to navigate; use `--full --json` only when nested relationships or Markdown content are needed. Full views remain paginated and default to five items per page for requirements, tasks, and documents (ten for projects); summary views default to twenty items. Use `--completed-within-days 0` on requirement/task lists to include all terminal history instead of the default recent terminal window.

CLI `--json` list output is `{ "items": [...], "meta": {...} }`; `meta` includes `view`, filters, totals, and pagination fields. The REST API uses the same paginated envelope when `view=summary` or `view=full`; omitting `view` preserves the legacy full-array response where supported. `limit`/`offset` remain available for endpoints that expose cursor-style pagination.

### Delete Behavior

| Entity | Behavior |
|--------|----------|
| Task | Soft delete → `cancelled` |
| Requirement | Soft delete → `cancelled` |
| Project | Soft delete → `archived` |
| Document | **Hard delete** |

### Error Format

```json
{
  "error": "Validation error",
  "details": { "fieldErrors": { "title": ["Required"] }, "formErrors": [] }
}
```

HTTP codes: `200` OK, `201` Created, `400` Validation, `401` Unauthorized, `404` Not Found, `409` Conflict (version mismatch or claim conflict).

### Content Format

Descriptions: plain text or Markdown. Documents: Markdown with `[[wiki-links]]` (`[[Title]]` or `[[Title|Display]]`).

## Quick Start: CLI

```bash
# First-time setup
tw auth setup   # enter API URL and API key

# Create project
tw project create --name "My Project" --description "..."

# Create requirement
tw req create --project $PROJECT_ID --title "User Auth" --priority high

# Create task (requirementId is required)
tw task create --project $PROJECT_ID --req $REQ_ID --title "Login page"

# Create personal task (no project or requirement)
tw task create --personal --title "Follow up with Ada" --priority medium

# List compact summaries (use --full --json for complete rows)
tw project list --query "platform" --json
tw req list --project $PROJECT_ID --status approved --query "auth" --json
tw task list --project $PROJECT_ID --status todo --page 2 --page-size 20 --json
tw doc list --project $PROJECT_ID --query "architecture" --json
tw doc list --project $PROJECT_ID --full --json

# List tasks
tw task list --project $PROJECT_ID --status todo
tw task list --personal --status todo

# Change task status
tw task status $TASK_ID in_progress --reason "Starting now"

# Plan requirement execution slices
tw req update $REQ_ID --model-tier strong
tw req slice create $REQ_ID --title "API routes" --model-tier strong --tasks "$TASK_ID,$OTHER_TASK_ID"
tw req slice list $REQ_ID

# Validate or atomically apply a batch planning file
tw plan validate --file plan.yaml
tw plan apply --file plan.yaml

# Inspect and manage dependencies
tw task dep list $TASK_ID --json
tw task dep add $TASK_ID $BLOCKING_TASK_ID --type blocks
tw req dep list $REQ_ID --json
tw req dep add $REQ_ID $UPSTREAM_REQ_ID --type blocks

# Discover and define a Requirement repository workspace
tw repo search "service" --json
tw repo create --host github.com --namespace example --name service --https-url https://github.com/example/service.git
tw req repo add $REQ_ID $REPOSITORY_ID --base-branch main
tw task repo add $TASK_ID $REPOSITORY_ID
tw repo credential readiness $REPOSITORY_ID --operation push --json

# Inspect project relationship graph / dependency DAG
tw project graph $PROJECT_ID --format mermaid
tw project dag $PROJECT_ID --kind requirement --format mermaid

# Inspect and manage document links and versions
tw doc links $DOC_ID
tw doc backlinks $DOC_ID
tw doc link $DOC_ID $TARGET_DOC_ID --type reference
tw doc link-task $DOC_ID $TASK_ID --type references
tw doc link-req $DOC_ID $REQ_ID --type documents
tw doc versions $DOC_ID

# Inspect requirement-lane claims (daemon/debugging)
tw req claims --project $PROJECT_ID --json
tw req claim-status $REQ_ID --json

# Search
tw search "authentication" --project $PROJECT_ID

# Register and inspect multi-file skill packages
tw context package register ./skills/my-skill --project $PROJECT_ID --version 1.0.0
tw context package list --project $PROJECT_ID
tw context package files $PACKAGE_ID
tw context package read $PACKAGE_ID SKILL.md
tw context package install $PACKAGE_ID --print-path
tw context package health $PACKAGE_ID
tw context package reindex $PACKAGE_ID
tw context package update $PACKAGE_ID --status deprecated

# Add --json to any command for machine-readable output
tw task get $TASK_ID --json
```

Execution slices are sequential by default. A task in a later slice cannot advance until every earlier slice is `done` or `cancelled`. Use `--allow-parallel` only for a slice that is intentionally independent. Daemon task tags use `executor:<name>` (or legacy `tool:<name>`) as an any-of AI executor allowlist, `capability:<name>` for required all-of auxiliary capabilities, and `capability-any:<group>:<name>` for grouped any-of auxiliary capabilities.

## Daemon Requirement Lanes

`tw daemon start` runs autonomous workers. With `--workers N`, concurrency is requirement-level. Workers can map model tiers to concrete Codex models:

```bash
tw daemon start --tools codex --project $PROJECT_ID --workers 3 \
  --model fast:gpt-5.4-mini \
  --model standard:gpt-5.5 \
  --model strong:gpt-5.5 \
  --think fast:low \
  --think standard:medium \
  --think strong:high \
  --prompt-file ~/.config/tw/worker-extra.md
```

Each worker:

1. registers/heartbeats as part of the daemon
2. calls the daemon apply endpoint to claim one requirement lane
3. prepares one isolated branch worktree per frozen Requirement repository under `~/.task-weaver/requirement-workspaces/...`, backed by node-local shared base checkouts
4. writes a secret-free repository manifest and spawns the selected AI CLI at the composite workspace root for the next execution slice, or the whole lane if no slices exist; Codex workers also receive the mapped `model_reasoning_effort` when `--think <tier:effort>` is configured, and local extra instructions from `--prompt` / `--prompt-file` when supplied
5. renews the requirement claim until the subprocess exits
6. when all requirement tasks are terminal, independently commits and pushes each repository branch, discovers or creates provider-supported PRs when possible, records each delivery outcome, and moves the requirement to `in_review`
7. releases the requirement claim and reports worker state for the Web Daemons page

The Web Daemons page shows daemon status, active worker lanes, current requirement, active task, task roadmap, selected model tier/model, Codex think effort when configured, branch, worktree path, and stale lease indicators.

## Daemon Review and Merge

`tw daemon review` and `tw daemon merge` split review from final merge for requirement branches that have already been finalized to `in_review`:

```bash
tw daemon review --project $PROJECT_ID --workers 1 --base main \
  --check "pnpm typecheck" \
  --check "pnpm test" \
  --prompt-file ~/.config/tw/review-extra.md
```

Each review worker:

1. calls `POST /api/v1/daemons/:id/apply-review`
2. receives one server-claimed `in_review` requirement lane for review ownership
3. checks out the requirement branch worktree and merges `origin/<base>` into it
4. runs configured `--check` commands
5. runs AI review unless `--skip-ai-review` is set
6. pushes the reviewed branch and marks the requirement `ready_to_merge`
7. on conflicts, failed checks, or review findings, creates a new `todo` follow-up task under the same requirement, moves the requirement back to `in_progress`, comments the review summary, and releases the claim

Each merge worker:

1. calls `POST /api/v1/daemons/:id/apply-merge`
2. receives one server-claimed `ready_to_merge` requirement lane
3. merges `origin/<requirement-branch>` into `origin/<base>` from a detached merge worktree
4. pushes `HEAD:<base>` and marks the requirement `done`
5. on final merge conflicts, creates a new `todo` follow-up task under the same requirement, moves the requirement back to `in_progress`, comments the merge summary, and releases the claim

The merge step uses Git push (`HEAD:<base>`), so it works with any Git remote that accepts that push, including Gitea repositories when branch permissions allow it. If branch protection requires PR-only merging, leave the requirement in `ready_to_merge` for manual handling or add a forge-specific merge provider later.

Requirement-lane claim commands are available for debugging or manual lane ownership:

```bash
tw req claim <requirement-id> --duration 30
tw req heartbeat <requirement-id> --extend 30
tw req claim-status <requirement-id> --json
tw req claims --project <project-id> --json
tw req release <requirement-id> --reason "handing off"
```

## Relationship Graphs and DAG Views

The CLI can render project relationships without extra tooling:

```bash
tw project graph <project-id> --format table
tw project graph <project-id> --format json
tw project graph <project-id> --format mermaid
tw project graph <project-id> --format dot
```

`tw project graph` includes documents, tasks, requirements, document links, task dependencies, requirement dependencies, and requirement-to-task containment edges.

For dependency-only views, use:

```bash
tw project dag <project-id> --kind all --type blocks --format mermaid
tw project dag <project-id> --kind task --type all --format dot
tw project dag <project-id> --kind requirement --format table
```

The DAG command renders dependency edges from upstream blocker to downstream blocked item. `--kind` accepts `task`, `requirement`, or `all`; `--type` accepts `blocks`, `related`, or `all`.

## Quick Start: REST API

```bash
# Health check
curl http://localhost:3001/health

# Create project
curl -X POST http://localhost:3001/api/v1/projects \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "description": "..."}'

# Create requirement
curl -X POST http://localhost:3001/api/v1/projects/$PROJECT_ID/requirements \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "User Auth", "priority": "high"}'

# Create task (requirementId is required)
curl -X POST http://localhost:3001/api/v1/projects/$PROJECT_ID/tasks \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Login page", "requirementId": "'$REQ_ID'", "priority": "high"}'
```

For complete REST endpoint reference, see [rest-api-reference.md](rest-api-reference.md).

## Workflow Decision Tree

Determine what you need to do, then follow the appropriate workflow:

| Goal | Workflow | Reference |
|------|----------|-----------|
| Bootstrap a new project from scratch | Project Onboarding | [workflows.md § Project Onboarding](workflows.md#project-onboarding) |
| Define a multi-repository Requirement workspace | Multi-Repository Requirement Workspace | [workflows.md § Multi-Repository Requirement Workspace](workflows.md#multi-repository-requirement-workspace) |
| Break a requirement into tasks | Requirement Decomposition | [workflows.md § Requirement Decomposition](workflows.md#requirement-decomposition) |
| Plan tasks for a sprint | Sprint Planning | [workflows.md § Sprint Planning](workflows.md#sprint-planning) |
| Build interconnected documentation | Knowledge Graph | [workflows.md § Knowledge Graph Building](workflows.md#knowledge-graph-building) |
| Generate a status report | Progress Reporting | [workflows.md § Progress Reporting](workflows.md#progress-reporting) |
| Track requirement progress over time | Burndown Analysis | [workflows.md § Burndown Analysis](workflows.md#burndown-analysis) |
| Assess project health and risks | Health Assessment | [workflows.md § Health Assessment](workflows.md#health-assessment) |
| Coordinate multiple agents on same project | Multi-Agent Collaboration | [workflows.md § Multi-Agent Collaboration](workflows.md#multi-agent-collaboration) |

For detailed step-by-step workflow guides, see [workflows.md](workflows.md).

## Task Locking (Claiming)

> **Daemon/executor mode exception:** if you were spawned by `tw daemon`, the daemon already holds a requirement claim and selected the active task — **skip this whole section** (do not claim or release). Process the requirement roadmap and set task/requirement statuses. See [Operating Modes](#operating-modes).

In **interactive/collaborative** mode, before starting work on any task you **MUST** lock (claim) it to prevent race conditions or duplicate execution by other agents:
```bash
tw task claim <task-id> --duration <minutes>
```
Choose an appropriate duration (e.g. `30` minutes) based on the task's complexity. If you need more time during execution, run the command again with a new duration to extend your lock. Once done, set the task status to `done` or `in_review` and release the lock:
```bash
tw task release <task-id>
```

## Discovering & Calling External MCP Tools

Task Weaver acts as an MCP registry: external MCP servers can be registered, and their tools are indexed so you can discover and invoke them through the platform — without wiring up each MCP server yourself.

### Visibility model

Tools are returned based on your identity — you never need to filter manually:

| Server type | Registered via | Visible to |
|-------------|---------------|------------|
| **Global** | `sse` / `streamable-http` transport | Everyone |
| **Local-shared** | stdio + `--shared` flag | All agents on the same machine (`nodeId` match) |
| **Private** | stdio (default) | Only the registering process (`clientId` match) |

Your `clientId` and `nodeId` are auto-generated on first run and stored in `~/.config/tw/config.json`. They are passed automatically on every `tw mcp search` call — you don't need to supply them.

### CLI usage

```bash
# Find a tool by describing what you need
tw mcp search "send a slack message" --json

# Inspect a tool's input schema before calling
tw mcp tool <tool-id> --json

# Invoke it (arguments as JSON)
tw mcp call <tool-id> --params '{"channel": "#general", "text": "Build passed"}' --json

# List indexed tools / registered servers
tw mcp tools --json
tw mcp servers --json

# Host a local stdio MCP server — private (default, only this process can use it)
tw mcp register-local --server <id> --command "npx -y @modelcontextprotocol/server-filesystem" --args '["/tmp"]'

# Host a local stdio MCP server — shared with all agents on this machine
tw mcp register-local --server <id> --command "npx -y @modelcontextprotocol/server-filesystem" --args '["/tmp"]' --shared
```

Use this when a task needs a capability the core `tw` commands don't cover (e.g. external integrations). Tool calls are logged and attributed to your actor identity.

## Best Practices

1. **Always provide a reason** when changing task status — improves audit trail
2. **Link tasks to requirements** — every task needs a `requirementId`
3. **Use wiki-links in documents** — builds a connected knowledge graph
4. **Check for existing entities** before creating duplicates (use `tw search`)
5. **Use meaningful actor IDs** — configure via `tw auth setup`
6. **Read before write** — query current state before making changes
7. **Verify after batch operations** — use `tw activity` to confirm changes
8. **Claim before working** — in interactive/multi-agent mode, always `tw task claim` before starting work. **Exception:** in daemon/executor mode the daemon already holds the requirement lane — don't claim or release (see [Operating Modes](#operating-modes))
9. **Use `--json`** — pipe CLI output to parse task IDs and other fields programmatically
10. **Keep repository credentials local** — store only non-secret endpoints and profile references in Task Weaver; never put tokens in URLs, prompts, comments, or documents
