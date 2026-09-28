# Daemon Production Validation

The production gate separates deterministic reliability coverage from credentialed, destructive smoke runs. Fast pull-request checks use an accelerated virtual clock; scheduled and release-candidate jobs increase the same iteration count and then run disposable real-provider workflows.

## Accelerated Lease and Fault Gate

Run the deterministic gate locally:

```bash
pnpm test:daemon-reliability
```

The default lease soak executes 21,600 one-second virtual ticks (six hours) across executor, reviewer, and merger identities. It injects repeatable process-heartbeat loss, Requirement-heartbeat loss, process death, lease expiry, reassignment, stale writes, and base-publication races. The gate requires recovery after transient uncertainty and rejects duplicate owners, accepted stale writes, and stranded lanes.

Scheduled jobs can increase the duration without changing test semantics:

```bash
TW_DAEMON_SOAK_ITERATIONS=259200 pnpm test:daemon-reliability
```

That setting represents 72 virtual hours. The loop uses no wall-clock sleeps, external services, or random failures.

The fault injector covers API, database, Git, credential, AI, check, and forge boundaries. A `before` fault proves that no side effect occurred. An `after` fault simulates a lost response after success; retrying with the same idempotency key must observe the existing result rather than repeat the side effect.

## Gate Invariants

- One unexpired Requirement lane has at most one owner.
- A generation change fences all mutations from the prior owner.
- Process or lane heartbeat uncertainty fences writes until a successful renewal.
- Process death becomes reclaimable only after expiry, and shutdown leaves no active lease.
- Base publication retries are bounded.
- Each fault produces a normalized automatic retry, follow-up, or manual action; no lane becomes ownerless while still considered active.

## Disposable Real Pipeline Gate

The credentialed gate runs the actual executor, reviewer, and merger processes with a real AI CLI. It creates a disposable Task Weaver project, two independent Requirements, and one private repository on each selected forge. Every Requirement spans every disposable repository, creates a provider pull request, receives an approval from a distinct reviewer identity, and merges through a protected `main` branch. Success requires every Requirement to be `done` and every repository delivery to be `merged`.

The command is deliberately disabled unless `TW_REAL_SMOKE=1` is present:

```bash
TW_REAL_SMOKE=1 pnpm test:daemon-real-smoke
```

The production job requires a dedicated runner with the pinned Node.js version,
pnpm, the configured AI CLI (Codex by default), `gh`, `tea`, Git, and Task Weaver
repository credential profiles. Operators may run the command manually or
configure a private scheduled job on their own infrastructure. The public
repository does not include a credentialed production-smoke workflow.

Configure these variables and secrets on the runner or workflow:

| Name | Purpose |
|---|---|
| `TW_API_URL`, `TW_API_KEY` | Dedicated Task Weaver smoke instance and agent key |
| `TW_SMOKE_GITHUB_OWNER`, `TW_SMOKE_GITHUB_OWNER_TYPE` | Disposable GitHub repository owner (`user` or `organization`) |
| `TW_SMOKE_GITHUB_CREDENTIAL_PROFILE` | Non-secret Task Weaver credential profile reference used by daemon workers |
| `GH_TOKEN` | GitHub repository creator, PR author, and merge credential |
| `TW_SMOKE_GITHUB_REVIEW_TOKEN` | Token for a different GitHub actor that approves the PR |
| `TW_SMOKE_GITEA_HOST`, `TW_SMOKE_GITEA_OWNER`, `TW_SMOKE_GITEA_OWNER_TYPE` | Disposable Gitea target |
| `TW_SMOKE_GITEA_CREDENTIAL_PROFILE` | Non-secret Task Weaver credential profile reference used by daemon workers |
| `GITEA_TOKEN` | Gitea repository creator, PR author, and merge credential |
| `TW_SMOKE_GITEA_REVIEW_TOKEN` | Token for a different Gitea actor that approves the PR |

Optional controls are `TW_REAL_SMOKE_AI_TOOL`, `TW_REAL_SMOKE_TIMEOUT_SECONDS` (60–7200), `TW_REAL_SMOKE_POLL_SECONDS` (1–60), `TW_REAL_SMOKE_REQUIREMENTS` (1–5), and `TW_REAL_SMOKE_PROVIDERS`. The reviewer tokens must differ from the primary tokens. Tokens are sent only in authorization headers and inherited process environments; they are never written to the pipeline configuration, command arguments, Task Weaver entities, or the final JSON report.

The gate configures one required pull-request approval and prevents direct pushes to `main`. It archives the Task Weaver project and catalog entries and deletes every remote repository after success. Failure also cleans up by default; set `TW_REAL_SMOKE_KEEP_ON_FAILURE=1` only for a supervised investigation, then delete retained resources manually.

The local E2E suite exercises the same aggregate delivery contract without external credentials. It advances one repository base after review, proves that the first repository remains merged while the second produces a conflict follow-up, resolves and republishes only the failed branch, and finishes the Requirement without changing the successful sibling commit.

