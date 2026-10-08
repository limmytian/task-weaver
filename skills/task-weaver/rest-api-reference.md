---
name: rest-api-reference
description: Complete REST API endpoint reference for Task Weaver — all routes, parameters, request/response formats.
keywords: ["REST API", "endpoints", "HTTP", "authentication", "headers", "CRUD"]
tags: ["api", "reference"]
---

# REST API Reference

Base URL: `http://localhost:3001/api/v1`

## Required Headers

```http
Authorization: Bearer tw_your_api_key
Content-Type: application/json
```

The bearer must be a subject-bound scoped Key. Its stable actor, live membership
and scope/action ceiling determine authority; Actor/client/node headers are never
identity proof. Human Keys stay human. Do not mix Bearer and session credentials.
Browser sessions require exact Origin plus CSRF cookie/token for mutations,
including GraphQL POST and tRPC mutations. Public health/version and explicit
authentication entry points return no ordinary resource authority. Invalid Bearer
headers are rejected even on public entry points.

## Account and credential lifecycle (0.3.3)

| Method/path under `/api/v1` | Purpose and boundary |
| --- | --- |
| `GET /auth/setup-status` | Public, uncached `{ initialized: boolean }` only; unavailable state fails closed |
| `GET /auth/csrf` | Public signed browser CSRF challenge |
| `POST /auth/bootstrap` | One-time first human administrator; deployment bootstrap Secret |
| `POST /auth/login`, `POST /auth/activate` | Local login or finite one-time activation; no public signup |
| `GET /auth/me`, `POST /auth/logout` | Verified identity and session logout |
| `POST /auth/reauthenticate`, `POST /auth/password` | Recent authentication and password lifecycle |
| `GET /auth/sessions`, `DELETE /auth/sessions/:id` | Owner-scoped session metadata/revocation |
| `GET/POST /auth/accounts`, `PATCH /auth/accounts/:id`, `POST /auth/accounts/:id/recover` | Recently authenticated human administrator; no implicit content access |
| `GET /auth/agents` | Owned Agents; `status=active` by default, explicit `disabled` / `deleted`; `query`, `page`, `pageSize` (default 20, maximum 50). Array response, stable ordering; continue until fewer than pageSize rows |
| `POST /auth/agents`, `DELETE /auth/agents/:id` | Create / irreversibly disable an owned Agent |
| `GET /auth/agents/:id` | Owned non-deleted Agent detail; disabled identities are inspectable |
| `GET /auth/agents/:id/projects` | Authorized named project memberships or `view=available` member-administration choices; bounded query/page/pageSize; current role-derived and explicit permissions |
| `DELETE /auth/agents/:id/retired` | Soft delete an owned disabled Agent only; recent session, Origin and CSRF required. Identity/audit references remain |
| `DELETE /auth/admin/agents/:id` | Explicit administrator disablement; no content grant |
| `POST /auth/projects`, `GET /auth/projects/:id/members` | Guarded project creation and membership visibility |
| `PUT/DELETE /auth/projects/:id/members/:actorId`, `POST /auth/projects/:id/owner` | Role/entitlement ceiling, live membership and last human owner protection |
| `GET/POST /api-keys`, `POST /api-keys/:id/rotate`, `DELETE /api-keys/:id` | Authorized self/managed-Agent subject; strict scoped grants and explicit expiry; one-time raw secret |

Keys rotate without changing actor identity. No-expiry is explicit `expiresAt:
null`, not omitted. Revocation/rotation invalidates dependent authority. An admin
cannot read another actor's private content. Personal owner selectors constrain
server checks; they cannot redirect ownership. Search/count/history/download and
nested graph responses are filtered before limits/expansion. SSE connections and
webhook retries reauthorize live resource access, including credential revocation.

Daemon task capabilities are bounded to the original lease, parent credential,
phase, tasks and repositories, for at most 15 minutes. Only the original supervisor
credential can renew without enlarging bounds. SLO/unconverted background workers
and personal autonomous Ti remain closed. See `docs/authenticated-access.md` in
the source repository for operator/bootstrap and offline upgrade/recovery guidance.

---

## Projects

### List Projects

```
GET /api/v1/projects?status=active&view=summary&page=1&pageSize=20&query=task
```

| Param | Type | Description |
|-------|------|-------------|
| `status` | enum | `active` \| `archived` |
| `query` | string | Case-insensitive search in project name and description |
| `view` | enum | Omit for the legacy full array; `summary` returns scalar navigation fields; `full` returns paginated full rows |
| `page` | integer | One-based page number when `view` is provided (default: `1`) |
| `pageSize` | integer | Items per page, 1–50 (summary default: `20`, full default: `10`) |

When `view` is provided, the response is a paginated envelope:

```json
{ "items": [{ "id": "...", "name": "...", "status": "active", "updatedAt": "..." }], "total": 1, "page": 1, "pageSize": 20, "pageCount": 1, "view": "summary" }
```
### Create Project

```
POST /api/v1/projects
```

