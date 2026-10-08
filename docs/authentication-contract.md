# Authentication contract

Task Weaver separates a stable human or managed-agent actor from the credentials
used to authenticate it. `@task-weaver/contracts` is the canonical schema/type
package; `@task-weaver/core` and its `schemas`/`types` entry points re-export these
contracts for compatibility. REST, tRPC, GraphQL, CLI, streams and background
execution must share the same server identity resolver and core authorization.

The 0.3.3 source implements these contracts across the authorized resource and
execution surfaces. Unconverted operations remain explicitly denied. See
[authenticated access](authenticated-access.md) for account UX, CLI setup and
offline upgrade/recovery; source acceptance does not authorize production rollout.

## Identity and credentials

`principalSchema` describes immutable UUID actor identity and lifecycle. Human
principals refer to an account UUID; managed agents refer to their managing human
actor. API keys are bound to an actor: a human CLI key authenticates a human,
and rotation never changes actor identity. Agents cannot use browser sessions or
hold an instance-admin role. Legacy string actors remain historical attribution,
not verified principals.

`requestIdentitySnapshotSchema` validates the structure of an active principal
and its credential binding, expiry at verification time, and optional execution
delegation. Parsing it does **not** validate a token, session, live membership,
managing account, revocation, resource relationship or lease. The separate
`VerifiedRequestContext` type requires a server assertion after these live checks.
Never deserialize a verified context from HTTP input, a cookie payload, an Actor
header or a queue message. `resolveActor` is deprecated legacy attribution and
cannot produce a verified context.

Database sessions use current actor authority; API keys have explicit finite
credential grants and a chosen expiry. API keys may select a longer deadline or
explicit `expiresAt: null` for no time-based expiry; the field cannot be omitted.
Session and execution-delegation deadlines remain finite. Login may request
`sessionDurationSeconds`; the resolver must apply the configured allowed duration
options and session idle policy rather than trusting the request. A longer session
does not bypass revocation or recent-login requirements for sensitive actions.

Deleting an API key revokes it immediately, including keys without an expiry,
and invalidates its dependent delegations. Preserve its audit reference/tombstone;
deletion does not erase historical actor attribution. These lifecycle operations
are enforced by live credential services, not by shape validation.

`issueScopedApiKeySchema` contains no subject ID:
the authorized self/managed-agent route determines the subject. Requested grants,
including personal owner IDs, are constraints to validate against server state,
never proof of ownership. Existing authority, credential scopes and any execution
delegation intersect. Tokens cannot add rights the actor does not possess.

## Resource permissions

Grant targets are distinct: `personal` requires an exact owner actor, `project`
requires an exact project UUID, `global` describes instance-shared ordinary
assets, and `instance` describes administration. Global is not anonymous/public.
Instance administration implies neither personal-content access nor project
membership. Clients cannot combine resource selectors or request wildcard grants.
`AUTHORIZATION_SCOPE_PERMISSIONS` also rejects actions attached to the wrong
target domain, such as instance administration in a project grant.

`PROJECT_ROLE_PERMISSIONS` describes default role eligibility; it does not make
an authorization decision. Members can read/write ordinary project resources;
maintainers can administer the project below owner level; only owners can manage
ownership. At least one active human owner and instance administrator must remain,
enforced transactionally by lifecycle services.

Tool invocation and review/merge rights require separately approved actor
entitlements, represented by membership `explicitPermissions`, as well as
credential scopes and existing review policy. `PROJECT_ROLE_GRANTABLE_PERMISSIONS`
separately describes which entitlements owners/maintainers may approve through
authorized membership management; approving a right is not exercising it.
Bounded agent execution similarly
needs explicit execution authority. Project owner/maintainer grants must be
audited and stay within the membership administrator's grantable permission ceiling.
Token/delegation issuance additionally cannot exceed the issuer's current action
rights; it is not a way to grant actor entitlements. Live core checks enforce these
rules, restrict maintainer role changes below owner level, and prevent maintainers
from changing ownership or promoting themselves.

## Delegation, DTOs and failure behavior

