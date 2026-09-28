# Task Weaver

Task Weaver is a human–AI collaborative project management tool. Humans use the
Web UI; agents use the `tw` CLI, REST API, or GraphQL API. Both work with the same
projects, requirements, tasks, documents, and activity history.

The application includes kanban boards, a linked Markdown knowledge base,
keyword and vector search, agent task execution, and an MCP tool registry.

## Quick start

This checkout is source-only. Published containers, container deployment examples
and npm packages are not provided yet. Use Node.js from `.node-version` and
pnpm 9.15.0, and provision an external PostgreSQL database.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
# Set DATABASE_URL in .env before initialization.
pnpm exec dotenv -- pnpm --filter @task-weaver/db db:migrate
pnpm exec dotenv -- pnpm --filter @task-weaver/db db:setup-search
pnpm dev
```

Open <http://localhost:3000>. The API health endpoint is
<http://localhost:3001/health>. Both API and Web require the database connection.
PostgreSQL is maintained by your database operator. See
[deployment](docs/deployment.md) for database capabilities and source-development
limitations.

Development is intended for a trusted local workspace.
The Web UI and API allow unauthenticated access; an API key identifies an actor
but does not protect the entire application. Do not expose these services to the
Internet without an authenticated gateway and a separate deployment review.
See [deployment](docs/deployment.md) for persistence, backups, and rollback.

## Development

```bash
pnpm install --frozen-lockfile
# Provision PostgreSQL with vector and pg_trgm; set DATABASE_URL in .env.
pnpm exec dotenv -- pnpm --filter @task-weaver/db db:migrate
pnpm exec dotenv -- pnpm --filter @task-weaver/db db:setup-search
pnpm dev
```

Development reads the local `.env`. Use the example configuration and never
commit credentials. The application starts with an empty project list and imports
the bundled Task Weaver skill package at API startup.

Future container distribution is limited to API and Web. Database operation,
patching, and backups belong to the database operator. The source checkout
includes the CLI, shared packages, migrations, skills, and documentation.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm release:verify
```

## CLI

Run the CLI directly from the checkout:

```bash
pnpm --filter @task-weaver/cli exec tsx src/index.ts --help
pnpm --filter @task-weaver/cli exec tsx src/index.ts project list --json
```

For regular use, add an alias pointing to the checkout's installed `tsx`:

```bash
alias tw='/path/to/task-weaver/node_modules/.bin/tsx /path/to/task-weaver/apps/cli/src/index.ts'
tw auth setup
tw auth status
```

The CLI defaults to `http://localhost:3001`. `TW_API_URL` and `TW_API_KEY` may
override its saved configuration. Project tasks require a requirement; claim a
task before starting work and release the claim when finished. Add `--json` for
machine-readable output. npm package publication is not supported yet; use the
checkout instructions above.

## Documentation and community

- [Architecture](docs/design.md)
- [Deployment and rollback](docs/deployment.md)
- [Release gates](docs/release-gates.md)
- [REST API reference](skills/task-weaver/rest-api-reference.md)
- [Agent workflows](skills/task-weaver/workflows.md)
- [Daemon pipeline runbook](docs/daemon-pipeline-runbook.md)
- [Contributing](CONTRIBUTING.md), [governance](GOVERNANCE.md), and [support](SUPPORT.md)
- [Security reporting](SECURITY.md) and [code of conduct](CODE_OF_CONDUCT.md)

## License

Copyright 2026 limmytian. Task Weaver is licensed under [Apache-2.0](LICENSE).
Third-party components retain their licenses; see [NOTICE](NOTICE),
[third-party notices](THIRD_PARTY_NOTICES.md), and `THIRD_PARTY_LICENSES/`.
Project branding is covered by the [trademark policy](TRADEMARKS.md).
