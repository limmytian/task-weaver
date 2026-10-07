# Authenticated access in 0.3.3

This guide describes the `0.3.3` source behavior. Existing published image digests
and tags are unchanged; source acceptance does not authorize a release or rollout.
Use [authentication contracts](authentication-contract.md) for configuration and
[resource authorization](resource-authorization.md) for the coverage boundary.

## Accounts and browser sessions

Configure API and Web with the same database, `TW_AUTH_SECRET` (at least 32
characters), `TW_AUTH_BASE_URL` and exact `TW_AUTH_TRUSTED_ORIGINS`. Use HTTPS
outside loopback and a single browser origin/reverse proxy. Do not log credentials
or place Secret values in source, URLs, planning documents or command arguments.
Missing authentication configuration fails closed.

For a fresh instance, supply a one-time `TW_AUTH_BOOTSTRAP_SECRET` through the
operator's Secret facility and open `/login`. Choose first-administrator setup,
enter the deployment bootstrap secret and create the local account. Bootstrap is
serialized and works only for an uninitialized instance. Remove the bootstrap
secret from runtime configuration after initialization. There is no public signup.

An administrator signs in, reauthenticates for sensitive actions, then provisions
an account from account administration. Give the returned one-time activation
secret privately to the intended human; activation sets that account's password.
Recovery issues a new finite, one-time activation rather than revealing an old
password. Disablement/recovery invalidates affected sessions and dependent
credentials. The last active human administrator cannot be removed.

Account settings expose the current actor, password changes, session listing and
session revocation. Sessions have finite absolute and idle deadlines. A requested
longer duration remains within configured limits and does not waive recent-login
requirements. Logout or expiry closes streams and clears the previous actor's
query cache. User switches and other-tab logout invalidate browser state; browser
back/restore does not restore prior authenticated content. API Keys cannot serve
as browser/SSR sessions.

## Projects, Agents and Keys

Project settings show memberships to authorized readers. Owners and maintainers
can manage only the roles/entitlements within their allowed ceiling. Maintainers
cannot promote themselves or change ownership. Ownership transfer retains an
active human owner. Viewer is read-only; member can edit ordinary resources;
execution/tool entitlements require separate explicit approval. Assignee choices
exclude inactive, foreign and read-only members. Project pins are actor-private.

Create a managed Agent under the accountable human, give it an eligible project
membership and only the explicit entitlements needed for its purpose. The Agent
has its own audit identity. Its managing human does not automatically inherit all
content accessible to that Agent. Instance administrators do not inherit project
membership or another human's personal data.

From Key settings, select self or an owned Agent, explicit grant targets/actions,
and an expiry (or explicitly choose no time-based expiry). Issuance cannot exceed
both issuer and subject authority. Project grants do not include personal space;
personal grants name the human owner. Human Key-created personal data belongs to
that human; Agent execution remains independently attributed. Never create a
wildcard/allow-all credential. Secrets are shown only once on creation/rotation.
Rotation keeps the actor, bounds and expiry, revokes the old Key and invalidates
its descendants. Revocation also invalidates non-expiring Keys immediately.

```sh
tw auth login --api-url http://127.0.0.1:3001
tw auth whoami --json
tw auth status --json
tw auth logout
```

`login` reads the Key through hidden input or stdin, verifies it before saving,
and requires HTTPS except on loopback. It never accepts the secret as a command
argument. Configuration directories use `0700`, credential files `0600`.
`TW_CONFIG_DIR` selects a separate configuration directory. `TW_API_URL` and
`TW_API_KEY` override stored settings. Local logout removes the stored Key; revoke
it on the server separately and unset environment overrides when needed. Health
reachability is separate from authentication and resource permission.

## REST and browser adapters

Send `Authorization: Bearer <scoped-key>` for CLI/integrations. Actor headers are
ignored as authority. Do not combine Bearer and session credentials. Browser
mutations require the configured exact Origin and a signed CSRF challenge from
`GET /api/v1/auth/csrf` (or Next `/api/auth/csrf`), retaining its cookie and sending
`X-CSRF-Token`. GraphQL POST and tRPC mutations also require browser CSRF.

Protected resource responses are `no-store`. Missing/invalid/expired/revoked
credentials return 401; forbidden action 403; inaccessible identifiers 404;
invalid input 400; concurrency/last-owner conflicts 409; retry limits 429. A
public login may replace an expired browser session, but a malformed Bearer
header never falls through to cookies or anonymous access. Search/count/ranking,
versions, graph links, downloads, tools and events all apply current scope checks.

