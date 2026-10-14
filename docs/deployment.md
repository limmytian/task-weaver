# Docker Compose Deployment

The default Compose file runs the released 0.3.7 API and Web images published
at GHCR. Both references are pinned to the immutable multi-platform OCI index
digests from the release. PostgreSQL is provided by the operator through
`DATABASE_URL`; the production Compose file contains no database service.
For a disposable local trial that includes PostgreSQL/pgvector, see the
[local trial guide](local-quickstart.md). Workspace package names and versions do
not imply npm publication.

For a verified newer release, set `TW_API_IMAGE` and `TW_WEB_IMAGE` together to
its OCI digest references. See [CE Install, Upgrade, and Recovery](ce-upgrades.md)
for the Kubernetes manifests, backup rehearsal, and rollback procedure.

## Database compatibility

Provide a dedicated PostgreSQL database reachable from the Compose network. The
browser never receives the connection string. The tested baseline is PostgreSQL
16.15 with pgvector 0.8.6 and pg_trgm 1.6. Other PostgreSQL major versions and
older extension versions are not certified.

Required capabilities are `vector` with HNSW indexes and cosine operators,
`pg_trgm`, and PostgreSQL full-text search. Installing extensions may require
administrator or provider assistance. The application account must be able to
run the bundled schema, table, index, function, and trigger migrations. Never
commit credentials; percent encode reserved URL characters in passwords.

## Start

Copy the example without putting real credentials in a tracked file. Set the
database URL and uncomment/replace the authentication placeholders in `.env`.
Use different random values for `TW_AUTH_SECRET` and
`TW_AUTH_BOOTSTRAP_SECRET`; generate each with `openssl rand -hex 32`. API and
Web must use the same authentication values. Replace the placeholder database
URL with an endpoint that containers can resolve and reach. A container's
`localhost` refers to that container, not the Docker host.

```sh
cp .env.example .env
# Edit .env locally: set DATABASE_URL, TW_AUTH_SECRET,
# TW_AUTH_BASE_URL, TW_AUTH_TRUSTED_ORIGINS, and TW_AUTH_BOOTSTRAP_SECRET.
docker compose config
docker compose up -d --wait
docker compose ps
curl --fail http://localhost:3001/health
```

The migration service applies all bundled migrations and search setup before the
API and Web start. API startup repeats migrations idempotently and imports the
bundled Task Weaver skill package. No sample project data is inserted. The Web
UI is at `http://localhost:3000`; API health is at
`http://localhost:3001/health`. `API_PORT` and `WEB_PORT` may change these
loopback host ports.

On a fresh instance, open `/login`, choose first-administrator setup, enter the
bootstrap secret, and create the first account. Remove
`TW_AUTH_BOOTSTRAP_SECRET` from the API and Web service environment after setup
and recreate those services. There is no public signup. `MIGRATION_DATABASE_URL`
may select a separate initialization account. API startup still runs migrations,
so a strictly DML-only runtime account is not a supported deployment mode.

## Source development

Use Node.js from `.node-version` and pnpm 9.15.0:

```sh
cp .env.example .env
# Configure DATABASE_URL and the authentication settings before initialization.
pnpm install --frozen-lockfile
pnpm exec dotenv -- pnpm --filter @task-weaver/db db:migrate
pnpm exec dotenv -- pnpm --filter @task-weaver/db db:setup-search
pnpm dev
```

Source development uses the same external database requirements. The public
Dockerfiles remain available for independent source builds, but the default
Compose example deliberately uses the published digest-pinned images.

## Security and persistence

Keep the default loopback bindings and use TLS outside loopback. The 0.3.7 images
include authenticated accounts, sessions, scoped Keys, and live resource
authorization. Missing `TW_AUTH_SECRET` or `TW_AUTH_BASE_URL` fails closed; there
is no anonymous fallback.

API and Web need the same database, authentication Secret/base URL and exact
trusted origins. Browser calls use one origin and signed CSRF cookies/tokens.
Set these through the service's Secret/environment facility. The Compose file
passes these values explicitly to both API and Web; editing a host `.env` only
has an effect for values the Compose file references.
See [authenticated access](authenticated-access.md) for bootstrap, closed account
provisioning, scoped CLI login, revocation and the offline upgrade boundary.

The `attachment-data` volume stores attachment originals shared by API and Web.
See [attachment documents](attachment-documents.md) for limits, persistent
volume topology and coordinated backup/restore. Preserve both attachment and
Skill volumes when recreating containers.

The `skill-data` volume stores skill package objects. Preserve it together with
database backups. The database operator owns database security patches,
availability, backups, and restoration. Stop application writes before a
coordinated backup and verify restoration into a separate database and storage
directory. Keep backups outside the repository with appropriate access controls.
Do not use `docker compose down --volumes` when skill objects must be retained.

## Upgrade and recovery

Before changing image digests, record the current digests and retain a verified
database and skill-object backup. Test the new version against a restored copy in
a separate Compose project. Forward migrations run automatically; switching an
image revision does not undo them.

If an upgrade fails, stop API and Web, restore the pre-upgrade database and the
matching skill objects into a separate recovery environment, and restart the
recorded previous images. Reverting images alone does not revert database
migrations. Preserve the failed environment until the incident is understood.

## Release scope

The 0.3.7 release publishes signed, multi-platform API and Web image indexes.
This deployment example continues to require an operator-provided PostgreSQL
database. For a local trial, the separate Compose file supplies a
PostgreSQL/pgvector container and binds application ports to loopback only.
