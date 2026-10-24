# Live planning and execution recovery

Planning authority and execution authority are separate. Authorized humans and
agents can edit plans while a requirement lane is executing. All ordinary Web,
REST, CLI, inbound MCP and batch-plan mutations use the core resource service
transaction and identity lifecycle lock. An execution capability grants no
supervisor credentials and cannot acquire its own replacement authority.

## Impact and fencing

Core classifies changed execution inputs rather than using ordinary row versions
as execution authorization. Task and requirement descriptions include acceptance
criteria. Titles, ownership, task moves, slice assignments/order/parallelism,
blocking DAG changes, repository scope, workflow definitions and declared output
inputs affect execution. Comments, priority and future model-tier selection do
not restart a run. Repeated writes of an unchanged input do not invalidate it.
Attachment edits affect explicitly declared workflow-input consumers; arbitrary
linked-document edits do not invalidate every linked requirement.

Affected requirement lanes and downstream blocking consumers receive a planning
revision. The same transaction revokes delegated credentials and persists a
coalesced execution control. Ti attempts associated with affected tasks are also
cancelled. A failed or conflicting mutation rolls back its revision, control and
revocation. The identity lock serializes planning, delegation issuance, claims,
completion and delivery. DAG edits therefore also serialize cycle validation.

A renewable lane lease remains held while a healthy supervisor stops and assesses
its old execution. The per-execution run identifier is rotated before a replacement
agent starts. A retained lane generation does not let an old run complete:
daemon mutation fences include `daemonId`, `leaseGeneration` and `runId`.
Heartbeat renews lane ownership; it does not restore revoked run authority.

A return to `draft` withdraws execution eligibility. A draft predecessor remains
a blocker. Registered outputs retain their planning revision, and completed task states remain historical evidence. Input changes after
completion set `evidenceNeedsReview`; workflow and final requirement advancement
wait for explicit human evidence revalidation against the current plan revision.
This does not recursively reopen completed tasks.

## Control delivery and local reconciliation

`execution_controls` is the authoritative state, independent of notification
receipt. It retains the owning daemon/run, planning revision, reason, deadline
and lightweight workspace metadata. Phases distinguish `pending`, `received`,
`stopping`, observed `stopped`, `reconciling`, `resumed`, `blocked` and `manual`.
Receiving a notification never proves that processes stopped.

The durable outbox emits `requirement_execution_invalidated`. Daemon SSE streams
replay current unresolved controls on connection and reconcile them on heartbeat;
control IDs and revisions make duplicate replay harmless. Ordinary UI events
still request a full resync. Supervisor polling reads the same current records,
so SSE loss, reordering and reconnects cannot authorize stale completion. The
local credential broker also continuously revalidates execution authority and
fails closed on network uncertainty.

The executor stops only the affected managed process group. POSIX children that
remain in that group receive bounded TERM/KILL cleanup. Processes that deliberately
escape the managed group and external requests already in flight are outside
this local termination guarantee. The supervisor records `stopped` only after its
managed command returns. It then inspects the workspace, retains dirty/untracked
files and records metadata, not a reconstructible file checkpoint.

Healthy reconciliation keeps lane renewal active. A new run receives the latest
plan and a new capability, plus explicit instructions to inspect and revalidate
preserved work. Rapid edits coalesce without extending the original five-minute
assessment deadline. Dependency waiting records `blocked`, releases the lane and
worker capacity, and keeps local files. No waiting agent process or machine-wide
reservation occupies that capacity. Other tasks in the same requirement remain
subject to requirement dependencies and slice ordering.

Local process inventory records the managed group identity and workspace path.
On a returned supervisor, an old group's platform authority is checked before
stopping it. PID birth identity is verified before signaling; uncertain identity
or unavailable authorization blocks reuse. Observed stop records survive a disconnected acknowledgment, so an idle or restarted supervisor on the same authenticated node can reconcile them before grace expires. Stale provenance and files are retained,
never automatically published over a replacement. This inventory supports POSIX
supervisors; unsupported process-tree termination requires local manual recovery.

## Best-effort node failure recovery

`recoveryPolicy` belongs to the requirement and explicitly covers its task work:

```json
{"retrySafe": false, "maxAttempts": 3, "graceMs": 120000}
```

The default does not assume unknown work is replay-safe. Set `retrySafe: true`
only when declared inputs can reconstruct the work and repeated external actions
are safe. `maxAttempts` bounds automatic cross-node restarts (0–20); `graceMs`
is configurable from one second through one day. `recoveryAttempts` is durable.
The heartbeat failure detector uses `TW_DAEMON_FAILURE_TIMEOUT_MS` (default one
minute). Grace is anchored to the last confirmed daemon/lease heartbeat, never
to each scheduler poll. Persisting a repeated failure cannot move its deadline.

Replacement requires revoked or expired old authority. During grace, a recovered
original node with observed stopped work is preferred. After grace, explicitly
retry-safe work may receive a new generation on another node, using node-local
isolated workspaces, durable declared inputs and pushed remote code. This may lose
all unpushed intermediate progress and duplicate computation. Metadata does not
reconstruct files, and a predecessor's `done` state does not make unpushed results
available on another node. Explicit local workflow inputs still require their
producing node and verified bytes.