`executionDelegationSchema` requires an agent executor, accountable initiator and
delegator, parent credential, project/requirement/tasks, frozen repositories, run,
purpose, positive lease generation and deadline. An identity snapshot rejects
cross-project grants, empty/duplicate tasks, credential/delegation lifetime
mismatches, administrative actions and incompatible execution phases. Its shape
cannot prove the parent authority, task/project relations or current lease.
Review/merge may include task-bound bookkeeping but cannot receive another
phase's execution permission. Delegations last at most 15 minutes and never outlive the parent or original
lease. Only the original authenticated supervisor credential can renew, rotating
the secret without widening task/repository/action bounds. Each operation
revalidates current authority; revocation or lease changes permanently invalidate
old capabilities.

Public account, principal, membership, session and API-key metadata DTOs are
strict allowlists and reject token/password/hash/secret fields. Services must
explicitly project DB rows into DTOs. Login input necessarily contains a password
and must never be logged; raw issued credentials are a one-time secret response,
not reusable public metadata.

`AuthenticationError` uses safe, uniform messages with internal failure codes;
adapters return a generic authentication-required response for missing, invalid,
expired, revoked or disabled credentials (HTTP 401). `AuthorizationError` maps to
HTTP 403; inaccessible resource identifiers use 404; invalid shape uses 400;
last-owner/concurrency conflicts use 409. Resolver unavailability must fail closed
with 503. GraphQL/tRPC map these meanings to their transport error codes. No
malformed Bearer request may fall through to cookies, Actor headers or anonymous
authority. Cookie-authenticated mutations require Origin and CSRF validation.

Contract validation tests cover structural failures and export compatibility.
Runtime revocation, ownership filtering, transport/SSE isolation, credential
storage, delegation and offline migration are covered by `pnpm test:auth-postgres`.

## Identity storage

The additive `0048_auth_principals` migration creates stable actors, human users,
local login accounts, revocable sessions, memberships, one-time activation
records and a bootstrap singleton. Existing attribution and API keys are retained;
no implicit identity mapping or project ownership is granted. Actors, accounts and
memberships use restrictive foreign keys so disabling a principal preserves its
history. Only human actors can own a project or manage an agent. Account email
uniqueness is case insensitive. New actors/users default to disabled.

