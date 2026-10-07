# Resource authorization

Ordinary resource adapters call `createResourceServices(verifiedContext)`. The context comes only from the shared authentication resolver. Each operation revalidates persisted actor, session/key, issuer, parent and membership authority inside a transaction serialized with identity lifecycle changes. A previously verified snapshot does not retain revoked authority. Delegated requests additionally require immutable execution bounds and a live parent credential/original lease.

The package-level compatibility namespaces reject business calls. The underlying service modules are private implementation helpers, not package exports or transport interfaces. Internal callers must enter through the verified factory before ordinary resource work. There is no internal administrator or allow-all context. Unconverted background workers remain paused; explicitly delegated project execution uses the runtime boundary below.

Query predicates filter project membership, explicitly granted human personal ownership and ordinary global knowledge before SQL counts and pagination. Invalid mixed scopes and legacy agent/partial ownership are quarantined. Instance administration is independent of content access. Writes require the corresponding action, and relationships require write access to their owning endpoint and read access to the other endpoint. Nested relation metadata is filtered again before serialization. Project deletion archives the project so nullable document foreign keys cannot turn project content into global knowledge.

## Coverage inventory

| Surface | Current 0.3.3 boundary |
| --- | --- |
| Projects, requirements, tasks, claims, documents/history, memories and links | Context-bound core services; current membership, human personal ownership and credential ceiling; validate both relation endpoints |
| Search, title resolution, recommendations, graphs, board/gantt and context | Scoped SQL candidates before limits, totals, ranking and nested relation expansion |
| Skill packages, versions, storage/files/downloads and embeddings | Asset scope and child relationships; separate provider management boundary |
| MCP discovery/lifecycle/calls and local mailbox | Explicit resource/invoke grants; verified actor/credential binding; no API-host stdio |
| Repository catalog, workspace links and readiness | Shared catalog requires admin plus global repository.manage; personal catalog belongs to a human; links do not grant editing |
| Schedules, reviews, usage, audit and observability | Live resource permissions, explicit audit/review rights, recorded identities and original fences; redact execution internals |
| Daemon supervisor and task broker | Bound Agent identity, explicit phase entitlement, immutable delegation bounds and live parent/lease checks |
| Assigned project Ti and Partners task invocation | Verified initiator ceiling, separate executor and task-bound delegated authority |
| Web/daemon SSE and outbound webhooks | Live event/resource permissions, safe resync/replay and credential/configuration revocation |
| Assistant, plans, SLO, due/background acquisition and unconverted workers | Remain denied/paused; personal autonomous Ti is not enabled |
| Version | Exact public static endpoints; authenticated manual update check |

REST, tRPC and GraphQL use the same factory. Exported unbound database operations
fail closed; pure formatting/evaluation functions grant no database access.
Entry-point allowlists remain narrower than the service factory. A method's
implementation does not authorize neighboring system/execution paths. GraphQL
nested resolvers recheck source and target; responses stay `no-store`.

`pnpm test:auth-postgres` inventories all registered REST/GraphQL method-path pairs
and tRPC procedures for forged/anonymous credentials, detects unclassified Next
API routes, and compares owner/member/viewer/foreign/admin and human/Agent scoped
Keys through actual REST, HTTP tRPC and GraphQL requests. Complementary fixtures
cover batch atomicity, retrieval metadata, history/downloads/tools/hooks, expiry,
revocation, reconnect/replay, delegation and upgrade recovery.

### Skill distribution and embedding management

Skill package registration, metadata/version changes, files, downloads, storage verification and reindexing use the verified core facade. Package predicates run before pagination and context ranking; primary/indexed documents must share the package scope and each storage object must belong to the selected version. Invalid relationships quarantine the package. Internal storage keys are omitted from responses. Global skills are readable to authenticated subjects with global resource.read; global mutations require explicit global resource.write. Personal resources remain human-owned.

Embedding profiles, generations and jobs use the same live scope grants. Provider creation/configuration changes, tests, enablement and generation activation additionally require an active human instance administrator, instance.manage in the credential, and management rights for the resource (project.manage, personal resource.write, or global.manage). Instance administration alone never grants project/personal access. Other readers receive metadata with blank provider endpoint/secret references; raw provider errors and lease details are omitted. Existing resource maintainers may rebuild, disable and control jobs. Malformed cross-scope children quarantine the profile; document counts and rebuild inputs use authorized current documents. Provider test and enable construct their provider inside the authorized core operation. Unconverted background embedding execution remains closed; SSE uses the realtime boundary below.

PostgreSQL acceptance includes package/version/storage relationship attacks, private/global package access, administrator scope intersection, provider-config privileges, scoped keys, job/generation ownership, and cached-context membership revocation across REST and tRPC. GraphQL has no package or embedding management fields; its existing resource/retrieval fields continue through the same facade.

## Execution metadata boundaries