Unknown replay safety, missing irreplaceable inputs, exhausted automatic budgets
and uncertain non-idempotent external outcomes require a concrete human recovery
decision. In-progress Git push/PR/merge checkpoints are treated as uncertain on
node loss. Review and integration failure recovery is conservative because of
external effects. A human can inspect inputs and provider state, then authorize
one fresh recovery; this is an audited decision, not a claim that the old process
or an already-issued external request physically stopped.

There is no mandatory upload, generic temporary-file capture, shared checkpoint
service or last-handoff-commit protocol. Node affinity is a preference rather
than a permanent host restriction.

## Git synchronization

Every task agent must request a fresh target-branch fetch through the local
credential-isolated broker before substantive work:

```bash
tw execution git fetch <repository-id> --json
# Inspect status/diffs and merge or rebase locally; resolve conflicts and validate.
tw execution git verify <repository-id> --json
```

The supervisor checks current run authority before each controlled network
operation. Credentials remain outside the child environment. Only the frozen
execution's repositories are addressable. Fetch returns the latest observed tip
of the target branch, or the configured base when creating a new branch. Verify
fetches again, checks that the observed tip is an ancestor of local HEAD and
records the tip, local head, requirement/planning revision and fetch/verification times for this run. Legitimate
local commits do not require equality with the remote tip.

The platform rejects delegated substantive task/document updates and output
registration until every linked repository has a synchronization record. Fetching
a base clone does not advance an existing worktree. Historical completed-fetch
checkpoints never skip fresh provisioning fetch. Startup prompts identify old
workspace provenance and require selective inspection rather than unconditional
dirty-workspace continuation.

The agent owns merge/rebase strategy, conflicts and validation using ordinary
local Git/file tools. A failed sync must be reported as blocked or for review with
a concrete reason. There is no high-level `tw workspace sync` conflict engine.
Review/integration provisioning refuses a target tip missing from local history.
Controlled delivery fetches again and refuses a branch that advanced outside
local history. Repository failures remain independent. Push uses ordinary Git
fast-forward protection; recovery never defaults to force push or destructive reset.

An authority check cannot retract a Git request already sent. On interruption,
reconcile the provider's actual branch/PR state before retrying uncertain delivery.
Neither database leases nor successful API fencing promise exactly-once physical
execution, rollback of external effects, or cancellation of arbitrary direct
network access outside the controlled capability.

## Interfaces and compatibility

- `GET /api/v1/daemons/:id/execution-controls` returns authorized durable controls.
- `POST .../execution-controls/:controlId/ack` records phase and current revision.
- `POST .../execution-controls/:controlId/resume` re-evaluates the latest plan after
  observed stop; an eligible local replacement retains healthy lane ownership.
- `POST /api/v1/daemons/:id/execution-authority` verifies the current run fence.
- `POST /api/v1/daemons/:id/git-synchronization` records supervisor-verified ancestry.
- `tw req get <id> --json` includes plan revision, evidence review, recovery policy,
  attempt count and recent control phases/reasons/deadlines.
- `tw req update <id> --recovery-policy '<json>'` explicitly configures retries.
- `tw req revalidate <id> --revision <n> --reason '<inspected evidence>'` records a
  human decision; an outdated revision conflicts.
- `tw req recover <id> <control-id> --revision <n> --reason '<verified outcome>'`
  authorizes recovery after manual inspection; it requires project management.

Web requirement workflow panels display planning/evidence and recovery state.
New supervisors require `livePlanControlSupported` in server negotiation and
advertise `live-plan-v1`; acquisition refuses clients missing that capability.
The protocol deliberately fails closed across incompatible client/server upgrades.

## Reproducible local verification

Run `pnpm test:execution-recovery-postgres` with Docker available. The runner
creates and removes a disposable loopback PostgreSQL instance; it does not use
the configured application database. This suite checks migration replay, concurrent
planning edits, durable SSE replay, duplicate and out-of-order acknowledgements,
stale revision rejection, healthy lane renewal, worker capacity release, bounded
cross-node takeover, old-node fencing, same-node return, manual recovery and Git
synchronization gates through authenticated REST requests.

Run the spawned supervisor/agent transport-fault checks with:

```bash
pnpm --filter @task-weaver/cli exec tsx --test --test-name-pattern='live plan' src/daemon-e2e.test.ts
```

These checks use local HTTP services and bare Git remotes. They drop a control
poll connection and an acknowledgement response after receipt was persisted,
then verify that the old child exits and a fresh run completes on retained files.
They do not substitute for acceptance on separate machines with independent
filesystems, actual network partitions and the owner's agent/Git providers.

Linux supervisors inspect process identity and process groups through procfs, including boot identity and kernel start ticks, so minimal BusyBox hosts do not require procps. Procfs must be readable; an unreadable process record blocks termination confirmation rather than being treated as a stopped process. Other POSIX hosts use their native process inspection.