`betterAuthTables` maps the four provider models to their Drizzle tables using the
[Better Auth core schema](https://better-auth.com/docs/concepts/database) and
[Drizzle adapter](https://better-auth.com/docs/adapters/drizzle). Provider token and
password fields are private storage, never public DTOs. The runtime configures UUID IDs,
closed registration, server-only identity fields and finite absolute/idle session
deadlines. Cookie caching is disabled; live database state governs authentication.

Bootstrap must lock the seeded singleton and validate the deployment Secret;
the migration neither creates an administrator nor persists that Secret. Recovery
uses administrator-issued, finite, hashed one-time activations. Lifecycle services serialize
account/ownership mutations and protect the last active human administrator and
project owner. Legacy projects require explicit ownership migration before access. Membership removal is recorded
with `removedAt`; rejoining reuses the unique project/actor record and preserves
history through the activity log. The account lifecycle uses these persisted records and live transactional checks.

## Scoped API key storage and services

`0049_scoped_api_keys` adds nullable stable subject/issuer bindings, explicit scoped
JSON grants, parent/rotation links and revocation metadata without remapping any
legacy key. Only complete bound records can enter the new trusted resolver.
Generated keys use 256 random bits; only SHA-256 verifiers and display prefixes are
stored. Creation and rotation return the new raw value once. Public projections,
revocation responses and credential audit events exclude verifiers and secrets.

The scoped service accepts a server-verified context, rechecks its persisted
credential, subject/account/manager state and current memberships, and intersects
live entitlements with stored ceilings. It never accepts actor headers. Sessions
can issue longer or explicitly non-expiring keys; API-key issuers cannot extend
beyond their own finite lifetime or grant scope. Derived keys retain a parent link
and a bounded ancestry depth. Every authentication walks that live ancestry:
revoking or rotating a parent invalidates descendants. Execution delegation
resolvers likewise recheck their parent credential on each protected operation;
no authorization cache can restore revoked access.

Issuance targets the caller or its managed agent and requires credential-management
authority. Grants must be covered by both issuer and subject rights; managing an
agent does not grant its private content to the manager. Instance admins obtain
neither project membership nor another actor's personal grants. Live membership
reduction and project archival narrow project grants. Rotation preserves the
stable subject, issuer, parent restriction and expiry, narrows grants to current
authority, atomically revokes the previous key and retains both IDs in audit.
Unrelated API-key parents cannot replace an existing ancestry. Serializable writes,
row locking and a unique rotation link prevent concurrent duplicate rotations.
Revocation remains available to an authorized manager for a disabled managed agent.

Unbound legacy Keys cannot construct a verified context and receive no implicit
membership or stable identity. Offline ownership migration revokes them without
promotion; reissue subject-bound scoped Keys after explicit account/owner mapping.

Run `pnpm test:auth-postgres` for a disposable loopback-only pgvector PostgreSQL
fixture. It checks clean and pre-0048 upgrades, repeat migration, preserved legacy
rows, constraints, scoped issuance, long/never expiry, live revocation/disable/role
changes, manager boundaries, parent-preserving rotation, concurrent rotation,
public secret exclusion and legacy isolation. No existing business database is used.

## Human ownership and agent execution

Personal data belongs to a human owner. Using a human-bound key authenticates that
human regardless of the client process. Managed-agent credentials retain a separate
executor actor; their explicitly granted personal scope targets the managing human,
never an implicit agent-owned private space. `getPersonalResourceOwner` resolves the
live human owner separately from the executor. An agent key with project grants
alone gains no personal access, and agent management alone grants no access to
personal content. Agents cannot administer human credentials or accounts.

Project data belongs to its project. Initiator, executor, creator, credential and
resource owner are separate records. A validated delegation/run establishes agent
execution attribution; a human key alone cannot prove which agent operated it.
Credential rotation or agent replacement does not transfer existing data ownership.
Any legacy agent-owned rows require explicit ownership migration rather than silent
rewriting. Current resource services resolve the verified human owner separately
from execution attribution.

## Account and session service lifecycle (A3)

The core authentication factory keeps Better Auth's handler and raw provider
responses private. Public registration and OIDC/SSO are disabled. Transport
adapters use the factory's guarded operations and never mount the
provider handler directly. Account bootstrap requires an explicit Secret and a
serialized instance initialization record. Administrator invitations and recovery
use single-use, hashed activation tokens, defaulting to 24 hours.

Better Auth 1.7.7 with its Drizzle adapter handles signed session cookies and
maintained scrypt password hashing. Passwords require 12–128 characters on
creation or change. Provider logging is disabled; service audit records contain
stable IDs and policy outcomes, without passwords, cookie values, activation
secrets, key material, or submitted email addresses.

Sessions default to seven days absolute and 24 hours idle. A login can request
30 days, 90 days, or another finite duration within the configured maximum
(default one year; operators may configure a longer finite maximum). Every
request reloads the database, checks all expiry deadlines and account/actor
status, and updates the idle deadline without extending the absolute deadline.
Cookie caching and provider refresh are disabled. Expired or logged-out sessions
remain revoked tombstones rather than being physically deleted. Cookie lifetime
matches the requested duration, including concurrent logins with different
lifetimes. Idle duration can also be selected, bounded by the absolute duration. Sensitive account changes require a human session authenticated in
the last 15 minutes; password reauthentication resets recency only.

Anonymous login, initialization and activation, plus cookie-authenticated
mutations, require an exact trusted Origin and a signed double-submit CSRF
challenge. Cookies are HttpOnly, SameSite=Lax, host-only and Secure on HTTPS;
HTTP is allowed only on loopback development origins. No credential resolves to
an authentication error. Malformed Authorization headers, cookie/Bearer
ambiguity, and caller-declared Actor headers cannot fall back to authentication.
Adapters must supply a trusted direct client address for rate limiting and must
not trust arbitrary forwarding headers. Shared database counters bound login,
activation and password retries; their identifiers are digests.

Recovery issuance invalidates the previous password until activation. Recovery
and password change revoke existing sessions and keys, including keys
bound to managed agents. Account disablement additionally revokes pending
activation links. Re-enabling requires an explicit administrator-issued recovery
activation; old credentials stay revoked. Last active human administrator and
last active human project owner checks are serialized with account state changes.
An instance administrator receives no automatic project membership.

Provider references: [configuration](https://better-auth.com/docs/reference/options),
[session management](https://better-auth.com/docs/concepts/session-management),
[email/password](https://better-auth.com/docs/authentication/email-password), and
[database hooks](https://better-auth.com/docs/concepts/database).

## Owner, agent and membership lifecycle (A3)

The identity management factory resolves incoming credentials itself. Adapters
must not deserialize a `VerifiedRequestContext` or derive identity from Actor
headers. Core token operations compose with the lifecycle transaction using
savepoints, retaining standalone serializable behavior and rotation row locks.
Raw key issue/rotation responses include `Cache-Control: no-store` headers;
adapters must propagate response headers while returning only the public DTO.

Every active human can create a project. The project and initial human owner
membership are committed atomically. Owners administer membership and ownership;
maintainers administer lower roles. Changing one's own role or explicit
entitlements requires another eligible administrator's approval. Ownership
changes require recent human authentication, and only an active human can own a
project. Transfer promotes the target and demotes the former owner in one
transaction. Account disablement, membership mutations and transfers share the
instance lifecycle lock, preventing concurrent removal of the final active
human owner. This coarse lock favors correctness over parallel mutation
throughput in the initial implementation.

An owner or maintainer may separately approve persisted execution/MCP
entitlements without automatically receiving those execution rights. A scoped
API key can approve or assign only rights within its own live ceiling; it cannot
use membership administration to widen itself or another credential. A human
session requires recent authentication for membership assignment, removal and browser
credential mutations. Explicit human-bound `credential.manage` API keys may
create parent-bounded descendants, subject to live issuer/subject intersection.
Agents cannot administer human credentials. Every mutation reloads current
credentials, account status, project status and membership; no permission cache
can retain removed entitlements.

Managed agents have stable identities and managing humans, and never acquire a
human login account. Personal resource ownership remains the managing human.
Agent personal access requires a key explicitly scoped to that human space.
Managing an agent never proves permission to access a project or private data.
Disabling an agent retains its identity/audit trail and revokes bound keys.
Instance administrators have a separately named agent-disable operation, which
does not grant personal or project content access.

Owner-scoped session listing and revocation never return cookie tokens. Account
recovery/password change revoke existing credentials; recovery issuance also
invalidates the old password until activation. Unexpected database/provider
exceptions are replaced at the service boundary because their query parameters
may contain secret material. Known domain errors remain safe, structured errors.

REST, tRPC, SSR and GraphQL use these services with CSRF/CORS, safe errors,
no-store and Set-Cookie propagation. Resource/event/runtime authorization is
separate from identity and never implies review/merge eligibility beyond current
explicit entitlements and the recorded review policy.

## A3 review corrections

Login holds the lifecycle lock and routes both Better Auth's adapter queries and
session hooks through the same Drizzle transaction, using request-local async
context. Provider sessions and their audit event commit or roll back together;
a one-connection pool cannot deadlock by opening a second connection inside the
locked login transaction. Database connections remain configurable, with the
existing default of ten.

Password change, recovery and disablement revoke pending activation links both
owned by the subject and previously issued by that subject. Administrator
demotion also permanently revokes outstanding issuer links. Restoring an account
or administrator role never revives these links. Activation consumes its current
link before revoking other outstanding authority, all within the locked
transaction, so a valid administrator recovery link remains usable exactly once.

Browser membership removal requires the same recent authentication as assignment,
including removal of non-owner members. Scoped API keys still require explicit
membership administration within their live credential ceiling; removing an owner
additionally requires a recently authenticated human session and another active
human owner.

## Shared transport adapters

REST, Next tRPC, human SSR and GraphQL use `createAuthenticationRuntime` and the
same persisted provider/session/key state. Each protected invocation reloads live
authority; cached caller context and Actor headers cannot authenticate a request.
Human-bound keys remain human. Managed-Agent keys remain their stable Agent
subjects and cannot become browser sessions. GraphQL guards explicit and default
nested resolvers, including contexts with stale identity metadata. tRPC checks
each procedure in a batch and supports separately protected administrator
procedures requiring a recent human session.

The API and Next server must share the following Secret/configuration settings:

| Variable                       | Meaning                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `TW_AUTH_SECRET`               | Deployment Secret, at least 32 characters; mandatory           |
| `TW_AUTH_BASE_URL`             | Public provider URL; HTTPS outside loopback; mandatory         |
| `TW_AUTH_TRUSTED_ORIGINS`      | Comma-separated exact origins; defaults to the base URL origin |
| `TW_AUTH_BOOTSTRAP_SECRET`     | Optional one-time first-administrator deployment Secret        |
| `TW_AUTH_SESSION_SECONDS`      | Default finite absolute lifetime, default 604800               |
| `TW_AUTH_SESSION_IDLE_SECONDS` | Default finite idle lifetime, default 86400                    |
| `TW_AUTH_MAX_SESSION_SECONDS`  | Configurable finite maximum, default 31536000                  |
| `TW_AUTH_ACTIVATION_SECONDS`   | One-time activation lifetime, default 86400                    |

No absent configuration selects an anonymous mode. Use a single public browser
origin/reverse proxy with host-only cookies; Next browser calls use same-origin
`/api/trpc` and `/api/auth/csrf`. REST sends credentialed CORS headers only for an
exact configured origin and validates requested preflight methods/headers. Next
does not enable cross-origin browser CORS. Both validate supplied Origin and
signed CSRF for cookie mutations; GraphQL POST and tRPC POST also require CSRF.
API retry buckets use direct socket metadata only; Next has no direct address in
its Web Request interface and uses a conservative shared address bucket. No
forwarded address/actor header is trusted. Verified proxy-address support belongs
to a future explicitly configured ingress boundary, not a permissive fallback.

The exact REST public entry points are GET `/health`, GET `/api/v1/version`
(including its trailing slash), GET `/api/v1/auth/csrf`, GET `/api/v1/auth/setup-status`, and POST
`/api/v1/auth/bootstrap`, `/api/v1/auth/login`, `/api/v1/auth/activate`.
Configured-origin OPTIONS preflights return no business data. tRPC public
procedures are only query `version.info`, query `auth.csrf`, query `auth.setupStatus`, and mutations
`auth.bootstrap`, `auth.login`, `auth.activate`; other procedures default to
protection. Public endpoints never discard an Authorization header. A new login
may accept an expired browser cookie, so an expired session cannot prevent
reauthentication; malformed bearer or mixed bearer/session credentials fail
closed. The Better Auth handler and public signup are not mounted.
POST `/api/v1/version/check` and tRPC mutation `version.check` require verified
authentication and browser CSRF; version metadata does not confer resource access.

Protected `/api/v1/auth/*` endpoints expose current actor, logout, reauthentication,
password changes, owner-scoped sessions, administrator account lifecycle,
managed agents and explicitly guarded project creation/membership/ownership.
`/api/v1/api-keys` uses the shared strict scoped-key schema; optional `actorId`
selects only an authorized self/managed-Agent subject. Expiry/null and grants are
explicit; rotation preserves grants/expiry, and deletion retains revocation
history. tRPC `auth` and `apiKey` expose the same guarded services. Account/project/Agent UX manages
current sessions, memberships, eligible assignees and subject-bound scoped Keys.
Issuance and rotation expose raw secrets once; routine metadata never includes them.

Authentication responses preserve multiple Set-Cookie values, use no-store, and
return safe errors: 401 for missing/invalid/revoked credentials, 403 for forbidden
actions/CSRF, 400 for invalid inputs, 429 plus Retry-After for bounded attempts,
and a generic unavailable error for unexpected failures. tRPC additionally
returns safe `authCode` metadata and strips server stacks. GraphQL uses matching
safe error codes/status extensions. Refreshing a still-valid signed CSRF
challenge preserves its original deadline and cookie across REST/Next/tabs;
near-expired or invalid challenges are replaced. The browser uses a single-flight
challenge and refreshes before its returned deadline.

## Current activation boundary

REST, tRPC and GraphQL ordinary resources, retrieval/assets, repositories, tools,
metadata, Web/daemon SSE and webhooks now use the verified core boundaries.
Authenticated supervisor and delegated project execution are implemented;
[resource coverage](resource-authorization.md) identifies remaining closed paths.
No environment flag restores legacy anonymous or allow-all behavior.

D1 provides login/bootstrap/activation, account/session administration, project
members/Agents, scoped credential lifecycle and actor-private pins. D2 provides
explicit offline legacy ownership migration, quarantine and runtime fencing,
with exact-0.3.2 upgrade/full-backup recovery regression. D3 adds the registered
entry-point credential inventory and cross-actor HTTP matrix. These source checks
are acceptance evidence, not a version release or deployment instruction.


### Contextual browser identity confirmation

The login form uses instance session defaults without a custom lifetime. API
session overrides remain subject to existing absolute, idle and maximum limits.
The anonymous setup status returns only `initialized`, with `Cache-Control:
no-store`; unavailable status hides first setup. The server serializes bootstrap
and rejects all further setup attempts after initialization.

Sensitive account, Agent, credential and membership actions open a password
dialog before mutation. Confirmation travels directly through the tRPC client,
not its mutation cache. Cancellation discards the pending continuation, including
when authentication is already in flight; success resumes it once. A wrong
confirmation password stays in the dialog rather than ending a valid session.
Origin, CSRF, live permission and recent-session checks still run on the server.
The identity menu exposes account settings and sign out, using the shared browser
session invalidation boundary for cache, streams and other tabs.


### Managed Agent retirement and project permissions

Migration `0059_agent_retirement` adds nullable `auth_actors.deleted_at`, an
Agent-only disabled-state constraint and a lifecycle listing index. Apply it
before running the updated services. Existing identity rows and foreign keys
are preserved; no backfill, credential rotation or policy expansion is required.

`GET /api/v1/auth/agents` defaults to active, non-deleted identities managed by
the verified human. Explicit `status=disabled` and `status=deleted` queries use
separate filters. All lists accept a literal name `query`, `page` and `pageSize`
(default 20, maximum 50), with stable ordering and array responses. Consumers
must page until a response contains fewer than `pageSize` rows. The Web only
fetches the selected lifecycle view, and normal assignee queries exclude retired
Agents in SQL. Deleted Agent memberships remain stored but are omitted from
normal project member lists.

Disable remains irreversible and revokes credentials/executions under the
identity lifecycle lock. `DELETE /api/v1/auth/agents/:id/retired` accepts only
owned, disabled, not-yet-deleted Agents, requires recent human authentication,
and retains the immutable identity and audit/foreign references. A deleted row
cannot become active under the database constraint. Reusing a display name
creates a distinct UUID without old memberships or credentials.

Agent detail project lists disclose only projects within the caller's current
read or membership-administration authority. Search and paging occur in SQL.
The Web edits through the existing shared project membership operations, with
recent confirmation, live role/credential ceilings and execution revocation.
Role-derived permissions, explicit approvals, and existing personal/global
policy sources are displayed separately. No new personal/global grant editor
is introduced. Agent entitlement expansion does not enlarge an issued Key's
ceiling, and revoked credentials stay revoked after membership changes.

CLI inspection: `tw auth agents list --status disabled --query name --json`,
`tw auth agents get <id> --json`, and `tw auth agents projects <id> --view available
--json` use the same bounded REST contracts. Sensitive lifecycle mutations still
require a browser session rather than an ordinary CLI API key.
