# Task Weaver

Human-AI collaborative project management tool — humans and AI agents work together as equal participants.

## Project Overview

Task Weaver is a project management platform where both humans (via Web UI) and AI agents (via the `tw` CLI / REST API) can manage projects, requirements, tasks, kanban boards, and a knowledge base with bidirectional linking and hybrid search (keyword + vector).

- Design documents: `docs/design.md` (English), `docs/design.zh-CN.md` (Simplified Chinese)

## Tech Stack

- **Monorepo**: Turborepo + pnpm
- **Backend**: Hono (TypeScript)
- **Database**: PostgreSQL + pgvector + Drizzle ORM
- **Frontend API**: tRPC v11
- **General API**: REST (Hono routes)
- **AI Interface**: `tw` CLI (wraps REST) + autonomous task daemon (`tw daemon`)
- **MCP Tool Registry**: hosts and proxies external MCP servers so agents can discover/call their tools (@modelcontextprotocol/sdk as client)
- **Frontend**: Next.js 16 (App Router) + shadcn/ui + Tailwind CSS
- **Validation**: Zod (shared across tRPC/REST/CLI)
- **Document Editing**: Markdown (CodeMirror + react-markdown + Mermaid)

## Project Structure

```
task-weaver/
├── apps/
│   ├── web/              # Next.js frontend
│   ├── api/              # Hono API server (tRPC + REST + daemon/MCP-registry routes)
│   └── cli/              # `tw` CLI for humans and AI agents (wraps REST)
├── packages/
│   ├── core/             # Business logic, Zod schemas, type definitions
│   ├── db/               # Drizzle schema, migrations, database client
│   └── realtime/         # Realtime event types and pub/sub
├── skills/               # AI agent skills (SKILL.md format)
└── docs/                 # Documentation
```

## AI Agent Access

AI agents can interact with Task Weaver through these channels:

- **`tw` CLI** (`apps/cli/`): The primary interface for AI agents — invoke via the Bash tool. Wraps the REST API and shares its data/auth. Add `--json` to any command for machine-readable output.
- **REST API** (`apps/api/`): HTTP/JSON at `/api/v1/`. Authentication uses a revocable browser session or a subject-bound scoped API key (`Authorization: Bearer <api-key>`). Actor identity comes from the verified credential; `X-Actor-Id` / `X-Actor-Type` headers are not trusted.
- **Skills** (`skills/`): Standard `SKILL.md` format skill that teaches AI agents how to use the platform.

### Autonomous Task Daemon

`tw daemon start` runs a long-lived local runner that auto-fetches and auto-executes tasks:

1. **Register** with the API (`POST /api/v1/daemons/register`), advertising detected local AI CLI tools (`codex`, `claude`, `agy`, `aider`, `cursor`) as capabilities, and negotiates a config (polling vs SSE).
2. **Acquire work** via polling (`POST /api/v1/daemons/{id}/apply-task`, with exponential backoff) or SSE push (`/api/v1/daemons/events`, auto-falling back to polling on disconnect). A heartbeat is sent every 30s.
3. **Execute** by spawning the chosen AI CLI tool with a generated prompt that instructs it to claim the task, do the work via `tw` commands, set status to `done`/`in_review`, and release the claim. The daemon runs one task at a time and returns to idle on completion.

Daemon-facing routes live in `apps/api/src/routes/daemons.ts`; the runner in `apps/cli/src/commands/daemon.ts`.

### MCP Tool Registry

Task Weaver also acts as an MCP host/registry: external MCP servers are registered, their tools synced and indexed, and agents can discover and invoke them through the platform.

- CLI: `tw mcp search <intent>`, `tw mcp tools`, `tw mcp call <toolId>`, `tw mcp servers`, `tw mcp sync <serverId>`, `tw mcp register-local` (host a local stdio MCP server via heartbeats).
- REST: `/api/v1/mcp/*` (see `apps/api/src/routes/mcp.ts`); logic in `packages/core/src/services/mcp-registry.ts` and connection pooling in `apps/api/src/mcp-pool.ts`.

### Skills

The `skills/task-weaver/` directory follows the standard Agent Skills format (`SKILL.md`), compatible with Codex, Codex.ai, and other skill-aware AI platforms:

```
skills/task-weaver/
├── SKILL.md              # Main entry: overview, data model, auth, conventions, quick start
├── rest-api-reference.md # Complete REST API endpoint reference
└── workflows.md          # Multi-step workflow guides (sprint planning, etc.)
```

`SKILL.md` contains core platform knowledge (data model, authentication, conventions) and points to reference files for detailed API docs and workflows. Codex auto-discovers skills when installed; other platforms can upload via Skills API.

## Code Conventions

- **All code and comments MUST be written in English.** No exceptions — variable names, function names, type definitions, comments, error messages, log messages, commit messages, and documentation within code files must all use English.
- Keep English documentation canonical and maintain requested translations in separate language-suffixed files. Keep code samples and code comments in English in every version.
- Use TypeScript strict mode across all packages
- Shared Zod schemas in `@task-weaver/core` — all interfaces (tRPC, REST, CLI) must use the same schemas
- Use Drizzle ORM for all database operations — no raw SQL unless absolutely necessary
- Prefer `uuid` for primary keys
- Use `timestamp with timezone` for all time fields

## Requirements

Requirements belong to a project (required). **Tasks must belong to a requirement** — every task has a required `requirementId` linking it to a requirement under the same project. Requirements can be bidirectionally linked with documents via `document_requirement_links`. Requirement statuses: `draft`, `approved`, `in_progress`, `done`, `cancelled` (`cancelled` is terminal).

## Task Status

Task status transitions are flexible — any status can jump to any other status freely, except `cancelled` which is a terminal state. Available statuses: `todo`, `in_progress`, `in_review`, `done`, `cancelled`.

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Start all services in parallel
pnpm build            # Build all packages
pnpm lint             # Lint all packages
pnpm typecheck        # Type check all packages
```

## Development and Delivery

- GitHub `limmytian/task-weaver` is the canonical product source repository.
- Develop the next patch release directly on `0.3.4`, based on the latest
  canonical `0.3.3` code. Push each completed requirement to the remote `0.3.4`
  branch. Do not merge to `main` until the owner authorizes the version release
  merge.
- Every commit must include a DCO signoff (`git commit -s`).
- Keep local environment configuration ignored. Never commit credentials,
  private infrastructure configuration, or private repository history.
- Internal planning and environment-specific runbooks belong in Task Weaver
  project documents; secret values belong in deployment Secret facilities.
- Source development does not authorize artifact publication or production
  deployment. Existing public release tags and signatures remain immutable.
