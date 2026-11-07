---
name: task-weaver-overview
description: Core platform knowledge — data model, authentication, conventions, and quick start guide for Task Weaver.
metadata:
  version: "1.2.0"
  source-repository: "limmytian/task-weaver"
  source-path: "skills/task-weaver"
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

Identify whether you are in an interactive session or a task worker before touching tasks.

| Mode | How you got here | Coordination |
|------|------------------|-------------------|
| **Interactive / collaborative** | A human (or another agent) is directing you; you pick what to work on | Coordinate with the owner, inspect status and dependencies, and record progress |
| **Task worker / executor** | A worker launched you for one task in an isolated workspace | The worker owns the task attempt and lease; do not claim, report, commit, or push independently |

**Task worker mode:** Follow the worker-provided prompt and work only in its isolated workspace. Leave changes and `result.md` for the worker; the worker renews the task lease, performs configured Git delivery, and publishes the outcome. Coordinator and acceptance tasks are ordinary tasks with additional output instructions.

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

### Execution Slice (Legacy)

Historical execution slices are retained for audit; new plans use task dependencies.

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
| `executionSliceId` | UUID | no | Retained historical association; new tasks do not assign slices |
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

Sub-entities: **Comments** (taskId + content), **Notes** (taskId + content + pinned), **Dependencies** (taskId + dependsOnTaskId + type: `blocks` \| `related`).

**Concurrency**: Tasks have a `version` field (auto-incremented on every update). Pass `expectedVersion` when updating to enable optimistic concurrency control — returns 409 Conflict on mismatch.

### Worker attempts

Workers acquire individual tasks using fenced attempt leases. Historical task and requirement claims are retained for audit and do not schedule new work.

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
- Task acquisition respects blocking dependencies.

### Repository Catalog and Workspaces

Repositories are reusable instance catalog entries identified by normalized `host/namespace/name`. A Requirement can link zero or more repositories; those links define its executable workspace and store independent delivery state. A Task can link zero or more repositories as optional focus hints. Zero Task links means the full Requirement workspace remains available.

Rules:

- Search and reuse the canonical repository before creating one; the same entry may serve unrelated Projects.
- Add a repository to the Requirement explicitly before linking it to a Task. `tw task repo add --add-to-requirement` performs both writes intentionally.
- Each worker attempt receives a frozen repository manifest. Execution-relevant changes fence the old attempt and require reconciliation against current inputs.
- Catalog endpoints and authentication policies contain no credentials. Credential profile references and readiness are actor/node scoped; the worker performs Git delivery and the server verifies forge evidence.
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
- Stdio MCP visibility composes with project scope: `scope=private` also requires matching `clientId`; `scope=local` also requires matching `nodeId`; expired stdio servers are hidden. Both modes also require the verified registration actor and credential; these supplied IDs are discovery constraints rather than identity proof.
- Sharing a local stdio MCP server with `scope=local` requires explicit consent (`localScopeConsent=true` in REST/API calls or `tw mcp register-local --shared --yes` for non-interactive CLI use).

Asset-specific mapping:

- Skills are documents with `docType=skill`; import/upsert identity includes effective global/project/personal scope, so same-title skills can coexist across scopes.
- Skill packages are filesystem-shaped distribution records. `skill_packages` owns package identity, scope, status, entry path, package manifest, and optional primary skill document linkage. `skill_package_versions` captures immutable version manifests and storage summaries. `skill_package_files` preserves normalized relative paths, hashes, size, kind, readability, executable flags, storage object linkage, and optional indexed document linkage. Documents remain searchable knowledge units; packages remain the distribution and materialization source of truth.
- Memories use nullable `projectId`, optional personal owner fields, and preserve actor/entity filters plus expiry/sliding renewal behavior.
- MCP servers/tools use nullable `projectId`, optional personal owner fields, and the stdio client/node visibility rules above.

### Activity Log

Every mutation is recorded: `entityType`, `entityId`, `action`, `actorId`, `actorType` (`human` \| `agent`), `metadata` (JSON), `createdAt`. Supports filtering by `actorType`, date range (`since`/`until`), and export as JSON or CSV.

## Authentication

Access requires a revocable browser session or a subject-bound scoped API Key.
Create the Key through authenticated account settings for self or an owned Agent,
with explicit grants and expiry (including an explicit no-expiry choice).

```bash
tw auth login --api-url http://127.0.0.1:3001
tw auth whoami --json
tw auth status --json
tw auth logout
```

Login reads a secret from hidden input or stdin, verifies it, then saves it. Do not
put a Key in a command argument. Remote login requires HTTPS; loopback HTTP is
supported. `tw auth setup` is an interactive alternative. Configuration defaults
to `~/.config/tw/config.json`; `TW_CONFIG_DIR` selects another directory.
Directories use `0700` and credential files `0600`. `TW_API_URL`/`TW_API_KEY`
override saved settings. Local logout does not revoke a shared server Key; revoke
it separately and unset any environment override.