Usage reads require project `audit.read`, including explicit API key coverage. Counts, token sums and known Ti attempt coverage reject inconsistent task/requirement/project relationships before aggregation. Reporting uses a delegated execution or owned supervisor/worker fence, never a caller-supplied actor.

Reviews read the requirement and catalog scopes. Review mutations require an explicitly approved `execution.review` entitlement and the same permission in the credential, keep existing requirement claim/fence checks, and bind writes to the recorded reviewer. Starting a review uses the stored executor attribution and current delivery head; client executor overrides cannot defeat separation of duties. Project or requirement policy edits require `project.manage`. No review grant confers Git merge authority.

Schedules persist independent personal human ownership. Agent credentials retain Agent audit attribution while newly created personal schedules belong to the managing human. Unbound legacy personal schedules remain quarantined. Scope changes require management in both the old and new scope; requirement and generated-task relationships must agree. Assigned executors must be active, eligible members of the project or the owning personal space. Authenticated task acquisition uses the supervisor/delegation boundary below. Manual schedule initiation requires explicit current authority and assigned project execution; storing auto-run configuration does not start a background worker.

Ti personal owner overrides require live personal grants; instance administrators receive no implicit access to another user's configuration, policy or run. Providers use instance environment credentials, so provider configuration requires the approved administrator boundary even for implicit default references. Ordinary owner controls can choose an existing model or edit account policy. Run reads require a valid task or schedule relationship; orphaned and mismatched runs are quarantined. Credential references, base URLs, event logs, errors, sandbox IDs and lease internals are omitted from transport results.

Activity lists/exports select visible entities before pagination. Project audit requires `audit.read`; personal activity follows the human owner's resource access. Arbitrary audit metadata is omitted from these administration surfaces. Observability, queues, history and metrics use scoped requirement/progress/history SQL, quarantine invalid task/slice/dependency/catalog relationships, and ignore untrusted raw worker-state payloads. Read-only queue inspection performs no daemon cleanup. An administrator with no project membership sees no project queue, worker or history data. C1 authorizes supervisor daemon lifecycle/control/progress writes as described below; unconverted SLO surfaces remain closed.

There is no generic global settings endpoint. Existing identity instance controls and embedding provider controls retain their explicit instance administrator policies. SSE/webhooks and delegated execution use the implemented boundaries below. Unconverted background workers and SLO remain closed.


## Realtime resource boundaries

Web SSE and optional daemon SSE resolve verified session/key identity and share core event authorization. Every emission and one-second heartbeat checks live credential and actor authority under the identity lifecycle lock. Changed grants close the connection; heartbeat never refreshes session lifetime. C1 authorizes the supervisor lifecycle/acquisition/control/reporting paths described below; background execution remains closed.

Streams contain scoped invalidation hints, not raw event payloads, attributes, titles, host details, worker state, messages or global sequence metadata. Task/document/requirement IDs are checked against current resources; links require both endpoints. Document deletion uses the deletion audit's persisted scope snapshot; legacy deletions without that snapshot are suppressed. Schedule and daemon events use the existing scoped metadata predicates. Connection queues are bounded and cancelled readers unsubscribe.

There is no replay buffer. Every reconnect announces `resume=resync`; clients reset their connection-local sequence and refetch current authorized data. Old cursor/query/Last-Event-ID values are neither echoed nor used to recover old authority. Event IDs and sequence counters belong only to the current connection. PostgreSQL listener initialization is shared across concurrent Web connections.


## Webhook management and outbound event authority

Project hooks require current `resource.read` and `webhook.manage`. Shared/global hooks require those explicit global permissions and an active human instance administrator. Global hooks receive only global resource hints; project and personal content is never inherited through instance administration. Routine detail/list/update/delete and delivery responses omit signing secrets, credential IDs/ceilings, payloads and remote response bodies. Creation and explicit `rotateSecret` return the signing secret once. Management and rotation are audited.

Migration 0053 adds a stable actor, revocable session/key binding, configured-scope ceiling and binding generation. Legacy hooks are disabled, retain their data and require explicit authorized management before becoming eligible. Management changes create a new binding generation, so old delivery logs/retries cannot expose data or regain eligibility under a different configuration or credential. A bound browser session does not refresh during background delivery; expired sessions require explicit reauthorization. Human/Agent credential identity remains independent of resource ownership.

Every dispatch and explicit failed-delivery retry revalidates the stored actor, credential, current membership, permission ceiling, configuration generation and all event resources using the same core SSE resource rules. This includes two-endpoint link checks and deletion scope snapshots. HMAC-SHA256 signs only authorized invalidation hints. Requests start under the identity lifecycle lock, have a ten-second timeout, reject embedded URL credentials and do not follow redirects. Secret material and remote response text never enter audit/error responses. Already dispatched data cannot be recalled; queued/retried work is always reauthorized.

The API restores only this authorized webhook event subscriber, with a bounded sequential event queue. Unconverted workers and SLO remain closed. Authenticated supervisor and delegated project execution use the boundaries below. There is no autonomous retry worker; authorized managers can explicitly retry failed deliveries within the current binding generation.

