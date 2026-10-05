# Authentication contract

Task Weaver separates a stable human or managed-agent actor from the credentials
used to authenticate it. `@task-weaver/contracts` is the canonical schema/type
package; `@task-weaver/core` and its `schemas`/`types` entry points re-export these
contracts for compatibility. REST, tRPC, GraphQL, CLI, streams and background
execution must share the same server identity resolver and core authorization.

These contracts are a foundation, not an activated authentication system. The
existing transport adapters still require coordinated replacement before the
application can be treated as an authenticated multi-user service.

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
are enforced by credential services when implemented, not by shape validation.

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
phase's execution permission. Subsequent renewal and revocation checks must
preserve these bounds.

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
storage and migration require integration/security tests when implemented.

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
password fields are private storage, never public DTOs. A3 must configure UUID IDs,
closed registration, server-only identity fields and hooks that supply finite
absolute/idle session deadlines before enabling the provider. Cookie caching must
be disabled. This storage change does not enable login or transport authentication.

Bootstrap must lock the seeded singleton and validate the deployment Secret;
the migration neither creates an administrator nor persists that Secret. Recovery
uses administrator-issued, finite, hashed one-time activations. A3 must serialize
account/ownership mutations and protect the last active human administrator and
project owner; additive storage cannot impose those cross-row invariants on legacy
projects before their explicit ownership migration. Membership removal is recorded
with `removedAt`; rejoining reuses the unique project/actor record and preserves
history through the activity log. No runtime account lifecycle is enabled here.

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
revoking or rotating a parent invalidates descendants. Future execution delegation
resolvers must likewise recheck their parent credential on each protected operation;
A2 does not create delegations, runners or revocation caches.

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

Legacy compatibility functions now exclude hashes, retain revoked tombstones and
hide bound keys from legacy listing, authentication and mutation. They are explicitly
deprecated until A4 replaces the old transport routes coherently after A3. Unbound
legacy keys remain historical compatibility credentials, cannot construct a new
verified context and receive no implicit project membership or stable identity.
This foundation does not make the current transports a secure multi-user release.
The ordered A3/A4 and resource/execution slices must complete before activation.

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
rewriting. Resource services adopt this owner resolution in the ordered isolation
slices before runtime activation.

## Account and session service lifecycle (A3)

The core authentication factory keeps Better Auth's handler and raw provider
responses private. Public registration and OIDC/SSO are disabled. Transport
adapters in A4 must use the factory's guarded operations, never mount the
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