```http
Authorization: Bearer <subject-bound-scoped-key>
Content-Type: application/json
```

The verified credential supplies a stable actor UUID. A human Key stays human;
a managed Agent Key stays Agent. Rotation does not change identity. Actor headers,
clientId/nodeId and requested owner fields never authenticate or grant access.
Do not combine Bearer and session credentials. Browser mutations require exact
Origin, the CSRF cookie and `X-CSRF-Token`.

Effective authority intersects current actor permissions, credential ceiling and
any execution bounds. Viewer reads ordinary project resources; member writes;
maintainer manages below ownership; owner manages membership/ownership while
retaining a human owner. Execution/tool rights are explicit entitlements.
Instance administration does not grant project or other humans' personal content.
Project scopes do not include personal space. Personal data belongs to its human
owner, while Agent execution is separately attributed. Shared repository catalog
management requires administrator plus explicit global `repository.manage`;
project links do not authorize catalog editing.

Task delegation lasts at most 15 minutes and never outlives the parent credential
or original lease. Only the original supervisor credential may renew without
widening tasks, repositories or actions. Revocation, expiry, membership/manifest
changes and lease supersession invalidate old authority permanently. Children use
a bounded local broker, never an inherited supervisor Key. SSE access does not
permit execution; reconnect and replay recheck current resource access.

Public signup is closed. First-admin bootstrap uses a deployment Secret once;
administrators provision/recover accounts with finite one-time activation.
Legacy actor strings/Keys are not verified identity: offline upgrade requires
explicit owner mappings, quarantines unmapped data and reissues scoped Keys.
SLO, unconverted background workers and personal autonomous Ti remain closed.
Source integration does not authorize release/deployment.

## Conventions

### Status Rules

**Tasks**: Status changes are flexible, except `cancelled` is terminal. Dependency
and dependency checks still apply.

**Requirements** follow the server's delivery state machine. A `draft` must be
approved before entering execution. `done` can remain done or be archived;
`cancelled` and `archived` are terminal. Review and integration transitions also
depend on the configured workflow and its evidence and authority checks. Read the
current requirement and workflow before changing its state.

Side effects on tasks: `done` → sets `completedAt`; leaving `done` → clears it. Every status change → recorded in `task_status_log`.

**Dependency enforcement**: Moving a task to `in_progress`, `in_review`, or `done` is blocked if it has unfinished task-level `blocks` dependencies. Worker acquisition is blocked if the requirement has unfinished requirement-level `blocks` dependencies. Pass `--force` (CLI) or `force=true` (REST) only for task status transitions.

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

Install from the public npm registry with Node.js 20 or newer; no source checkout
is required. Set the API origin to your Task Weaver instance and enter a scoped
Key through the hidden login prompt.

```bash
npm install --global @task-weaver/cli
tw --version

# First-time setup
tw auth login --api-url http://localhost:3001   # Use your instance API origin

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

# Inspect worker attempts
tw worker attempts --project $PROJECT_ID

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

Historical slices do not gate worker tasks. Model execution order with task dependencies.

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

## Task coordination

Task workers acquire tasks atomically and renew their own leases. Follow the
worker prompt and leave the outcome for the supervisor. Interactive agents
coordinate with the owner, check task status and dependencies, and record
progress; legacy claim commands do not reserve work in worker-only projects.
Use `expectedVersion` on updates where available. An expired or uncertain
worker attempt needs human inspection before an explicit retry.

## Discovering & Calling External MCP Tools

Task Weaver acts as an MCP registry: external MCP servers can be registered, and their tools are indexed so you can discover and invoke them through the platform — without wiring up each MCP server yourself.

### Visibility model

Tools are returned based on your identity — you never need to filter manually:

| Server type | Registered via | Visible to |
|-------------|---------------|------------|
| **Global** | `sse` / `streamable-http` transport | Verified actors whose credential grants allow global reads |
| **Local-shared** | stdio + `--shared` flag | Registered actor and credential, with matching `nodeId` |
| **Private** | stdio (default) | Registered actor and credential, with matching `clientId` |

Local stdio commands execute on the authenticated `register-local` client. The API queues authorized calls and accepts one leased response; it never starts these commands. Local environment variables stay on that client. Cross-identity node sharing requires trusted node enrollment and is currently closed. Server management requires `mcp.manage` and invocation requires `mcp.invoke` in the live resource scope. Instance administration grants no implicit content access.

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

# Host a local stdio MCP server — shared within its authenticated registration
tw mcp register-local --server <id> --command "npx -y @modelcontextprotocol/server-filesystem" --args '["/tmp"]' --shared
```

Use this when a task needs a capability the core `tw` commands don't cover (e.g. external integrations). Tool calls are logged and attributed to your actor identity.

## Best Practices

