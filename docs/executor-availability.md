# Executor availability and quota recovery

Task Weaver distinguishes managed Agent identity, daemon liveness, local executor
credential profiles and reported run token totals. Token totals do not measure
remaining subscription allowance. An online daemon can be unable to acquire work
because its eligible executor resources are blocked.

## Provider capabilities

The 0.3.4 adapter inventory was checked on 2026-10-08. Status queries never launch
model prompts, read private credential stores, redeem reset credits or purchase
credits. Runtime support is conservative: provider error envelopes and anchored
diagnostics are recognized; arbitrary assistant/tool text, HTTP 429 alone, silence
and exit codes do not establish quota exhaustion.

| Tool | Local inventory | Nonbillable proactive quota query | Runtime resource detection |
| --- | --- | --- | --- |
| Codex | CLI 0.161.0 | `app-server --stdio`, initialize, `account/rateLimits/read`; feature-negotiated and bounded | Terminal error/turn.failed envelopes; anchored usage-limit diagnostics |
| Claude | Not installed | Unsupported; allowance is unknown | Provider error envelopes and anchored limit diagnostics; not a claim of installed-version coverage |
| agy | 1.2.8 | Unsupported; no verified vendor status contract | Explicit provider error envelopes/diagnostic codes only |
| aider | Not installed | Unsupported; allowance is unknown | Explicit provider error envelopes/diagnostic codes only |
| cursor | Desktop CLI 3.8.11 | Unsupported; this binary does not establish Agent CLI quota-query support | Explicit provider error envelopes/diagnostic codes only |

The [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
describes the quota method, bucket IDs, used percentages, window durations and Unix
reset timestamps. Each returned primary/secondary window is retained separately.
Missing counters, unsupported authentication modes and failed queries remain
unknown. Bucket-to-model mapping is not inferred. An exhausted returned bucket
conservatively blocks that configured tool profile; use separate explicitly
configured profiles where model/provider resource boundaries differ.

[Claude error documentation](https://platform.claude.com/docs/en/api/errors) and
[Cursor output documentation](https://cursor.com/docs/cli/reference/output-format)
provide error/output context; they do not establish a portable subscription quota
inspection API. Additional versions must be verified before expanding detection.

## Inspect and recover

```bash
tw daemon executors <daemon-id> --json
tw daemon executors <daemon-id> --history --json
tw daemon executors <daemon-id> --refresh codex --json
```

REST exposes `GET /api/v1/daemons/:id/executors`, `GET .../executors/history`,
`POST .../executors/observations` and `POST .../executors/:tool/refresh`.
The Daemons page exposes the same authorized observations, freshness, remaining
windows, next check and bounded history. Profile inspection requires the daemon's
verified executor identity, or its human manager with audit access to every
execution project. Refresh/retry requires project management authority. A pending
refresh is consumed by the online daemon during its next polling cycle; it is not
an instruction for the API server to execute a local binary.

Rate limits and exhausted allowance enter persistent cooldown. Billing and
authentication failures require operator action. A stale quota snapshot displays
unknown remaining allowance; an existing confirmed interruption still gates
scheduling until a new status check verifies recovery. Unsupported checks do not
clear a block. Rechecks use reset/retry hints when known, otherwise capped backoff
and jitter. Routine queries are cached for at least one minute and coalesced per
profile in each daemon process. Query lifetime is bounded to eight seconds plus a
one-second termination grace period, with bounded output retention.

After correcting a provider problem, an authorized operator can explicitly allow
a retry through the Web confirmation dialog or:

```bash
tw daemon executors <daemon-id> --resume claude \
  --expected-version <observed-version> --reason "Provider access corrected" --json
```

The matching REST action is `POST .../executors/:tool/resume`, accepting
`expectedVersion` and `reason`. A stale version is rejected. This records an
unverified retry authorization and preserves the interruption timeline; it does
not assert available quota. Normal worker concurrency and process timeout bounds
continue to apply. A successful newer process or supported positive status query
can verify availability. An older in-flight success cannot overwrite a newer
blocking observation. No operation automatically repairs credentials or spends
money.

## Profile identity, sharing and fallback

By default, an opaque profile reference is derived from the configured local node
ID and tool name. It is stable across process/daemon restarts. Separate node IDs
remain isolated. A changed credential context must use a new explicit profile
reference (and a new daemon ID if an existing binding would change).

Optional local CLI configuration can declare opaque references:

```json
{
  "executorProfiles": {
    "codex": { "profileId": "work-subscription", "poolId": "explicit-shared-pool" }
  }
}
```

References contain no secrets. Sharing requires explicit matching pool references,
the same verified managed Agent actor and tool. Matching local profile references
share recovery state across daemon instances. Unrelated actors/nodes are never
inferred to share accounts. Cross-actor quota sharing is not supported. A local
configuration mapping never switches the actual provider account or credential.

Automatic fallback is disabled by default. Project managers may PATCH the existing
project endpoint with a finite `executorFallbackPolicy`:

```json
{
  "executorFallbackPolicy": {
    "allowedTools": ["codex"],
    "authenticationMode": "subscription",
    "allowPaidApi": false
  }
}
```

Fallback still intersects the task's executor/capability constraints and the
existing model-tier routing. Only a fresh, verified available subscription profile
is eligible. Unknown authentication modes and paid API profiles are denied; paid
API/account switching and arbitrary model substitution are not supported by this
policy. Reviewers retain their explicitly selected review tool and do not switch
providers automatically. Unaffected tasks with other explicitly eligible tools
continue normally.

## Recovery guarantees and compatibility

A terminal resource diagnostic stops only that process, including tools waiting
for reset or exiting zero after an error. The daemon preserves dirty workspaces
and reconciles active work under the existing fenced lease before release.
Completed tasks, terminal slices and completed repository deliveries remain
complete. Conflicted/missing workspaces require review. Resource interruptions do
not consume progress or repository delivery failure retry budgets. A blocked AI
review does not issue approval/findings or create a code-fix task.

Availability transitions emit authorized invalidation events and deduplicated
first-block/all-blocked/action-required/recovered notifications. Unchanged polling
stays quiet. Status history is bounded to the latest 50 records per inspection;
observations and events remain durable in PostgreSQL.

Migration `0061_executor_availability` adds profile observations, history and the
nullable project fallback policy. Existing project/task statuses and token
accounting remain unchanged. Older daemon clients do not report availability and
are shown as unknown; upgrade all participating workers to enforce this feature.
No production daemon activation, release publication or deployment is implied.

Tasks with an explicit requested model or provider are not eligible for automatic cross-tool fallback; compatibility cannot be inferred from quota buckets. Expired provider reset timestamps remain unknown until refreshed.