## Execution and integrations

Daemon executor/reviewer/merger supervisors require a bound managed-Agent Key,
current project grants and the explicit phase entitlement. Registration/control,
SSE access and execution are distinct permissions. Node/client/instance IDs are
routing constraints, not identity. Review uses recorded identities, current
recorded delivery head and original lease/fence, never caller executor overrides.

A task capability binds its initiator, executor, parent credential, phase,
project/requirement/task set, repositories and original worker lease. It lasts at
most 15 minutes and cannot outlive the parent or lease. Only the original
supervisor credential can renew, rotating the secret without increasing bounds.
The local broker gives children opaque loopback handles and isolated configuration;
upstream Keys, provider/Git secrets and ambient supervisor authority stay outside
children. Revocation, membership/manifest changes, account/Agent disablement,
terminal work or lease supersession permanently invalidate old capabilities.
Expired work needs a newly authorized fence and explicit reconciliation; workspace
changes are preserved. Restoring membership cannot revive an old capability.

Assigned project Ti runs preserve verified initiator ceilings and separate Agent
executor authority. Manual schedule initiation can create an explicitly authorized
assigned run. SLO, due/background acquisition, unconverted assistant/Partners
outbound workers and personal autonomous Ti remain closed. A saved schedule/policy
or an authorized SSE connection does not activate these workers.

Web/daemon SSE reauthorize long connections and reconnects. Connection-local IDs,
resync hints and filtered resource metadata cannot expose old global replay
positions. Webhook management requires scoped management authority; outbound
fanout/retries recheck its credential, current access and configuration generation.
Revocation/expiry/removal stops delivery. MCP HTTP/SSE connections run at the API
host only when explicitly configured. Local stdio executes in the authenticated
`register-local` client; actor and credential binding still apply when client/node
IDs match. Catalog links never grant shared/personal repository catalog editing.

## Offline upgrade and recovery

Rehearse against a sanitized disposable copy. Stop all application/runner writes
and back up the complete database, extension definitions, skill storage and old
binary/image/configuration references. Verify restoration before mutation.
Forward schema migration does not infer human identity from legacy actor labels.
Bootstrap/provision verified humans and Agents, then inspect a fixed legacy cutoff
using a database-owner credential supplied only through the environment:

```sh
pnpm build
pnpm exec tsx scripts/auth-ownership-migration.mts --help
pnpm exec tsx scripts/auth-ownership-migration.mts --before "$CUTOVER_UTC"
pnpm exec tsx scripts/auth-ownership-migration.mts --manifest "$PRIVATE_MANIFEST"
pnpm exec tsx scripts/auth-ownership-migration.mts --manifest "$PRIVATE_MANIFEST" \
  --expect "$INVENTORY_FINGERPRINT" --apply --ack-maintenance
```

`TW_AUTH_MIGRATION_DATABASE_URL` must name the offline maintenance database and is
never printed. The strict manifest contains `id`, `legacyBefore`, explicit
`ownership` entries (`resource`, `id`, `ownerFingerprint`, verified `actorId`) and
`memberships` (`projectId`, verified `actorId`, `role`, `explicitPermissions`). Use
the inventory's owner fingerprints and an independently checked actor mapping.
Every mapped project needs an active human owner; the tool will not overwrite
existing memberships or post-cutoff data. Without `--apply` it validates and rolls
back. Apply requires the expected current fingerprint and maintenance acknowledgement.

Unmapped non-project legacy data is quarantined; human content cannot be adopted
by guessing a UUID. Historical attribution is retained. Unbound legacy Keys are
revoked and must be reissued with explicit scopes. Old claims/delegations/runs are
fenced; daemons become offline/paused and execution configurations require explicit
revalidation. The same receipt/manifest replay is a no-op, not a way to reset a
fresh lease. A changed manifest under the same receipt is rejected. No REST
endpoint grants this offline database-owner operation.

Verify cross-user/project/personal isolation, scoped Keys, revocation/expiry and
new registration/lease/recovery on the rehearsed copy. Dirty workspace changes
remain available for explicit resume; conflicted or missing worktrees are
quarantined for review. Recovery restores the full pre-upgrade database and matching
skill storage with the recorded old binaries. Image rollback alone cannot undo
migrations; restoring a backup also discards post-backup writes. A schema-only dump
may omit required extension definitions. Keep failed state for diagnosis and do
not run old binaries against the migrated live schema.
