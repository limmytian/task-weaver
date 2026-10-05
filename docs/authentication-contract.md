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
credential grants and expiry. `issueScopedApiKeySchema` contains no subject ID:
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