1. **Always provide a reason** when changing task status — improves audit trail
2. **Link tasks to requirements** — every task needs a `requirementId`
3. **Use wiki-links in documents** — builds a connected knowledge graph
4. **Check for existing entities** before creating duplicates (use `tw search`)
5. **Use verified identities** — check the stable credential subject with `tw auth whoami`
6. **Read before write** — query current state before making changes
7. **Verify after batch operations** — use `tw activity` to confirm changes
8. **Coordinate before working** — inspect status and dependencies; task workers own their leases (see [Operating Modes](#operating-modes))
9. **Use `--json`** — pipe CLI output to parse task IDs and other fields programmatically
10. **Keep repository credentials local** — store only non-secret endpoints and profile references in Task Weaver; never put tokens in URLs, prompts, comments, or documents

## Agent Token Usage

Use `tw usage runs --project <id> --json` for compact whole-process records and
`tw usage summary --project <id> --req <id> --json` for totals and coverage.
Add `--task`, `--since`, or `--until` to narrow the scope. Shared requirement runs
are counted once at requirement/project scope and excluded from individual tasks.
Missing counters are unknown; cache counters may overlap input and must not be
added. Summary totals are nullable decimal strings, with reporting-process counts.
Coverage warns about known Ti attempts without reports and excludes unregistered
historical daemon processes. No money or per-call records are stored.

Actual Ti runtimes can report compact cumulative snapshots using
`tw usage report-ti <run-id> --file usage.json --json`, independently of Partners.
Reuse a process UUID and start time across increasing revisions; fresh retries
use fresh process UUIDs. Initial Ti registration requires the current attempt and
worker lease. Reporting requires the assigned-agent or run-creator API key.
See [rest-api-reference.md](rest-api-reference.md) for the endpoints.

## Serving Task Weaver to MCP clients

`tw mcp serve [--read-only]` exposes Task Weaver collaboration tools over local
stdio using the configured API URL and subject-bound API key. It requires an API
server with inbound MCP support. Remote clients can use Streamable HTTP at
`/api/v1/mcp-server` with a Bearer key on every request. Both adapters use the same
live authorization-filtered catalog, resource checks, dependency and workflow guards.
Read-only mode hides writes and rejects known write names at dispatch.

This inbound Server is separate from the outbound Registry commands above.
OAuth-only onboarding, resources, prompts, attachments, daemon controls, registry
management and release actions are not part of this catalog. See the
[MCP Server guide](../../docs/mcp-server.md) for credentials, limits and setup.

## Capability Diagnostics

Interactive CLI/REST clients can inspect selected-project readiness with
`tw context readiness --project <id> --json`. Permission, registered content,
metadata candidates and API runtime observations are separate. Missing discovery
or runtime access is unknown, not an empty inventory or absent configuration.
Inspect selected exact content, source freshness and schemas/graphs before use;
optional unavailable execution can degrade to instructions.

`tw context evidence --project <id> --json` additionally requires current project
read/audit access and rechecks current asset visibility before counts/pagination.
It shows unique visible references and separate progress reports, not call totals,
proof of task usefulness or inferred model cost. Whole-process token reports stay
in the existing Usage commands. Worker attempts use scoped credentials; do not seek broader aggregate audit grants to improve their prompts.
See [Capability diagnostics](rest-api-reference.md#capability-diagnostics) for
coverage and input details. Installed copies require the existing staged/versioned
refresh workflow; remote registration is a separate authorized action.

## Live Planning and Recovery

Task workers use fenced task attempts and preserve interrupted workspaces. Inspect the attempt and any external effects before deciding whether a retry is safe. Use `tw worker attempts`, `tw worker git-deliveries`, and `tw worker resolve` for the selected project. Dependencies and acceptance are ordinary tasks. Leases do not undo external requests or prove that remote processes have stopped.

## Bootstrap and local instruction freshness

A local skill installation is optional. Start remote clients with
`tw_context_bootstrap` and `tools/list`; CLI clients use `tw context bootstrap --json`.
Load relevant summaries and selected exact sources instead of a full catalog.
Instruction access, useful inventory and executable runtime readiness are separate.
The instruction-only `task-weaver-execution` starter package provides task start,
controlled Git, recovery, inspected MCP and reviewed memory workflows on demand.

This file's `metadata.version` is an instruction-content version, not the API/CLI
product version or proof of server compatibility. Check live contracts and CLI
help before using version-sensitive options. For local updates, identify the
canonical repository/ref and compare file hashes against the installed copy.
For hosted packages, record package ID, exact version and file SHA-256 values
from the manifest. Read or materialize a candidate into a fresh staging directory
(using a unique `--cache-dir` when installing a package), compare it with the
installed files, and merge intentional customizations before an explicitly chosen
replacement. Keep a record of source ref, hashes and local edits. Do not silently
overwrite installed skills or assume that restarting a client refreshed them.

Use current task/run authority after replan. Report verified artifacts and concise
asset references/outcomes; abstention is valid when capabilities add no value.
Memory saves need current authorization, explicit review/confirmation and a fresh
source. Never save raw conversations, secrets or unverified conclusions.
