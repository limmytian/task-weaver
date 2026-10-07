# CE Install, Upgrade, and Recovery

## Supported path

The initial supported window is the current minor and one preceding minor.
The `0.2.x` release line accepts a direct upgrade from the published `0.1.x`
line. Test each patch and migration sequence against a restored copy before
production rollout. PostgreSQL 16 with the documented pgvector and pg_trgm
extensions is the deployment baseline. Older database versions, skipped
minor versions, and database downgrade are not certified.

API and Web images must be selected as a matching pair from one release. Use
the exact OCI digests in that release's `api-image.digest` and
`web-image.digest` assets. Verify signatures, SBOMs, and checksums before
putting a new pair into service.

## 0.3.2 to authenticated 0.3.3 source rehearsal

The authenticated source includes a disposable regression pinned to public
`v0.3.2` commit `556ba6373bb1f4a128455f008d07d53725495c20` and its exact 48 SQL
migration hashes, followed by current forward migrations. This evidence does not
publish a new image pair or broaden the existing binary support window. Run
`pnpm test:auth-postgres` after building to exercise the full isolated fixture.

Follow [authenticated access](authenticated-access.md#offline-upgrade-and-recovery)
for the explicit cutoff/inventory/manifest dry run and acknowledged offline apply.
Migrations alone grant no ownership. Legacy labels remain historical; unmapped
content is restricted and unbound Keys are revoked/reissued rather than promoted.
Old daemon/task/requirement/Ti/delegation authority is fenced. New registration,
explicit configuration revalidation and fresh leases are required. Receipt replay
must not disturb work authorized after cutover.

Back up the complete database with extension definitions and matching skill
objects, verify restoration, and stop writes throughout maintenance. A schema-only
dump may omit extensions. Rollback restores the recorded pre-upgrade database and
storage with old binaries; it discards subsequent writes. Do not connect an old
binary to the migrated live schema. Dirty worktree recovery preserves changes;
conflicted/missing worktrees require explicit quarantine/review and current fences.

## Docker Compose fresh install

Provide an external PostgreSQL database and a local, untracked `.env` with
`DATABASE_URL`. The default Compose file retains the previously published,
digest-pinned image pair. For a new release, set both `TW_API_IMAGE` and
`TW_WEB_IMAGE` to its verified digest references.

```sh
docker compose config --quiet
docker compose up -d --wait
docker compose ps
curl --fail http://127.0.0.1:3001/health
```

The one-shot migration container must complete before the API starts. Keep
ports bound to loopback unless an authenticated TLS gateway is in place.

## Docker Compose upgrade rehearsal

1. Record the old image digests and Compose configuration outside the source
   tree. Stop API and Web writes with `docker compose stop web api`.
2. Make a consistent PostgreSQL custom-format dump with `pg_dump -Fc` and a
   matching copy or snapshot of the `skill-data` volume. Keep credentials and
   backup files outside the repository. Verify that the dump can be restored
   into a separate database and that skill objects are present.
3. Restore both backups into a separate test environment. Set the new API and
   Web digests there, run `docker compose config --quiet`, then start with
   `docker compose up -d --wait`. The migration container applies forward
   migrations and search setup before application readiness.
4. Run health and project/requirement/task/document smoke checks. Compare
   migration journal entries and a selected data count before and after the
   upgrade. Repeat the same steps in production only after the rehearsal
   passes and a rollback window has been reserved.

For recovery after a failed migration, stop writes and restore the pre-upgrade
database **and** the matching skill volume into a new recovery environment.
Start the recorded old image digests against that restored state. Switching
images alone cannot reverse schema or data migrations. Preserve the failed
environment for diagnosis and never run old binaries against a migrated live
database without an explicit compatibility test.

## Kubernetes install and upgrade

Render the manifests with immutable image references:

```sh
TW_RELEASE_VERSION=0.2.0 \
TW_API_IMAGE="$API_IMAGE_DIGEST" \
TW_WEB_IMAGE="$WEB_IMAGE_DIGEST" \
pnpm deploy:render-kubernetes
```

Set `API_IMAGE_DIGEST` and `WEB_IMAGE_DIGEST` to the verified full image
references from the release assets before rendering.
Create a `task-weaver-database` Secret with key `url` in the target namespace
using the cluster's normal secret manager. Do not put its value in a manifest
or shell history. Apply `base.yaml`, then `migration.yaml`; wait for the
versioned migration Job to complete before applying `apps.yaml`:

```sh
kubectl apply -f release-artifacts/kubernetes/base.yaml
kubectl apply -f release-artifacts/kubernetes/migration.yaml
kubectl -n task-weaver wait --for=condition=complete job/task-weaver-migrate-v0-2-0 --timeout=10m
kubectl apply -f release-artifacts/kubernetes/apps.yaml
kubectl -n task-weaver rollout status deployment/task-weaver-api
kubectl -n task-weaver rollout status deployment/task-weaver-web
```

Before a Kubernetes upgrade, snapshot the database and skill-data PVC with
the storage provider's supported procedure, then restore both into a staging
namespace. Render and apply the new version there first. The application
Deployments use one replica and an API `Recreate` strategy because the skill
volume is `ReadWriteOnce`. If the cluster lacks suitable persistent storage,
provide a compatible storage class before installation.

## Evidence

Record source tag and commit, both image digests, migration journal before
and after, database/PVC backup IDs, configuration validation output, health
checks, smoke results, and the recovery rehearsal result. Remove disposable
test environments only after evidence has been retained without credentials.