### CLI credential configuration

`tw auth login` reads a subject-bound scoped API key from hidden terminal input or
stdin, verifies it with `/api/v1/auth/me`, and saves it without changing client,
node, daemon instance, or repository credential profile metadata. Create the key
through the authenticated account interface with the intended subject and grants.
Human keys remain human identities; managed-agent keys resolve their bound agent.
`tw auth whoami --json` queries the current verified identity. `tw auth status`
reports reachability and authentication separately; successful authentication does
not grant access to every resource.

The CLI configuration directory uses mode `0700` and credential files use `0600`.
`TW_CONFIG_DIR` selects an isolated configuration directory. `TW_API_KEY` and
`TW_API_URL` override stored values. Keys are never accepted as command-line
arguments or printed. New remote logins require HTTPS; loopback HTTP is supported for local
development. Existing configured endpoints retain their transport configuration. Redirects do not forward credentials.
`tw auth logout` removes the stored key locally. It does not revoke a shared key
on the server; revoke that key through the authenticated credential interface
when required, and unset any environment override.


### Authenticated daemon supervisors

Executor, reviewer and merger registration requires a verified managed-agent key
with current project read permission and the corresponding `execution.run`,
`execution.review` or `execution.merge` entitlement. Executor acquisition also
requires project write permission. Instance IDs, node IDs, client IDs and Actor
headers never establish authority. Existing instances retain their recorded actor
and role; unbound legacy instances cannot be adopted through registration.

Core authorization filters project queues, relationship validity and repository
visibility before pagination, eligibility counts and claims. Progress/recovery
requires the owned instance, authorized targets and the existing run/worker/lease
fence. Every operation resolves live credential and membership ceilings; Key
rotation preserves the stable actor and cannot transfer instance ownership.
Daemon management requires `project.manage` for the agent's execution projects
and an owned instance or its recorded managing human. Human or instance-admin
status alone supplies no daemon management permission.

SSE reconnects reload the configured credential and do not send Actor headers.
Acquisition performs no global daemon cleanup. Unconverted background cleanup remains
closed; explicit recovery uses an authorized current fence. The server reports
`executionDelegationSupported: true`; authenticated supervisors exchange bounded
capabilities for children. This does not authorize ambient credential inheritance
or unconverted background-worker activation.

## Task capabilities and local access broker

A recorded Agent supervisor can exchange its subject-bound API key for a task
capability on its own active daemon worker lease. The server derives the actor,
project, requirement, phase actions and lease generation. Execution capabilities
bind one task and its linked documents and repositories; review/merge capabilities
bind the requirement's recorded task set. They exclude identity, membership,
instance administration, daemon controls and unrelated content. REST, tRPC,
GraphQL and events apply the same live core bounds before returning data.

Capabilities expire within 15 minutes and never outlive the parent key or original
lease. Only the original authenticated supervisor credential can renew them;
renewal rotates the secret and preserves all bounds. Each operation rechecks the
parent credential, actor, current grants, original worker lease, task/document
relationships and repository manifest. Secrets are returned once, stored only as
hashes, and omitted from audit records.

The local task-access broker gives a child an opaque loopback handle. It keeps
upstream capability secrets private, strips ambient credentials and actor headers,
rejects administration/control routes and stops on upstream credential rejection.
Renewal cannot expand the recorded task/repository bounds. Children receive the local broker rather than the supervisor credential;
cancellation and worker integration preserve the original lease fence.

### Cancellation and recovery integration

Membership changes, credential revocation/rotation, account or Agent disablement,
terminal task/requirement transitions and repository manifest changes permanently
revoke old execution capabilities. Restoring membership or returning a task to an
active state requires a fresh supervisor exchange. The original worker lease and
server-derived fences still govern every status mutation; children cannot force
past dependency checks or supply another daemon's lease identity.

The supervisor gives each executor task and AI review a separate loopback broker,
temporary home and CLI/provider configuration directories. The environment drops
ambient TW credentials, provider keys, Git helpers and SSH agent access. Trusted
Git/forge operations remain in the supervisor. Capability-bearing output is
redacted. Each child releases its broker and temporary configuration on completion.
Multiple tasks receive separate capabilities rather than sharing broader task
rights. Periodic live authority checks, bounded renewal and original expiry close brokers; lease health loss
cancels the affected operation permanently, preserves workspace changes and uses
the existing fenced reconciliation path. Unauthorized recovery writes remain
rejected and the expired lane becomes recoverable by a newly authorized supervisor.

Assigned project Ti/Partners execution propagates verified initiator ceilings and
a separate bounded executor capability, with authenticated end-to-end fixtures.
Background SLO, due scheduled acquisition, personal autonomous Ti and other
unconverted workers remain closed. See [authenticated access](authenticated-access.md)
for operator and offline recovery behavior.
