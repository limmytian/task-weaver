# Task Weaver

Task Weaver is a human–AI collaborative project management tool. Humans use the
Web UI; agents use the `tw` CLI, REST API, or GraphQL API. Both work with the same
projects, requirements, tasks, documents, and activity history.

The application includes kanban boards, a linked Markdown knowledge base,
keyword and vector search, agent task execution, and an MCP tool registry.

## v0.3.1 multi-architecture images and version information

Version 0.3.1 adds API and Web OCI indexes for Linux AMD64 and ARM64. Each
platform is built on a native runner, separately verified, and independently
installed before publication. The index and platform manifests are signed;
platform SBOMs and source evidence remain separately identified.

Settings > Version shows the Web build and offers a manual check of the latest
official stable release. It links to downloads and upgrade guidance. It does not
install updates. `TW_VERSION_CHECK_ENABLED=false` disables outbound checks on
the API or Web service. REST clients can read `GET /api/v1/version` or request
`POST /api/v1/version/check` for the API build.

To use this release, verify its signatures and checksums and download
`api-image.digest` and `web-image.digest` from
[the release](https://github.com/limmytian/task-weaver/releases/tag/v0.3.1).
The Compose defaults still select the historical ARM64 v0.1.0 images; configure
the new index digests and your host platform explicitly:

```bash
export TW_API_IMAGE="$(cat api-image.digest)"
export TW_WEB_IMAGE="$(cat web-image.digest)"
export TW_IMAGE_PLATFORM=linux/amd64 # Use linux/arm64 on ARM64 hosts.
docker compose config
docker compose up -d --wait
```

Back up application data first and follow [the upgrade guide](docs/ce-upgrades.md).
The five npm packages remain release attachment tarballs, not npmjs publications.
Existing v0.3.0 artifacts remain immutable and ARM64 only.

## v0.3.0 unified application

Version 0.3.0 retires the separate CE/Pro application architecture. Task Weaver
is one application; the isolated plugin ecosystem is deferred planning.
The in-process module SDK, injectable license/authorization ports, Web extension
registry and extension SQL migration runner are removed. This is a breaking
change for consumers of those 0.2.x interfaces. The shared business packages,
Core migration history and first-party Partners Gateway remain intact.
See [the architecture transition](docs/architecture-transition.md).

Five compiled npm tarballs (contracts, db, realtime, core and partners-gateway)
are GitHub Release attachments; this release does not publish to npmjs. API and
Web images, signatures, SBOMs and corresponding-source evidence retain the
Linux ARM64 release scope. Gateway idempotency and lease-recovery fixes from
0.2.1 remain included. The default Gateway worker prints the task prompt;
autonomous model execution still requires additional integration.

Compose defaults retain the original v0.1.0 pinned images. To select 0.3.0,
verify the release signatures and checksums, download `api-image.digest` and
`web-image.digest` from that release, and configure:

```bash
export TW_API_IMAGE="$(cat api-image.digest)"
export TW_WEB_IMAGE="$(cat web-image.digest)"
docker compose config
docker compose up -d --wait
```

Back up the database and skill data before an upgrade and follow
[the upgrade and recovery guide](docs/ce-upgrades.md). Existing 0.2.x signed
artifacts remain immutable. Core database migration files are unchanged.

## Quick start

The v0.1.0 Compose example runs the published API and Web containers on Linux
ARM64. It does not include PostgreSQL: provision a PostgreSQL 16 database with
pgvector and pg_trgm, then set a connection URL that is reachable from Docker.

```bash
cp .env.example .env
# Set DATABASE_URL in .env before starting the application.
docker compose config
docker compose up -d --wait
curl --fail http://localhost:3001/health
```

Open <http://localhost:3000>. The API health endpoint is
<http://localhost:3001/health>. Both API and Web require the database connection.
PostgreSQL is maintained by your database operator. See
[deployment](docs/deployment.md) for compatibility, persistence, backup, and
upgrade guidance.

The published images selected by the Compose defaults predate 0.3.3 authentication
and remain intended for a trusted local environment. The `0.3.3` source requires
revocable sessions or subject-bound scoped Keys and live resource permissions;
Actor headers cannot supply identity. API and Web need matching authentication
Secret/base URL/origin configuration. See [authenticated access](docs/authenticated-access.md)
for bootstrap, account/Key management and explicit legacy ownership migration.
Use TLS outside loopback. Source acceptance does not update published images or
authorize production rollout; see [deployment](docs/deployment.md).

The historical v0.1.0 images selected by Compose defaults support Linux ARM64 only. v0.1.0 does
not publish AMD64 images, floating tags, signatures, npm packages, a first-party
PostgreSQL image, or complete upgrade/downgrade certification.

## Development

```bash
pnpm install --frozen-lockfile
# Provision PostgreSQL with vector and pg_trgm.
# Set DATABASE_URL and the authentication settings from .env.example locally.
pnpm exec dotenv -- pnpm --filter @task-weaver/db db:migrate
pnpm exec dotenv -- pnpm --filter @task-weaver/db db:setup-search
pnpm dev
```

Development reads the local `.env`. Use the example configuration and never
commit credentials. The application starts with an empty project list and imports
the bundled Task Weaver skill package at API startup.

Container distribution is limited to API and Web. Database operation, patching,
and backups belong to the database operator. The source checkout includes the
CLI, shared packages, migrations, skills, and documentation.

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
- [Release gates](docs/release-gates.md)
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

## Development architecture

Task Weaver 0.3 consolidates the application and removes the retired in-process
SDK. Version 0.3.1 adds multi-architecture distribution and manual version checks. See [the transition](docs/architecture-transition.md)
and [deferred plugin planning](docs/plugin-roadmap.md).