## SLO Dashboard and Alerts

The daemon control plane displays the rolling 24-hour dashboard. The API and release job use the same report at `GET /api/v1/daemons/slo?windowHours=24`; a release candidate uses a 168-hour window. Missing samples for a release-blocking objective block the release instead of appearing healthy.

| Objective | Target | Minimum release samples | Alert response |
|---|---:|---:|---|
| Acquisition latency p95 | ≤ 30 seconds | 2 | Investigate queue eligibility, daemon capacity, and claim contention |
| Heartbeat gap p99 | ≤ 45 seconds | 1 | Page at > 90 seconds; fence writes before restart |
| Completion rate | ≥ 95% | 2 terminal Requirements | Page below 90%; inspect cancelled and stranded lanes |
| Retry recovery rate | ≥ 90% | 1 retry | Inspect normalized outcome, retry policy, and next-attempt scheduling |
| Stranded lanes | 0 | Always evaluated | Page immediately |
| Review duration p95 | ≤ 30 minutes | 2 reviews | Inspect AI/check runtime and provider synchronization |
| Merge latency p95 | ≤ 10 minutes | 2 merges | Inspect branch protection, approvals, checks, and stale heads |
| Recovery time p95 | ≤ 5 minutes | 1 recovered retry | Inspect backoff, wake delivery, credentials, and worker capacity |

Retry and recovery metrics show `no_data` when no retry occurred in the window. They remain visible but do not block an otherwise clean initial release; the deterministic fault gate remains mandatory and supplies retry-invariant coverage.

### Acquisition and Stranded Lanes

1. Open the Executor, Review, Merge, Blocked, and Manual queue views and record the reason codes for the oldest Requirement.
2. Confirm that a compatible role daemon is online and not paused or draining.
3. Check dependency, ordered-slice, model-tier, capability, retry-time, and credential-policy blockers before changing state.
4. For an expired owner, wait for the lease to expire, verify that the old generation is fenced, and allow normal reacquisition. Do not delete a live claim manually.

### Heartbeat and Lease Health

1. Pause acquisition for the affected daemon or pipeline.
2. Compare the process heartbeat with each active Requirement claim heartbeat. An uncertain process or lease must not write.
3. Drain the process. If it does not stop within the configured grace period, terminate it and wait for claim expiry before replacement.
4. Resume with a new process identity, verify a new lease generation, then confirm heartbeat gap and stranded-lane alerts clear.

### Completion and Stranded Lanes

1. Inspect the Requirement timeline and every repository delivery. Completion requires each link to be `merged` or `unchanged`.
2. Route automatic failures only after `nextAttemptAt`; create or finish an `after_follow_up` task before retrying; hand manual outcomes to an operator.
3. Never mark the aggregate Requirement done to silence an alert. Repair the failed repository link and let the state machine recompute completion.

### Review and Merge Latency

1. Inspect local review runs, required checks, provider approvals, and the reviewed head commit.
2. If the head changed, return to review. Never override a stale-head failure.
3. For protected branches, verify the independent approval actor and provider check evidence. Retry only infrastructure failures; policy failures require explicit remediation.

### Retry and Recovery

1. Start with the normalized failure code, retry policy, retry role, retry phase, and last operation checkpoint.
2. Confirm idempotency after response loss before replaying the operation.
3. When retries exhaust, move to a documented manual handoff instead of extending the loop indefinitely.
4. After recovery, verify that successful sibling repositories retained their commit, PR, review, and merge checkpoints.

## Release Evidence and Checklist

The scheduled workflows run the deterministic reliability suite and workspace type checks, execute the credentialed disposable smoke, query the live SLO report, and then run:

```bash
tw daemon pipeline release-gate \
  --deterministic-passed \
  --smoke-evidence .artifacts/real-smoke.json \
  --commit "$RELEASE_COMMIT_SHA" \
  --output .artifacts/daemon-release-evidence.json
```

The command writes a schema-versioned, SHA-256-digested evidence artifact and exits nonzero unless all checklist invariants pass:

- single-owner acquisition, generation fencing, and heartbeat fencing;
- bounded normalized recovery for API, database, Git, credential, AI, check, and forge boundaries;
- multi-repository partial success, conflict follow-up, and preserved sibling checkpoints;
- real AI execution and review on the exact release commit;
- protected GitHub and Gitea pull requests with independent approvals and confirmed merges;
- complete cleanup of disposable Task Weaver and forge resources;
- passing acquisition, heartbeat, completion, stranded-lane, review, and merge SLO evidence;
- no critical production alerts.

Do not promote a commit from the deterministic test result alone. The real-smoke evidence commit must match the release candidate, must be less than 24 hours old, and must cover at least two Requirements and four merged deliveries across both providers. Retain the uploaded release evidence with the deployment record.
