# Source Development and Database Requirements

This checkout provides source, not a published container deployment. Container
deployment examples and registry images will be delivered separately after their
release checks. All workspace packages remain source-only; no npm publication is
implied by their package names or versions.

## Database

Provide `DATABASE_URL` in your ignored local `.env` using a dedicated PostgreSQL
database reachable from both API and Web. The browser never receives the
connection string. The tested baseline is PostgreSQL 16; other major versions
and the oldest compatible server/extension versions are not certified.

Required capabilities are `vector` (pgvector with HNSW and cosine operators),
`pg_trgm` and PostgreSQL full-text search. Installing extensions may require
administrator/provider assistance. Allow schema/table/index/function/trigger
migrations in the dedicated database. Reserved characters in connection-string
passwords must be percent encoded. Never commit credentials.

## Start from Source

Install Node.js from `.node-version` and pnpm 9.15.0:

```sh
cp .env.example .env
# Configure DATABASE_URL before initialization.
pnpm install --frozen-lockfile
pnpm exec dotenv -- pnpm --filter @task-weaver/db db:migrate
pnpm exec dotenv -- pnpm --filter @task-weaver/db db:setup-search
pnpm dev
```

API startup repeats migrations idempotently and synchronizes the bundled skills.
This is not a strictly DML-only runtime-account deployment. No sample projects
are inserted. The Web UI is at `http://localhost:3000`, and API health is at
`http://localhost:3001/health`.

## Security and Persistence

Use a trusted local workspace and restrict network access. The Web UI and API
accept unauthenticated access; API keys identify actors but are not global
access control. An authenticated gateway, TLS and a separate authorization review
are necessary before exposing an installation outside a trusted network.

The database operator owns database patching, availability and backups.
`SKILL_PACKAGE_STORAGE_DIR` selects persistent skill-object storage; preserve
that directory together with database backups. Stop application writes before
coordinated backups and verify restoration into a separate database/storage
directory. Keep backups outside the repository with appropriate access controls.

Before changing source versions, retain the previous source revision and a
verified database/skill-object backup. Forward migrations run automatically;
switching source revisions does not undo them. Recovery may require restoring
the matching database and skill objects before restarting the previous revision.
Full upgrade/rollback certification and production hardening are not established
by source-development instructions.
