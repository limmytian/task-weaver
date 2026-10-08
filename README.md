# Task Weaver

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/brand/templates/readme-dark.svg">
  <img src="design/brand/templates/readme-light.svg" alt="Task Weaver — A shared workspace for humans and AI agents" width="960" height="240">
</picture>

Task Weaver is a human–AI collaborative project management tool. Humans use the
Web UI; agents use the `tw` CLI, REST API, or GraphQL API. Both work with the same
projects, requirements, tasks, documents, and activity history.

The application includes kanban boards, a linked Markdown knowledge base,
keyword and vector search, agent task execution, and an MCP tool registry.

## What you can do

- Plan projects with requirements, tasks, dependencies, and kanban boards.
- Keep decisions and knowledge in linked Markdown documents with keyword and vector search.
- Collaborate with AI agents through the same tasks, activity history, CLI, and APIs.
- Discover external tools through the MCP registry and manage reusable agent skills.
- Control access with authenticated accounts, project memberships, and scoped credentials.

## Quick start

Run from source with Node.js and pnpm (versions are pinned in `.node-version`
and `package.json`). Provision PostgreSQL 16 with pgvector and pg_trgm, then:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# Configure DATABASE_URL and authentication settings in your local .env.
pnpm exec dotenv -- pnpm --filter @task-weaver/db db:migrate
pnpm exec dotenv -- pnpm --filter @task-weaver/db db:setup-search
pnpm dev
```

Open <http://localhost:3000/login> and initialize the first administrator with
your configured one-time bootstrap secret. Remove that secret after setup.
The API listens on <http://localhost:3001>; its health endpoint is `/health`.
See [account setup and authenticated access](docs/authenticated-access.md) for
configuration, inviting users, creating scoped Keys, and connecting agents.
Use HTTPS outside loopback and keep credentials out of source control.

For containers, follow [installation and deployment](docs/deployment.md) and
select a matching, verified API/Web image pair from
[GitHub Releases](https://github.com/limmytian/task-weaver/releases).
The checked-in Compose defaults use older published images; follow the deployment
guide for their supported configuration. Source and published images may differ.
Back up data and read the [upgrade guide](docs/ce-upgrades.md) before upgrading.

## Development

The source checkout includes the Web UI, API, CLI, shared packages, migrations,
skills, and documentation. Development reads your local `.env`; the API imports
the bundled Task Weaver skill package at startup.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

See [Contributing](CONTRIBUTING.md) for development and contribution guidelines.

## CLI

Run the CLI directly from the checkout:

```bash
pnpm --filter @task-weaver/cli exec tsx src/index.ts --help
pnpm --filter @task-weaver/cli exec tsx src/index.ts auth login
pnpm --filter @task-weaver/cli exec tsx src/index.ts project list --json
```

For regular use, add an alias pointing to the checkout's installed `tsx`:

```bash
alias tw='/path/to/task-weaver/node_modules/.bin/tsx /path/to/task-weaver/apps/cli/src/index.ts'
tw auth login
tw auth whoami --json
tw auth status
```

The CLI defaults to `http://localhost:3001`. `TW_API_URL` and `TW_API_KEY` may
override its saved configuration. Project tasks require a requirement; claim a
task before starting work and release the claim when finished. Add `--json` for
machine-readable output. npm package publication is not supported yet; use the
checkout instructions above.

## Documentation and community

- [Architecture](docs/design.md) ([简体中文](docs/design.zh-CN.md))
- [Authenticated accounts, CLI access and offline upgrade](docs/authenticated-access.md)
- [Deployment and rollback](docs/deployment.md)
- [Release history](docs/releases/README.md) and [release gates](docs/release-gates.md)
- [CE packages](docs/ce-packages.md) and [release operations](docs/release-operations.md)
- [Install, upgrade, and recovery](docs/ce-upgrades.md)
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