```json
{ "name": "My Project", "description": "..." }
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | yes | 1–255 chars |
| `description` | string | no | |

Response: `201`

### Get Project

```
GET /api/v1/projects/:id
```

### Update Project

```
PATCH /api/v1/projects/:id
```

```json
{ "name": "New Name", "description": "...", "status": "archived" }
```

### Get Project Statistics

```
GET /api/v1/projects/:id/stats
```

Returns aggregated project statistics:

```json
{
  "totalTasks": 50,
  "byStatus": { "todo": 20, "in_progress": 15, "done": 10, "cancelled": 5 },
  "byPriority": { "low": 5, "medium": 20, "high": 15, "urgent": 10 },
  "blockedTasks": 3,
  "avgCompletionDays": 4.2,
  "requirementProgress": [
    { "id": "uuid", "title": "Auth System", "status": "approved", "totalTasks": 10, "completedTasks": 7 }
  ]
}
```

### Get Project Health Dashboard

```
GET /api/v1/projects/:id/health
```

Returns a composite health score (0–100) with detailed breakdowns:

```json
{
  "projectId": "uuid",
  "healthScore": 72,
  "scoreBreakdown": {
    "completionRate": { "score": 85, "weight": 0.3, "detail": "17/20 tasks done" },
    "overdueRate": { "score": 60, "weight": 0.25, "detail": "2 overdue tasks" },
    "activityTrend": { "score": 75, "weight": 0.15, "detail": "15 activities this week" },
    "requirementCoverage": { "score": 90, "weight": 0.15, "detail": "9/10 requirements have tasks" },
    "velocityTrend": { "score": 50, "weight": 0.15, "detail": "velocity declining" }
  },
  "risks": {
    "overdueTasks": [...],
    "staleTasks": [...],
    "unassignedTasks": [...],
    "requirementsWithoutTasks": [...]
  },
  "velocity": {
    "weeks": [{ "week": "2026-W10", "completed": 5 }, ...],
    "trend": "declining"
  },
  "activitySummary": { "last7d": 25, "last30d": 80 }
}
```

### Get Knowledge Graph

```
GET /api/v1/projects/:id/knowledge-graph
```

Returns a graph of all project entities and their relationships:

```json
{
  "projectId": "uuid",
  "nodes": [
    { "id": "uuid", "type": "document", "label": "API Design", "metadata": {...} },
    { "id": "uuid", "type": "task", "label": "Implement auth", "metadata": {...} },
    { "id": "uuid", "type": "requirement", "label": "User Auth", "metadata": {...} }
  ],
  "edges": [
    {
      "source": "uuid",
      "target": "uuid",
      "sourceType": "document",
      "targetType": "task",
      "linkType": "references"
    },
    {
      "source": "uuid",
      "target": "uuid",
      "sourceType": "requirement",
      "targetType": "task",
      "linkType": "contains"
    }
  ],
  "stats": {
    "documentCount": 12, "taskCount": 30, "requirementCount": 5,
    "edgeCount": 45, "isolatedNodes": 2
  }
}
```

CLI:

```bash
tw project graph <project-id> --format table
tw project graph <project-id> --format json
tw project graph <project-id> --format mermaid
tw project graph <project-id> --format dot
tw project dag <project-id> --kind task --type blocks --format mermaid
tw project dag <project-id> --kind requirement --type all --format table
```

`graph` returns/renders the full project relationship graph. `dag` filters dependency edges to task and/or requirement dependencies and orients them from upstream blocker to downstream blocked item.

### Delete (Archive) Project

```
DELETE /api/v1/projects/:id
```

---

## Tasks

### List Tasks

```
GET /api/v1/projects/:projectId/tasks?view=summary&page=1&pageSize=20&q=release&status=todo&assignee=alice&priority=high&tag=backend&completedWithinDays=14
```

When `view` is provided, the response is a paginated envelope:
`{ items, total, page, pageSize, pageCount, view }`. `summary` returns scalar
task fields only; `full` includes linked repository details. Explicit `full`
requests default to five items per page and never return the complete
collection in one response. Omitting `view` preserves the legacy full array
response for API compatibility.

| Param | Type | Description |
|-------|------|-------------|
| `view` | enum | `summary` or `full` |
| `page` | integer | One-based page number. Default `1` when `view` is provided. |
| `pageSize` | integer | 1–50 items per page. Default `20` for summary and `5` for full. |
| `q` | string | Case-insensitive search in task title and description |
| `status` | enum | `todo` \| `in_progress` \| `in_review` \| `done` \| `cancelled` |
| `assignee` | string | Filter by assignee |
| `priority` | enum | `low` \| `medium` \| `high` \| `urgent` |
| `tag` | string | Filter by tag |
| `completedWithinDays` | number | Only return done/cancelled tasks completed within this many days. Default `14`. Set `0` for all. Ignored when `status` is explicitly `done` or `cancelled`. |



### Create Task

```
POST /api/v1/projects/:projectId/tasks
```

```json
{
  "title": "Implement login page",
  "description": "Build the login form",
  "status": "todo",
  "priority": "high",
  "assignee": "alice",
  "assigneeType": "human",
  "tags": ["frontend", "auth"],
  "requirementId": "uuid-of-requirement",
  "executionSliceId": "uuid-of-slice",
  "expectedAt": "2026-03-15"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | yes | 1–500 chars |
| `requirementId` | UUID | **yes** | Parent requirement |
| `executionSliceId` | UUID | no | Optional slice under the same requirement |
| `description` | string | no | |
| `status` | enum | no | Default: `todo` |
| `priority` | enum | no | Default: `medium` |
| `assignee` | string | no | |
| `assigneeType` | enum | no | `human` \| `agent` |
| `tags` | string[] | no | |
| `expectedAt` | date | no | |

### List Personal Tasks

```
GET /api/v1/personal/tasks?status=todo&priority=high&completedWithinDays=14
```

Returns tasks with `scope=personal` owned by the current actor by default. Optional `ownerId` and `ownerType` query params may be used by trusted clients to inspect another visible personal owner.

### Create Personal Task

```
POST /api/v1/personal/tasks
```

```json
{
  "title": "Follow up with Ada",
  "description": "Personal inbox item",
  "priority": "medium",
  "expectedAt": "2026-03-15"
}
```

Personal tasks do not accept `projectId`, `requirementId`, or `executionSliceId`.

`projectId` from URL path, not body. Response: `201`.

### Get Task Detail

```
GET /api/v1/tasks/:id
```

Returns task with comments, notes, dependencies, linked documents.

### Get Kanban Board

```
GET /api/v1/projects/:projectId/board?completedWithinDays=14
```

Tasks grouped by status columns. Done/cancelled columns are limited to tasks completed within the last 14 days by default. Set `completedWithinDays=0` to include all.

### Get Gantt Chart

```
GET /api/v1/projects/:projectId/gantt
```

Returns task timelines, dependencies, and requirement grouping:

```json
{
  "projectId": "uuid",
  "tasks": [
    {
      "id": "uuid", "title": "Login page", "status": "in_progress",
      "priority": "high", "assignee": "alice", "requirementId": "uuid",
      "createdAt": "2026-03-01T...", "expectedAt": "2026-03-15",
      "completedAt": null,
      "dependencies": [{ "dependsOnTaskId": "uuid", "type": "blocks" }]
    }
  ],
  "requirements": [{ "id": "uuid", "title": "Auth System", "taskCount": 5 }],
  "dateRange": { "start": "2026-03-01", "end": "2026-03-31" }
}
```

### Update Task

```
PATCH /api/v1/tasks/:id
```

All fields optional. Set `assignee`, `assigneeType`, `expectedAt` to `null` to clear. `requirementId` can be changed but not nullified.

### Change Task Status

```
PATCH /api/v1/tasks/:id/status
```

```json
{ "status": "in_progress", "reason": "Starting work" }
```

Cannot transition out of `cancelled`.

### Delete (Cancel) Task

```
DELETE /api/v1/tasks/:id
```

### Add Comment

```
POST /api/v1/tasks/:id/comments
```

```json
{ "content": "Looks good, moving to review." }
```

Response: `201`.

### Add Note

```
POST /api/v1/tasks/:id/notes
```

```json
{ "content": "Root cause: null pointer in auth middleware", "pinned": true }
```

Response: `201`.

### Add Dependency

```
POST /api/v1/tasks/:id/dependencies
```

```json
{ "dependsOnTaskId": "uuid-of-blocking-task", "type": "blocks" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `dependsOnTaskId` | UUID | yes | |
| `type` | enum | no | `blocks` (default) \| `related` |

Response: `201`.

CLI:

```bash
tw task dep list <task-id>
tw task dep add <task-id> <depends-on-task-id> --type blocks
```

### Remove Dependency

```
DELETE /api/v1/tasks/:id/dependencies/:depId
```

CLI:

```bash
tw task dep remove <task-id> <dependency-id>
```

### Batch Create Tasks

```
POST /api/v1/tasks/batch
```

```json
{
  "tasks": [
    { "projectId": "uuid", "requirementId": "uuid", "title": "Task 1", "priority": "high" },
    { "projectId": "uuid", "requirementId": "uuid", "title": "Task 2", "tags": ["backend"] }
  ]
}
```

Each task object follows the same schema as Create Task. 1–50 items. Atomic: all succeed or all fail (transaction).

Response: `201` — array of created tasks.

### Batch Update Tasks

```
PATCH /api/v1/tasks/batch
```

```json
{
  "updates": [
    { "id": "uuid", "status": "done", "reason": "Completed" },
    { "id": "uuid", "priority": "urgent", "assignee": "agent-1" }
  ]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID | yes | Task to update |
| `status` | enum | no | New status |
| `reason` | string | no | Reason for status change |
| `title` | string | no | |
| `description` | string | no | |
| `priority` | enum | no | |
| `assignee` | string \| null | no | |
| `tags` | string[] | no | |

1–50 items. Atomic. Cannot change status of `cancelled` tasks.

---

### Task Claims (Multi-Agent Coordination)

#### Claim Task

```
POST /api/v1/tasks/:id/claim
```

```json
{ "durationMinutes": 30 }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `durationMinutes` | integer | no | 1–1440, default 30 |

Response: `201` — claim object. `409` if already claimed by another agent.

#### Release Task

```
POST /api/v1/tasks/:id/release
```

```json
{ "reason": "Handing off to another agent" }
```

Only the claim holder can release. Auto-released when task moves to `done`/`cancelled`.

#### Heartbeat Claim

```
POST /api/v1/tasks/:id/heartbeat
```

```json
{ "extendMinutes": 30 }
```

Extends the claim lease. Call periodically for long-running tasks.

#### Get Task Claim

```
GET /api/v1/tasks/:id/claim
```

Returns current claim or `{ "claimed": false }`.

#### List Active Claims

```
GET /api/v1/claims?projectId=uuid&claimedBy=agent-id
```

Returns all active (non-expired) claims. Expired claims are auto-cleaned.

#### Batch Claim Tasks

```
POST /api/v1/claims/batch
```

```json
{ "taskIds": ["uuid1", "uuid2", "uuid3"], "durationMinutes": 30 }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `taskIds` | uuid[] | yes | 1–20 task IDs |
| `durationMinutes` | integer | no | 1–1440, default 30, applied to all |

**Atomic**: all tasks are claimed in a single transaction — no partial claims. If any tasks cannot be claimed, returns `409` listing ALL problematic tasks with reasons (not found / already done / held by another agent).

---

### Requirement Claims (Daemon Lanes)

Requirement claims are distributed leases used by daemon workers. They are separate from task claims: interactive agents usually claim tasks, while daemon workers claim one requirement lane and process its task roadmap.

#### Claim Requirement

```
POST /api/v1/requirements/:id/claim
```

```json
{
  "durationMinutes": 30,
  "daemonId": "uuid",
  "workerIndex": 0
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `durationMinutes` | integer | no | 1–1440, default 30 |
| `daemonId` | UUID | no | Owning daemon id |
| `workerIndex` | string \| number | no | Worker index inside the daemon process |

Response: `201` — requirement claim object. `409` if another holder has an active claim.

#### Release Requirement

```
POST /api/v1/requirements/:id/release
```

```json
{ "reason": "daemon worker exited" }
```

Only the claim holder can release. Requirements moving to `done`, `cancelled`, or `archived` auto-release active requirement claims.

#### Heartbeat Requirement Claim

```
POST /api/v1/requirements/:id/heartbeat
```

```json
{ "extendMinutes": 2 }
```

Extends the requirement lane lease. Daemon workers call this periodically while the spawned agent is running.

#### Get Requirement Claim

```
GET /api/v1/requirements/:id/claim
```

Returns current claim or `{ "claimed": false }`.

#### List Requirement Claims

```
GET /api/v1/requirement-claims?projectId=uuid&claimedBy=daemon-id
```

Returns all active (non-expired) requirement lane claims. Expired claims are
auto-cleaned.

## Requirements

### List Requirements

```
GET /api/v1/projects/:projectId/requirements?view=summary&page=1&pageSize=20&q=release&status=approved&priority=high&completedWithinDays=14
```

When `view` is provided, the response is a paginated envelope:
`{ items, total, page, pageSize, pageCount, view }`. `summary` returns scalar
requirement fields only; `full` includes tasks, dependencies, dependents, and
repositories. Explicit `full` requests default to five items per page and
never return the complete collection in one response. Omitting `view` preserves
the legacy full array response for API compatibility.

| Param | Type | Description |
|-------|------|-------------|
| `view` | enum | `summary` or `full` |
| `page` | integer | One-based page number. Default `1` when `view` is provided. |
| `pageSize` | integer | 1–50 items per page. Default `20` for summary and `5` for full. |
| `q` | string | Case-insensitive search in requirement title and description |
| `status` | enum | `draft` \| `approved` \| `in_progress` \| `in_review` \| `ready_to_merge` \| `done` \| `cancelled` \| `archived` |
| `completedWithinDays` | number | Only return done/cancelled/archived requirements completed within this many days. Default `14`. Set `0` for all. Ignored when `status` is explicitly a terminal status. |
| `priority` | enum | `low` \| `medium` \| `high` \| `critical` |

### Create Requirement

```
POST /api/v1/projects/:projectId/requirements
```

```json
{
  "title": "User authentication system",
  "description": "Support email/password and OAuth",
  "priority": "high",
  "modelTier": "standard",
  "tags": ["auth", "security"]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | yes | 1–500 chars |
| `description` | string | no | |
| `status` | enum | no | Default: `draft` |
| `priority` | enum | no | Default: `medium` |
| `modelTier` | enum | no | `fast` \| `standard` (default) \| `strong` |
| `tags` | string[] | no | |

Response: `201`.

### Get Requirement Detail

```
GET /api/v1/requirements/:id
```

Returns requirement with linked tasks and documents.

### Update Requirement

```
PATCH /api/v1/requirements/:id
```

All fields optional. `modelTier` controls daemon scheduling for this requirement lane and accepts `fast`, `standard`, or `strong`.

### Execution Slices

Execution slices split a requirement lane into ordered Codex spawn units. Daemons still claim the requirement lane, but if slices exist, `apply-requirement` returns the next executable slice and its tasks.

#### List Slices

```
GET /api/v1/requirements/:id/slices
```

Returns `{ "items": [...] }` ordered by `orderIndex`.

#### Create Slice

```
POST /api/v1/requirements/:id/slices
```

```json
{
  "title": "API routes",
  "description": "Implement REST endpoints for the requirement",
  "orderIndex": 1,
  "modelTier": "strong",
  "taskIds": ["uuid-task-1", "uuid-task-2"]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | yes | 1–500 chars |
| `description` | string | no | |
| `orderIndex` | integer | no | Defaults to next order |
| `modelTier` | enum | no | Defaults from requirement |
| `taskIds` | UUID[] | no | Assign existing requirement tasks to the slice |

#### Update Slice

```
PATCH /api/v1/execution-slices/:id
```

All fields optional: `title`, `description`, `orderIndex`, `modelTier`, `status`, `resultSummary`, `taskIds`.

#### Delete Slice

```
DELETE /api/v1/execution-slices/:id
```

Deleting a slice unassigns its tasks rather than deleting the tasks.

CLI:

```bash
tw req update <requirement-id> --model-tier strong
tw req slice list <requirement-id>
tw req slice create <requirement-id> --title "API routes" --model-tier strong --tasks <task-id-1,task-id-2>
tw req slice update <slice-id> --status done --summary "API routes completed"
tw req slice delete <slice-id>
```

### Delete (Cancel) Requirement

```
DELETE /api/v1/requirements/:id
```

### List Requirement Dependencies

```
GET /api/v1/requirements/:id/dependencies
```

Returns blockers and dependents for a requirement:

```json
{
  "dependencies": [
    {
      "id": "uuid",
      "requirementId": "downstream-uuid",
      "dependsOnRequirementId": "upstream-uuid",
      "type": "blocks",
      "dependsOn": { "id": "upstream-uuid", "title": "API foundation", "status": "in_progress" }
    }
  ],
  "dependents": [
    {
      "id": "uuid",
      "requirementId": "downstream-uuid",
      "dependsOnRequirementId": "current-uuid",
      "type": "blocks",
      "requirement": { "id": "downstream-uuid", "title": "Web UI", "status": "approved" }
    }
  ]
}
```

### Add Requirement Dependency

```
POST /api/v1/requirements/:id/dependencies
```

```json
{
  "dependsOnRequirementId": "uuid-of-upstream-requirement",
  "type": "blocks",
  "description": "Needs the API contract first"
}
```

Dependencies must stay inside the same project; self-dependencies and cycles are rejected. `blocks` dependencies gate daemon requirement-lane scheduling until the upstream requirement is `done` or `cancelled`; `related` links are informational.

CLI:

```bash
tw req dep list <requirement-id>
tw req dep add <requirement-id> <depends-on-requirement-id> --type blocks
```

### Remove Requirement Dependency

```
DELETE /api/v1/requirements/:id/dependencies/:depId
```

CLI:

```bash
tw req dep remove <requirement-id> <dependency-id>
```

### Link Document to Requirement

```
POST /api/v1/requirements/:id/document-links
```

```json
{ "documentId": "uuid", "linkType": "documents" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `documentId` | UUID | yes | |
| `linkType` | enum | no | `references` (default) \| `documents` \| `output` |

Response: `201`.

### Remove Document Link

```
DELETE /api/v1/requirements/:id/document-links/:linkId
```

### Get Requirement Burndown

```
GET /api/v1/requirements/:id/burndown
```

Returns burndown chart data for a requirement's tasks:

```json
{
  "requirementId": "uuid",
  "title": "User Auth",
  "totalTasks": 10,
  "completedTasks": 7,
  "startDate": "2026-03-01",
  "endDate": "2026-03-12",
  "dataPoints": [
    { "date": "2026-03-01", "remaining": 10, "completed": 0, "added": 10 },
    { "date": "2026-03-05", "remaining": 6, "completed": 4, "added": 0 }
  ],
  "idealLine": [
    { "date": "2026-03-01", "remaining": 10 },
    { "date": "2026-03-12", "remaining": 0 }
  ],
  "velocity": 1.2,
  "projectedCompletionDate": "2026-03-15"
}
```

### Get Requirement Heatmap

```
GET /api/v1/projects/:projectId/requirements/heatmap
```

Returns activity heatmap for all requirements in a project:

```json
{
  "projectId": "uuid",
  "items": [
    {
      "id": "uuid", "title": "User Auth", "status": "in_progress", "priority": "high",
      "totalTasks": 10, "completedTasks": 7, "overdueTasks": 1,
      "commentCount": 15, "documentLinkCount": 3, "activityCount": 25,
      "lastActivityAt": "2026-03-12T...", "daysSinceLastActivity": 0,
      "heatScore": 85
    }
  ],
  "hotspots": [...],
  "coldspots": [...]
}
```

### Batch Create Requirements

```
POST /api/v1/requirements/batch
```

```json
{
  "requirements": [
    { "projectId": "uuid", "title": "Auth system", "priority": "high" },
    { "projectId": "uuid", "title": "Data export", "tags": ["feature"] }
  ]
}
```

Each requirement follows the same schema as Create Requirement. 1–50 items. Atomic.

Response: `201` — array of created requirements.

---

## Repositories

Repositories are reusable instance catalog entries. Requirements link repositories to define their executable workspace. Task links are optional scope hints and never reduce the Requirement workspace. Catalog endpoints and authentication policies must not contain credentials.

### List and Search Repositories

```
GET /api/v1/repositories?q=task-weaver&provider=github&host=github.com&status=active&visibility=instance&tags=typescript,platform&sort=recently-used&page=1&pageSize=25
```

| Param | Type | Description |
|-------|------|-------------|
| `q` / `query` | string | Search canonical identity and metadata |
| `provider` | string | Provider adapter identifier |
| `host` | string | Normalized host |
| `status` | enum | `active` \| `archived` |
| `visibility` | enum | `instance` \| `restricted` \| `private` |
| `tags` | string | Comma-separated tags |
| `sort` | enum | `relevance` \| `recently-used` \| `usage` \| `name` \| `updated` |
| `page` / `pageSize` | integer | Page starts at 1; page size is 1–100 |

Returns `{ items, total, page, pageSize, pageCount }`. Each item includes derived usage and actor/node-scoped readiness without exposing credential bindings.

### Create Repository

```
POST /api/v1/repositories
```

```json
{
  "displayName": "Task Weaver",
  "provider": "github",
  "host": "github.com",
  "namespace": "openai",
  "name": "task-weaver",
  "webUrl": "https://github.com/openai/task-weaver",
  "httpsCloneUrl": "https://github.com/openai/task-weaver.git",
  "defaultBranch": "main",
  "tags": ["typescript"],
  "visibility": "instance",
  "authPolicy": {
    "allowedTransports": ["https"],
    "allowedOperations": ["read", "push", "forge"],
    "credentialProfileRef": "github-work",
    "revision": 1
  }
}
```

`host`, `namespace`, and `name` are required and normalize to a unique `canonicalKey`. Restricted/private entries require `ownerId` and `ownerType`. Endpoint fields reject user-info credentials, secret query parameters, and fragments. `authPolicy` contains references and constraints only, never secrets. Response: `201`.

### Get, Update, Archive, and Readiness

```
GET    /api/v1/repositories/:id?operation=read&transport=https&nodeId=node-id
PATCH  /api/v1/repositories/:id
DELETE /api/v1/repositories/:id
GET    /api/v1/repositories/:id/readiness?operation=push&transport=https&nodeId=node-id
```

Archive preserves historical usage and is blocked while active Requirement links depend on the repository. Readiness states are `available`, `needs_configuration`, `denied`, `unavailable`, or `unknown`; responses use reason codes and revisions instead of credential details.

### Requirement Workspace Repositories

```
GET    /api/v1/requirements/:id/repositories
POST   /api/v1/requirements/:id/repositories
DELETE /api/v1/requirements/:id/repositories/:repositoryId
```

```json
{
  "repositoryId": "uuid",
  "baseBranch": "main",
  "workingBranch": "req/auth"
}
```

Removal is blocked while Task links, delivery history, or an active slice manifest depends on the link.

Delivery control endpoints:

```
POST  /api/v1/requirement-repositories/:linkId/retry
PATCH /api/v1/requirement-repositories/:linkId/delivery
POST  /api/v1/requirement-repositories/:linkId/forge-sync
```

The PATCH endpoint is for trusted daemon delivery state. It accepts per-repository workspace, commit, push, pull-request, review, merge, failure, and attempt fields. Retrying resets only the failed link; successful sibling repositories remain intact. `forge-sync` accepts a normalized pull-request snapshot plus `idempotencyKey`, optional `expectedRevision`, `observedAt`, and daemon lease fences. It rejects stale writers, supersedes approvals after a changed head, and maps merged, closed, and reopened provider state to the local delivery lane.

### Task Repository Scope

```
GET    /api/v1/tasks/:id/repositories
POST   /api/v1/tasks/:id/repositories
DELETE /api/v1/tasks/:id/repositories/:repositoryId
```

```json
{
  "repositoryId": "uuid",
  "addToRequirement": true,
  "baseBranch": "main",
  "workingBranch": "req/auth"
}
```

The repository must already be in the Task's Requirement workspace unless `addToRequirement=true` explicitly expands that workspace first. An empty Task scope means the agent may use every repository in the Requirement workspace.

CLI equivalents:

```bash
tw repo list --provider github --sort recently-used
tw repo search "task weaver" --json
tw repo create --host github.com --namespace openai --name task-weaver --https-url https://github.com/openai/task-weaver.git
tw repo get <repository-id> --operation push
tw repo credential set github-work --kind git-helper --host github.com --transport https --operations read,push,forge
tw repo credential readiness <repository-id> --operation push
tw req repo add <requirement-id> <repository-id> --base-branch main
tw task repo add <task-id> <repository-id> --add-to-requirement
```

---

## Plans

Plans let agents validate or atomically apply a batch of requirements, tasks, execution slices, dependencies, document links, and task comments from one structured payload.

### Apply Plan

```
POST /api/v1/plans/apply
```

```json
{
  "dryRun": true,
  "plan": {
    "projectId": "uuid",
    "documents": [
      {
        "key": "auth-design",
        "title": "Auth Design",
        "content": "# Auth Design",
        "docType": "design"
      }
    ],
    "requirements": [
      {
        "key": "auth-api",
        "title": "Auth API",
        "status": "approved",
        "priority": "high",
        "modelTier": "strong",
        "documents": [{ "document": "auth-design", "type": "documents" }],
        "slices": [
          { "key": "auth-schema", "title": "Schema", "orderIndex": 0, "tasks": ["auth-db"] }
        ],
        "tasks": [
          {
            "key": "auth-db",
            "title": "Add auth tables",
            "priority": "high",
            "comments": ["Planning: database first."]
          }
        ]
      }
    ]
  }
}
```

Set `dryRun=true` to validate and preview without writing. Set `dryRun=false` or omit it to apply. The apply path is transactional: any validation, foreign-key, duplicate-key, dependency, or link failure rolls back the whole plan.

Plan objects use local `key` values for references inside the file. Add `existingId` to reuse an existing document, requirement, or task under a local key. Direct UUID references are accepted for existing external objects. The CLI also supports `contentFile` in document entries and expands it before calling the API:

```bash
tw plan validate --file plan.yaml
tw plan apply --file plan.yaml
tw plan apply --file plan.yaml --dry-run --json
```

Response: `200` for dry-run, `201` for apply.

```json
{
  "dryRun": true,
  "summary": {
    "requirements": { "create": 1, "reuse": 0 },
    "tasks": { "create": 1, "reuse": 0 },
    "slices": { "create": 1 },
    "documents": { "create": 1, "reuse": 0 },
    "requirementDependencies": 0,
    "taskDependencies": 0,
    "documentLinks": 0,
    "documentRequirementLinks": 1,
    "documentTaskLinks": 0,
    "taskComments": 1,
    "taskNotes": 0
  },
  "refs": {
    "requirements": [{ "key": "auth-api", "id": null, "existing": false, "title": "Auth API" }],
    "tasks": [{ "key": "auth-db", "id": null, "existing": false, "title": "Add auth tables" }],
    "slices": [{ "key": "auth-schema", "id": null, "existing": false, "title": "Schema" }],
    "documents": [{ "key": "auth-design", "id": null, "existing": false, "title": "Auth Design" }]
  },
  "warnings": []
}
```
---

## Documents

### List Documents

```
GET /api/v1/documents?projectId=uuid&includeGlobal=true&includePersonal=false&view=summary&page=1&pageSize=20&query=architecture
```

| Param | Type | Description |
|-------|------|-------------|
| `projectId` | UUID | Filter by project |
| `includeGlobal` | boolean | Include global docs (default: `true`) |
| `includePersonal` | boolean | Include personal docs for the authenticated actor (default: `false`) |
| `personalOwnerId` | string | Optional personal owner override |
| `personalOwnerType` | enum | `human` \| `agent` |
| `docType` | enum | `requirement` \| `design` \| `meeting` \| `guide` \| `reference` \| `skill` \| `other` |
| `tag` | string | Filter by exact tag |
| `query` | string | Case-insensitive search in title and summary |
| `view` | enum | Omit for the legacy full array; `summary` returns catalog fields; `full` returns content |
| `page` | integer | One-based page number when `view` is provided (default: `1`) |
| `pageSize` | integer | Items per page, 1–50 (summary default: `20`, full default: `5`) |

When `view` is provided, the response is a paginated envelope. Summary rows omit
Markdown `content`, `generationPrompt`, and ownership metadata; use
`GET /api/v1/documents/:id` for one complete document.

### Create Document

```
POST /api/v1/documents
```

```json
{
  "title": "Architecture Overview",
  "content": "# Architecture\n\nSee also [[API Design]] and [[Database Schema]].",
  "projectId": "uuid-or-omit-for-global",
  "tags": ["architecture"],
  "summary": "High-level system architecture covering API, database, and frontend layers.",
  "keywords": ["architecture", "API", "database"],
  "docType": "design",
  "language": "en"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | yes | 1–500 chars |
| `content` | string | yes | Markdown with `[[wiki-links]]`. Auto-normalized. |
| `projectId` | UUID | no | Omit for global |
| `tags` | string[] | no | |
| `summary` | string | no | Brief summary (1000 chars max). Helps AI judge relevance. |
| `keywords` | string[] | no | Key topics for search/classification |
| `docType` | enum | no | Default: `other` |
| `language` | string | no | Default: `en` |
| `generatedBy` | string | no | AI agent ID |
| `generationPrompt` | string | no | Prompt used to generate |
| `confidence` | number | no | AI confidence 0-1 |
| `needsReview` | boolean | no | Default: `false` |

`readingTimeMin` is auto-computed from content length. Response: `201`.

### Get Document Detail

```
GET /api/v1/documents/:id
```

Returns document with outgoing/incoming document links, linked tasks, and linked requirements.

CLI:

```bash
tw doc links <document-id>
```

### Update Document

```
PATCH /api/v1/documents/:id
```

All fields optional. Set `projectId` to `null` to make global. Set `summary`, `generatedBy`, `generationPrompt`, `confidence` to `null` to clear. Updating `content` auto-recomputes `readingTimeMin` and re-syncs wiki-links with context. AI metadata fields: `generatedBy`, `generationPrompt`, `confidence`, `needsReview`.

### Delete Document (Hard Delete)

```
DELETE /api/v1/documents/:id
```

### Get Backlinks

```
GET /api/v1/documents/:id/backlinks
```

CLI:

```bash
tw doc backlinks <document-id>
```

### Link to Another Document

```
POST /api/v1/documents/:id/links
```

```json
{ "targetDocId": "uuid", "linkType": "reference", "context": "Related decision" }
```

CLI:

```bash
tw doc link <document-id> <target-document-id> --type reference --context "Related decision"
tw doc unlink <document-id> <link-id>
```

### Link Document to Task

```
POST /api/v1/documents/:id/task-links
```

```json
{ "taskId": "uuid", "linkType": "references" }
```

CLI:

```bash
tw doc link-task <document-id> <task-id> --type references
tw doc unlink-task <document-id> <link-id>
```

### Link Document to Requirement

```
POST /api/v1/requirements/:id/document-links
DELETE /api/v1/requirements/:id/document-links/:linkId
```

```json
{ "documentId": "uuid", "linkType": "documents" }
```

CLI:

```bash
tw doc link-req <document-id> <requirement-id> --type documents
tw doc unlink-req <requirement-id> <link-id>
```

### Remove Links

```
DELETE /api/v1/documents/:id/links/:linkId
DELETE /api/v1/documents/:id/task-links/:linkId
```

---

## Document Versions

### List Document Versions

```
GET /api/v1/documents/:id/versions?limit=50&offset=0
```

| Param | Type | Description |
|-------|------|-------------|
| `limit` | integer | Default: 50 |
| `offset` | integer | Default: 0 |

Returns version history (version number, change description, actor, timestamp).

CLI:

```bash
tw doc versions <document-id>
```

### Get Document Version

```
GET /api/v1/documents/:id/versions/:version
```

Returns a specific version snapshot (title, content, metadata at that version).

CLI:

```bash
tw doc version <document-id> <version>
```

### Compare Document Versions

```
GET /api/v1/documents/:id/versions/compare?from=1&to=3
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | integer | yes | Start version number |
| `to` | integer | yes | End version number |

Returns diff between two versions.

CLI:

```bash
tw doc compare <document-id> --from 1 --to 3
```

### Revert Document

```
POST /api/v1/documents/:id/revert
```

```json
{ "version": 2, "changeDescription": "Reverting to version 2" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `version` | integer | yes | Version number to revert to |
| `changeDescription` | string | no | Reason for reverting |

Restores the document to the specified version's content, creating a new version entry.

CLI:

```bash
tw doc revert <document-id> <version> --change-description "Reverting to version 2"
```

---

## Recommendations

### Get Document Recommendations

```
GET /api/v1/documents/:id/recommendations?limit=10&types=document,task,requirement&projectId=...&threshold=0.01
```

| Param | Type | Description |
|-------|------|-------------|
| `limit` | integer | Max results (default: 10) |
| `types` | string | Comma-separated: `document`, `task`, `requirement` (default: all) |
| `projectId` | UUID | Limit to project scope |
| `threshold` | number | Minimum score 0–1 (default: 0.01) |

Returns recommended links for a document. Uses full-text search for document similarity and keyword matching for tasks/requirements. Excludes already-linked entities.

```json
{
  "entityId": "doc-uuid",
  "entityType": "document",
  "recommendations": [
    { "id": "uuid", "type": "document", "title": "...", "score": 0.85, "reason": "Similar content based on text analysis" },
    { "id": "uuid", "type": "task", "title": "...", "score": 0.6, "reason": "Matches 3 keyword(s) from document" }
  ]
}
```

### Get Task Recommendations

```
GET /api/v1/tasks/:id/recommendations?limit=10&types=document,task,requirement&threshold=0.01
```

| Param | Type | Description |
|-------|------|-------------|
| `limit` | integer | Max results (default: 10) |
| `types` | string | Comma-separated: `document`, `task`, `requirement` (default: all) |
| `threshold` | number | Minimum score 0–1 (default: 0.01) |

Returns recommended links for a task. Uses full-text search for document similarity and keyword matching for tasks/requirements. Excludes already-linked and dependent entities.

---

## Search

Search endpoints return a canonical JSON envelope:

```json
{ "items": [] }
```

`GET /api/v1/search/all` also includes `tasks`, `requirements`, and `documents` grouped arrays for compatibility with older consumers.

### Search Documents

```
GET /api/v1/search/documents?query=authentication&mode=hybrid&projectId=uuid&limit=20
```

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `query` | string | yes | Min 1 char |
| `mode` | enum | no | `keyword` (default) \| `semantic` \| `hybrid` \| `fulltext` |
| `projectId` | UUID | no | |
| `includeGlobal` | boolean | no | Default: `true` |
| `limit` | integer | no | 1–50, default 20 |
| `keywordWeight` | number | no | 0–1 (hybrid mode only, default 0.3) |
| `semanticWeight` | number | no | 0–1 (hybrid mode only, default 0.7) |

Returns `{ "items": [document, ...] }`.

### Full-Text Search

```
GET /api/v1/search/documents/fulltext?query=authentication&projectId=uuid
```

Returns `{ "items": [document, ...] }`.

### Search Tasks

```
GET /api/v1/search/tasks?q=login&projectId=uuid
```

For personal task search, omit `projectId` or pass `scope=personal`. The current actor is used as the personal owner by default.

Returns `{ "items": [task, ...] }`.

### Search Requirements

```
GET /api/v1/search/requirements?q=login&projectId=uuid
```

Returns `{ "items": [requirement, ...] }`.

### Combined Search

```
GET /api/v1/search/all?q=authentication&projectId=uuid&limit=20
```

Returns typed rows in `items` plus legacy grouped arrays:

```json
{
  "items": [{ "type": "task", "id": "uuid", "title": "..." }],
  "tasks": [],
  "requirements": [],
  "documents": []
}
```

Pass `includePersonal=true` to include personal documents in combined document results when owner fields match.

### Resolve Wiki-Link Titles

```
POST /api/v1/search/resolve-titles
```

```json
{ "titles": ["API Design", "Database Schema"] }
```

---

## Activity Log

### List Activity Log

```
GET /api/v1/activity?entityType=task&entityId=uuid&actorId=my-agent&actorType=agent&since=2026-03-01&until=2026-03-12&limit=50&offset=0
```

| Param | Type | Description |
|-------|------|-------------|
| `entityType` | enum | `project` \| `task` \| `document` \| `requirement` \| `repository` \| `schedule` and supported agent entities |
| `entityId` | UUID | Filter by entity |
| `actorId` | string | Filter by actor |
| `actorType` | enum | `human` \| `agent` |
| `action` | string | Filter by action (e.g., `created`, `updated`, `status_changed`) |
| `since` | ISO 8601 | Start of date range |
| `until` | ISO 8601 | End of date range |
| `limit` | integer | Default: 50 |
| `offset` | integer | Default: 0 |

### Export Activity Log

```
GET /api/v1/activity/export?projectId=uuid&format=json&since=2026-03-01
```

| Param | Type | Description |
|-------|------|-------------|
| `projectId` | UUID | Filter by project |
| `entityType` | enum | Filter by entity type |
| `actorId` | string | Filter by actor |
| `actorType` | enum | `human` \| `agent` |
| `action` | string | Filter by action |
| `since` | ISO 8601 | Start of date range |
| `until` | ISO 8601 | End of date range |
| `format` | enum | `json` (default) \| `csv` |

Returns all matching activity log entries (no pagination). CSV format includes header row.

---

## API Keys

### List API Keys

```http
GET /api/v1/api-keys
GET /api/v1/api-keys?actorId=<owned-agent-uuid>
```

Returns only authorized subject metadata, display prefix, grants and lifecycle
information. No hash/verifier or raw Key appears. Omitting `actorId` selects self;
a supplied subject must be self or an authorized managed Agent.

### Create API Key

```http
POST /api/v1/api-keys
```

```json
{
  "name": "project-reader",
  "grants": [{
    "scope": "project",
    "projectId": "00000000-0000-4000-8000-000000000001",
    "permissions": ["resource.read"]
  }],
  "expiresAt": "2027-01-01T00:00:00.000Z"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | Display name |
| `actorId` | UUID | no | Self or authorized managed Agent; defaults to self |
| `grants` | array | yes | Explicit finite scope/action ceiling; must intersect issuer and subject authority |
| `expiresAt` | ISO 8601 or null | yes | Explicit deadline or explicit no time-based expiry |

Response `201` includes `rawKey` once. Global, personal, project and instance
targets are distinct. Personal targets name a human owner. No legacy `permissions`
object, wildcard grants, omitted expiry or arbitrary subject override is accepted.

### Rotate API Key

```http
POST /api/v1/api-keys/:id/rotate?actorId=<authorized-subject-uuid>
```

```json
{}
```

The body is strictly empty. Rotation preserves actor, name, grants/ancestry and
expiry while narrowing to current authority. Changes require explicit new
issuance. The previous Key is revoked with audit history retained; dependent
credentials are invalidated. The new `rawKey` is returned once.

### Revoke API Key

```http
DELETE /api/v1/api-keys/:id?actorId=<authorized-subject-uuid>
```

Omit `actorId` for self. Revocation retains a tombstone and immediately invalidates
the Key and its dependent authority, including explicitly non-expiring Keys.

---

## Webhooks

### Create Webhook

```
POST /api/v1/webhooks
```

```json
{
  "url": "https://my-agent.com/task-events",
  "events": ["task.created", "task.status_changed", "document.updated"],
  "projectId": "00000000-0000-4000-8000-000000000001",
  "description": "Notify agent on task changes"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `url` | URL | yes | Endpoint to receive POST requests |
| `events` | string[] | yes | Event types to subscribe to (min 1) |
| `projectId` | UUID | no | Project scope; omission requests a separately authorized global binding |
| `secret` | string | no | HMAC secret (min 16 chars, auto-generated if omitted) |
| `active` | boolean | no | Default: `true` |
| `description` | string | no | Max 500 chars |

Response: `201` includes the signing secret once. Reads omit secrets. Authorized
`PATCH` with `rotateSecret: true` rotates it and invalidates the previous binding
generation; the new secret is returned once. Outbound events and retries recheck
actor, credential ceiling, current scope and configuration generation. Global
hooks cannot forward personal/project events merely because their owner is an
instance administrator. Legacy unbound hooks stay closed.

**Supported events:** `task.created`, `task.updated`, `task.status_changed`, `task.commented`, `task.deleted`, `requirement.created`, `requirement.updated`, `requirement.deleted`, `document.created`, `document.updated`, `document.deleted`, `document.linked`.

### List Webhooks

```
GET /api/v1/webhooks?projectId=uuid&active=true
```

| Param | Type | Description |
|-------|------|-------------|
| `projectId` | UUID | Filter by project |
| `active` | boolean | Filter by active status |

### Get Webhook

```
GET /api/v1/webhooks/:id
```

### Update Webhook

```
PATCH /api/v1/webhooks/:id
```

```json
{ "events": ["task.status_changed"], "active": false }
```

### Delete Webhook

```
DELETE /api/v1/webhooks/:id
```

### List Delivery Attempts

```
GET /api/v1/webhooks/:id/deliveries?status=failed&limit=20
```

| Param | Type | Description |
|-------|------|-------------|
| `status` | enum | `pending` \| `success` \| `failed` |
| `limit` | integer | Default: 20 |
| `offset` | integer | Default: 0 |

### Send Test Event

```
POST /api/v1/webhooks/:id/test
```

Sends an explicitly authorized `webhook.test` connectivity event. Returns safe
delivery metadata without payload, remote response or signing secret. Managers may
retry a failed delivery with `POST /api/v1/webhooks/:id/deliveries/:deliveryId/retry`;
retry reauthorizes the current binding and event resources. No autonomous retry
worker is enabled.

### Webhook Payload Format

When an event matches a webhook subscription, Task Weaver sends:

```http
POST https://your-url.com/webhook
Content-Type: application/json
X-TaskWeaver-Event: task.status_changed
X-TaskWeaver-Signature: sha256=<hmac-hex>
X-TaskWeaver-Delivery: <delivery-uuid>
```

```json
{
  "event": "task.status_changed",
  "timestamp": "2026-03-12T10:00:00.000Z",
  "data": {
    "type": "task_status_changed",
    "projectId": "uuid",
    "taskId": "uuid",
    "from": "todo",
    "to": "in_progress"
  }
}
```

**Verifying signatures:** Compute `HMAC-SHA256(payload_body, secret)` and compare with the hex value after `sha256=` in the `X-TaskWeaver-Signature` header.

---

## Realtime Events (SSE)

```
GET /api/v1/events
```

Server-Sent Events stream. Event types:

| Event | Payload Fields |
|-------|---------------|
| `task.created` / `task.updated` / `task.deleted` | `task`, `projectId` |
| `task.status_changed` | `task`, `projectId`, `fromStatus`, `toStatus` |
| `task.comment_added` / `task.note_added` | `taskId`, `comment`/`note` |
| `document.created` / `document.updated` / `document.deleted` | `document`, `projectId` |
| `requirement.created` / `requirement.updated` / `requirement.deleted` | `requirement`, `projectId` |
| `connected` | `message` |
| `heartbeat` | `timestamp` |

---

## GraphQL

```
POST /api/v1/graphql
GET  /api/v1/graphql   (GraphiQL playground, non-production only)
```

A single endpoint that supports nested queries across all entities. Complements REST for complex reads that would otherwise require multiple requests.

### Schema highlights

- **Root queries**: `project`, `projects`, `task`, `tasks`, `requirement`, `requirements`, `document`, `documents`, `searchDocuments`
- **Nested traversal**: `Project → requirements → tasks → comments/notes/dependencies`, `Document → linkedTasks → task → requirement`
- **Inline stats**: `project { stats { totalTasks byStatus byPriority } }`
- **Recommendations**: `document { recommendations(limit: 5) { type title score reason } }`
- **Filtering**: Most list fields accept filter args (e.g. `tasks(status: in_progress, assignee: "agent-1")`)

### Example query

```graphql
query GetProjectOverview($id: ID!) {
  project(id: $id) {
    name
    status
    stats {
      totalTasks
      byStatus { status count }
    }
    requirements(status: approved) {
      title
      tasks {
        title
        status
        assignee
      }
    }
    documents(docType: design) {
      title
      summary
    }
  }
}
```

No authentication changes — uses the same `Authorization: Bearer` header as REST.

---

## Skill Package Registry

Skill packages preserve a directory-shaped skill as server-owned package/version/file records. Readable text files are indexed as `docType=skill` documents, while package/file metadata keeps the distribution boundary intact.

### Register Package

```
POST /api/v1/context/packages/register
```

```json
{
  "name": "task-weaver",
  "projectId": "uuid-or-omit-for-global",
  "version": "1.0.0",
  "sourceType": "directory",
  "entryPath": "SKILL.md",
  "summary": "Core platform knowledge",
  "tags": ["task-weaver"],
  "files": [
    {
      "path": "SKILL.md",
      "contentBase64": "IyBTa2lsbAo=",
      "contentType": "text/markdown",
      "isReadableText": true,
      "isExecutable": false
    }
  ]
}
```

The API requires the `entryPath` file to be present, rejects path traversal, computes hashes server-side, stores files through the configured package storage adapter, and creates indexed skill documents for readable text files.

### List / Inspect Packages

```
GET /api/v1/context/packages?projectId=uuid&includeGlobal=true
GET /api/v1/context/packages/:packageId
```

### List Files

```
GET /api/v1/context/packages/:packageId/files?version=1.0.0
```

Returns per-file metadata including path, kind, hash, size, text readability, executable flag, storage object id, and indexed document id.

### Read Text File

```
GET /api/v1/context/packages/:packageId/read?path=SKILL.md&version=1.0.0
```

Returns the readable text content for `SKILL.md` or another indexed/readable package file. Binary files return `409`.

### Download / Install Payload

```
GET /api/v1/context/packages/:packageId/download?version=1.0.0
```

Returns a manifest-backed payload with file metadata, executable flags, hashes, and `contentBase64` for each file. The CLI verifies every hash before materializing the package locally.

### Lifecycle Controls

```
PATCH /api/v1/context/packages/:packageId
PATCH /api/v1/context/packages/:packageId/versions/:version
```

Package metadata updates accept `name`, `description`, `status`, `summary`, `keywords`, and `tags`. Version updates accept `status` (`active`, `deprecated`, `archived`, `deleted`). Lifecycle changes are activity logged as `skill_package` events.

### Storage Health / Reindex

```
GET /api/v1/context/packages/:packageId/health?version=1.0.0
POST /api/v1/context/packages/:packageId/reindex
```

Health verifies each package file's storage object, size, and sha256 hash. Reindex rebuilds indexed `docType=skill` documents from readable package files after storage verification; missing, binary, backend-mismatched, or hash-mismatched files are skipped and reported.

CLI equivalents:

```bash
tw context package register ./skills/my-skill --project $PROJECT_ID
tw context package list --project $PROJECT_ID
tw context package files $PACKAGE_ID
tw context package read $PACKAGE_ID SKILL.md
tw context package install $PACKAGE_ID --print-path
tw context package health $PACKAGE_ID
tw context package reindex $PACKAGE_ID
tw context package update $PACKAGE_ID --status archived
tw context package version-status $PACKAGE_ID 1.0.0 deprecated
```

---

## MCP Tool Registry

Task Weaver acts as an MCP host/registry. External MCP servers are registered, their tools indexed, and agents can discover and call them through a unified API.

### Visibility model

| Server type | Transport | Scope field | Visible to |
|-------------|-----------|-------------|------------|
| Global | `sse` / `streamable-http` | `projectId = null` | Authenticated actors with global resource grants |
| Project | any | `projectId = uuid` | Current project permission and credential ceiling |
| Local-shared | `stdio` | `scope=local` | Verified registration actor/credential plus `nodeId`, additionally constrained by resource scope |
| Private | `stdio` | `scope=private` (default) | Verified registration actor/credential plus `clientId`, additionally constrained by resource scope |

### Register MCP Server

```
POST /api/v1/mcp/servers
```

```json
{
  "name": "filesystem",
  "projectId": "uuid-or-omit-for-global",
  "transport": "streamable-http",
  "config": { "url": "https://mcp.internal/sse" },
  "tags": ["files"],
  "active": true
}
```

For stdio servers (client-hosted), also supply `clientId`, `nodeId`, `scope`, and `ttl`:

```json
{
  "name": "local-fs",
  "transport": "stdio",
  "config": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
  "projectId": "uuid-or-omit-for-global",
  "clientId": "cli-uuid",
  "nodeId": "node-uuid",
  "scope": "local",
  "localScopeConsent": true,
  "ttl": 60
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | 1–255 chars, unique |
| `projectId` | UUID | no | Scope server/tools to a project; omit or null for global |
| `transport` | enum | yes | `stdio` \| `sse` \| `streamable-http` |
| `config` | object | yes | `{command, args?, env?}` for stdio; `{url, headers?}` for http |
| `clientId` | string | yes (stdio) | Process-unique ID |
| `nodeId` | string | no | Machine-unique ID (required for `scope=local`) |
| `scope` | enum | no | `private` (default) \| `local` — stdio only |
| `localScopeConsent` | boolean | no | Required as `true` when registering or updating a stdio server to `scope=local` |
| `ttl` | integer | no | Heartbeat TTL in seconds (5–3600, default 60) |
| `tags` | string[] | no | |
| `active` | boolean | no | Default: `true` |

Response: `201`.

### List / Get Servers

```
GET /api/v1/mcp/servers?active=true&tags=files&projectId=uuid&includeGlobal=true
GET /api/v1/mcp/servers/:id
```

### Update Server

```
PATCH /api/v1/mcp/servers/:id
```

All fields optional, same schema as register.

### Delete Server

```
DELETE /api/v1/mcp/servers/:id
```

### Sync Tools from Server

```
POST /api/v1/mcp/servers/:id/sync
```

Connects to the server, lists its tools, and upserts them into the registry. Returns `{ items, count }`.

### Heartbeat (stdio servers)

```
POST /api/v1/mcp/servers/:id/heartbeat
```

Extend the TTL so the server stays active. Call every `ttl/3` seconds. Supply `clientId` in header, query, or body:

```
X-Client-Id: cli-uuid
```

or

```json
{ "clientId": "cli-uuid" }
```

Returns `{ success: true, expiresAt }`.

### Upload Tool Schemas (stdio servers)

```
POST /api/v1/mcp/servers/:id/upload-tools
```

```json
{ "tools": [{ "name": "read_file", "description": "...", "inputSchema": { ... } }] }
```

Used by `tw mcp register-local` to push tool schemas without the server-side connecting via pool.

---

### Search Tools

```
GET /api/v1/mcp/tools/search?intent=read+file&projectId=uuid&includeGlobal=true&limit=10
```

| Param | Type | Description |
|-------|------|-------------|
| `intent` | string | Natural-language description of what you need (required) |
| `projectId` | UUID | Include tools scoped to this project |
| `includeGlobal` | boolean | Include global tools with project-scoped results (default: `true`) |
| `clientId` | string | Your process ID — a discovery constraint; verified registration binding is still required. Also accepted via `X-Client-Id` header. |
| `nodeId` | string | Your machine ID — a discovery constraint; verified registration binding is still required. Also accepted via `X-Node-Id` header. |
| `serverId` | UUID | Filter to a specific server |
| `tags` | string | Comma-separated tag filter |
| `limit` | integer | 1–20, default 10 |

Returns tools across all three visibility tiers in a single call.

### Get Tool Detail

```
GET /api/v1/mcp/tools/:id
```

Returns tool metadata and `inputSchema`.

### Call Tool

```
POST /api/v1/mcp/tools/:id/call
```

```json
{ "arguments": { "path": "/tmp/foo.txt" } }
```

The API proxies the call to the registered server via the connection pool. The call is logged with actor identity, duration, and result status.

Returns the raw MCP tool result. On error, returns `502` with error message.

---

## Review Policies and Structured Review Runs

Review policy resolves in this order: Requirement override, project default, then the backward-compatible built-in policy. Policies define named checks, AI review, minimum human approvals, reviewer/merger separation of duty, allowed merge modes, base branch, retry bounds, and whether a reasoned human override is allowed.

```
GET /api/v1/projects/:projectId/review-policy
PUT /api/v1/projects/:projectId/review-policy
GET /api/v1/requirements/:requirementId/review-policy
PUT /api/v1/requirements/:requirementId/review-policy
```

Example policy body:

```json
{
  "requiredChecks": ["pnpm typecheck", "pnpm test"],
  "requireAiReview": true,
  "minimumHumanApprovals": 1,
  "requireIndependentReviewer": true,
  "requireIndependentMerger": true,
  "allowedMergeModes": ["provider", "manual"],
  "defaultMergeMode": "provider",
  "baseBranch": "main",
  "retryPolicy": {
    "maxAttempts": 3,
    "initialBackoffSeconds": 30,
    "maxBackoffSeconds": 900
  },
  "allowManualOverride": false,
  "overrideRequiresReason": true
}
```

Structured review attempts are commit-fenced. Starting a newer head supersedes the previous run; checks and findings are idempotently upserted, decisions retain actor and daemon identity, and evaluation ignores decisions for stale commits.

```
POST /api/v1/requirements/:requirementId/review-runs
GET  /api/v1/requirements/:requirementId/review-runs
GET  /api/v1/review-runs/:id
PUT  /api/v1/review-runs/:id/checks
PUT  /api/v1/review-runs/:id/findings
POST /api/v1/review-runs/:id/decisions
POST /api/v1/review-runs/:id/evaluate
```

Daemon-owned mutations include `daemonId` and `leaseGeneration`. A human decision requires a human actor. A manual override additionally requires policy authorization and, by default, an audit reason. Evaluation writes a task comment as a human-readable projection; the structured run remains authoritative.

## Daemons

### List Online Daemons

```
GET /api/v1/daemons
```

Returns online/non-offline daemon rows enriched with `workerStates`. Each active worker state may include the current requirement, execution slice, selected model tier/model, active task, roadmap, requirement claim heartbeat/expiry, branch name, and worktree path.

### Daemon Production SLOs

```
GET /api/v1/daemons/slo?windowHours=24
```

Returns the rolling acquisition latency, heartbeat gap, completion, retry recovery, stranded-lane, review duration, merge latency, and recovery-time objectives. Each metric includes its target, sample count, release-blocking policy, status (`pass`, `breach`, or `no_data`), and runbook anchor. The response also includes active warning/critical alerts and an aggregate `releaseStatus`. `windowHours` accepts 1–720 and defaults to 24.

### Register Daemon

```
POST /api/v1/daemons/register
```

```json
{
  "id": "uuid",
  "name": "daemon-hostname",
  "capabilities": ["codex", "agy", "model-tier:fast", "model-tier:standard"]
}
```

Returns the daemon row plus negotiated config (`polling` or `sse`, interval, backoff).

### Daemon Heartbeat

```
POST /api/v1/daemons/:id/heartbeat
```

Updates daemon liveness. Requirement-lane claim heartbeats are separate and use `POST /api/v1/requirements/:id/heartbeat`.

### Update Daemon Status

```
POST /api/v1/daemons/:id/status
```

```json
{
  "status": "busy",
  "activeTaskIds": ["uuid"],
  "activeWorkerStates": [
    {
      "index": 0,
      "status": "running",
      "requirementId": "uuid",
      "requirementTitle": "User authentication",
      "executionSliceId": "uuid",
      "executionSliceTitle": "API routes",
      "modelTier": "strong",
      "model": "gpt-5.5",
      "taskId": "uuid",
      "taskTitle": "Implement login",
      "branchName": "req/auth",
      "worktreePath": "/Users/me/.task-weaver/worktrees/project/req-auth",
      "startedAt": "2026-06-27T10:00:00.000Z",
      "updatedAt": "2026-06-27T10:01:00.000Z"
    }
  ]
}
```

`activeWorkerStates` powers the Web Daemons page.

### Apply Requirement Lane

```
POST /api/v1/daemons/:id/apply-requirement
```

```json
{
  "projectId": "uuid",
  "workerIndex": 0,
  "modelTiers": ["fast", "standard", "strong"],
  "includeDiagnostics": true
}
```

Returns:

```json
{
  "requirement": { "id": "uuid", "title": "..." },
  "executionSlice": { "id": "uuid", "title": "API routes", "modelTier": "strong" },
  "task": { "id": "uuid", "title": "..." },
  "tasks": [{ "id": "uuid", "title": "...", "status": "in_progress" }],
  "repositories": [
    {
      "link": { "id": "uuid", "baseBranch": "main", "workingBranch": "req/auth", "deliveryStatus": "pending" },
      "repository": { "id": "uuid", "canonicalKey": "github.com/openai/task-weaver", "provider": "github" }
    }
  ],
  "executorTool": "codex",
  "eligibility": {
    "candidateCount": 12,
    "examinedCount": 12,
    "runnableCount": 2,
    "selectedCount": 1,
    "truncated": false,
    "skipCounts": {
      "status": 1,
      "dependency": 2,
      "claim": 1,
      "slice_order": 3,
      "capability": 2,
      "model_tier": 1,
      "retry_time": 0,
      "policy": 0
    },
    "samples": []
  }
}
```

The repository array is the frozen Requirement workspace for this lane. Eligibility diagnostics are bounded to 200 examined tasks and use normalized skip reasons. The daemon CLI requests diagnostics and only logs an idle summary when it changes. Set `includeDiagnostics` to `false` to omit them. If no work is available, the lane fields are empty and the response still includes diagnostics when requested.

CLI daemon model mapping:

```bash
tw daemon start --tools codex \
  --model fast:gpt-5.4-mini \
  --model standard:gpt-5.5 \
  --model strong:gpt-5.5 \
  --think fast:low \
  --think standard:medium \
  --think strong:high \
  --prompt-file ~/.config/tw/worker-extra.md
```

`--think <tier:effort>` maps Task Weaver model tiers to Codex `model_reasoning_effort` values. Supported efforts are `minimal`, `low`, `medium`, `high`, and `xhigh`. Non-Codex tools ignore this mapping.

`--prompt <text>` and `--prompt-file <path>` append local-only extra instructions to each spawned worker prompt.

CLI daemon review:

```bash
tw daemon review --project <project-id> --base 0.3.3 \
  --check "pnpm typecheck" \
  --check "pnpm test" \
  --prompt-file ~/.config/tw/review-extra.md
```

### Apply Review Lane

```
POST /api/v1/daemons/:id/apply-review
```

```json
{
  "projectId": "uuid",
  "workerIndex": 0
}
```

Returns:

```json
{
  "requirement": { "id": "uuid", "title": "...", "status": "in_review" },
  "tasks": [{ "id": "uuid", "title": "...", "status": "done" }],
  "executionSlice": { "id": "uuid", "title": "API routes" },
  "repositories": [{ "link": { "id": "uuid" }, "repository": { "id": "uuid", "canonicalKey": "github.com/openai/task-weaver" } }]
}
```

If no review work is available, returns `{ "requirement": null, "tasks": [], "executionSlice": null, "repositories": [] }`.

The review daemon calls `apply-review` to claim one `in_review` requirement at a time, syncs the requirement branch with `origin/<base>`, runs configured checks and optional AI review, and moves passing branches to `ready_to_merge`. Conflicts, failed checks, or review findings create a new `todo` follow-up task and move the requirement back to `in_progress`.

CLI daemon merge:

```bash
tw daemon merge --project <project-id> --base 0.3.3
```

### Apply Merge Lane

```
POST /api/v1/daemons/:id/apply-merge
```

```json
{
  "projectId": "uuid",
  "workerIndex": 0
}
```

Returns:

```json
{
  "requirement": { "id": "uuid", "title": "...", "status": "ready_to_merge" },
  "tasks": [{ "id": "uuid", "title": "...", "status": "done" }],
  "executionSlice": { "id": "uuid", "title": "API routes" },
  "repositories": [{ "link": { "id": "uuid" }, "repository": { "id": "uuid", "canonicalKey": "github.com/openai/task-weaver" } }]
}
```

If no merge work is available, returns `{ "requirement": null, "tasks": [], "executionSlice": null, "repositories": [] }`.

The merge daemon calls `apply-merge` to claim one `ready_to_merge` requirement at a time, merges `origin/<requirement-branch>` into the base branch from a detached merge worktree, pushes `HEAD:<base>`, and marks the requirement `done`. Final merge conflicts create a new `todo` follow-up task and move the requirement back to `in_progress`; infrastructure failures such as fetch or push errors are recorded and left in `ready_to_merge` for retry.

### Apply Task (Compatibility)

```
POST /api/v1/daemons/:id/apply-task
```

Legacy task-level daemon pickup. It now excludes tasks whose requirement already has an active requirement claim.

### Daemon SSE Events

```
GET /api/v1/daemons/events
```

Enabled when `TW_DAEMON_MODE=sse`. Emits task and requirement events that should wake idle daemon workers.

---

## Health Check

```
GET /health
```

Note: at `/health`, not under `/api/v1`.

## Agent token usage

Usage REST endpoints require a validated API key. All queries require `projectId`;
optional filters are `requirementId`, `taskId`, `since` (inclusive process start),
`until` (exclusive), `phase`, `completeness`, `limit` and `offset`.

- `GET /api/v1/agent-usage/runs`: paginated whole-process summaries.
- `GET /api/v1/agent-usage/runs/:processId?projectId=...`: scoped process details.
- `GET /api/v1/agent-usage/summary`: totals and complete/partial/unknown coverage;
  ignores pagination, returns nullable decimal-string sums and per-counter report
  counts. Known unregistered Ti attempts reduce coverage across the entire selected
  project/requirement/task scope because their process timestamps are unavailable.
- `POST /api/v1/agent-usage/runs`: daemon snapshots with `processId`, `daemonId`,
  `projectId`, `requirementId`, `agent`, `phase`, `startedAt`, `endedAt`, `outcome`,
  `revision` and `summary`. Initial registration requires an active daemon lane.
- `POST /api/v1/ti/runs/:runId/usage`: actual Ti snapshots with `processId`,
  `workerId`, `attempt`, `startedAt`, `endedAt`, `outcome`, `revision` and `summary`.
  Requires assigned-agent or creator identity and an active worker lease for initial
  registration. Task/project attribution is derived from the Ti run.
- `POST /api/v1/ti/runs/:runId/usage/:processId/finish`: local runner finalization
  with terminal `outcome` and `endedAt`, preserving latest reported counters.

`summary` contains nullable `inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`; `cacheSemantics` (`included`, `additional`, `unknown`);
`provider`, `model` (`multiple`/`unknown` allowed); and `completeness`
(`complete`, `partial`, `unknown`). Unknown has no counters; complete requires input
and output counters. Failed/cancelled/running processes with counters are partial.
Snapshot revisions replace rather than add; changed attribution, decreasing counters,
conflicting replays and terminal restarts are rejected. No model-call records,
raw usage events, payloads or monetary fields are accepted.
