# Agent token usage

Task Weaver accounts for one entire agent process from launch to exit. A fresh
execution, review, rework or retry process has a new UUID. The ledger stores one
compact `agent_usage_runs` row per process. It does not store model-call records,
raw usage events, prompts, responses or credentials. It does not estimate tokens
or calculate money, billing or spending limits. Embedding usage remains separate.

## Contract and attribution

The shared contracts package validates REST and CLI inputs. Counters are nullable
nonnegative safe integers: `inputTokens`, `outputTokens`, `cacheReadTokens` and
`cacheWriteTokens`. Explicit zero means reported zero; absence remains null.
`cacheSemantics` is `included`, `additional` or `unknown`. Counters are displayed
separately and never added together. Provider/model identifiers can be `multiple`
or `unknown`; a configured model is not evidence of the model actually used.

Coverage is `complete`, `partial` or `unknown`. Complete requires reported input
and output totals and successful termination. Failed, cancelled and still-running
processes retain reported counters as partial. A process with no reported counters
is unknown, even when it succeeds. Unsupported cache counters remain null without
preventing complete input/output coverage.

Each row has immutable process identity, project, requirement, optional task,
source execution identity, agent, phase, start time and authenticated reporter.
Daemon executions and reviews are requirement-scoped because they can share work
across tasks. They appear once in requirement/project totals and are excluded
from individual task totals. Ti project-task attribution is derived from its run
and task in the database; a reporter cannot supply a different project or task.
Personal and targetless Ti work is outside this project-scoped ledger.

Snapshots replace the same row using an increasing revision. Exact replay and
older revisions do not increment totals. Conflicting payloads at the same revision,
changed attribution, decreasing counters and terminal-process restarts are rejected.
Concurrent first reports and updates serialize through insert-on-conflict and a
row lock. Registered terminal runs can accept later reports that enrich their totals
without changing outcome or end time. A new retry must register a new process UUID.

## Daemon collection

Daemon execution and AI review use the metered runner. It observes raw stdout
before redaction or bounded log retention, decodes fragmented UTF-8/JSONL, bounds
individual lines at 1 MiB, and retains counters rather than parsed events. It saves
an initial unknown registration, throttled partial snapshots and a final summary.
Reports use the existing API-key configuration, with a 2.5-second timeout and at
most one periodic report in flight. A failed report warns once and never changes
the agent's result. Unregistered processes after an accounting outage cannot be
reconstructed from text or old logs.

Only the Codex adapter is verified in this implementation. `turn.completed.usage`
contains cumulative thread totals, so duplicates and later snapshots replace
rather than add. `cached_input_tokens` overlaps input. An optional
`cache_write_input_tokens` is retained when present. Malformed, oversized or
regressing events make surviving reported totals partial; absent usage is unknown.
The JSONL usage contract does not identify the actual provider/model, so those
remain unknown. Other daemon executors remain unknown until their structured
formats are independently verified.

Source verification on 2026-10-02:

- [Official non-interactive JSONL documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
- [Codex event schema](https://github.com/openai/codex/blob/d91294c39edb93d204926b33f21310dc968edc34/codex-rs/exec/src/exec_events.rs).
- [Codex JSONL processor uses cumulative totals](https://github.com/openai/codex/blob/d91294c39edb93d204926b33f21310dc968edc34/codex-rs/exec/src/event_processor_with_jsonl_output.rs).
- [Codex cache overlap semantics](https://github.com/openai/codex/blob/d91294c39edb93d204926b33f21310dc968edc34/codex-rs/protocol/src/protocol.rs).

## Ti reporting and Partners boundary

Actual Ti runtimes may send compact cumulative snapshots directly to TW; Partners
availability, Gateway metering and a forced model proxy are not prerequisites.
The API accepts no transcript or per-call payload. It requires a validated API
key belonging to the assigned agent or the Ti run creator. Initial registration
requires the current attempt, worker and active lease. Registered attempts can
accept late reports after completion or after a newer attempt starts.

`tw ti worker run-once` registers a launched process as unknown, exposes
`TW_USAGE_PROCESS_ID`, `TW_USAGE_STARTED_AT`, `TW_TI_RUN_ID`, `TW_TI_ATTEMPT` and
`TW_TI_WORKER_ID` to the runtime, and finalizes without overwriting reported totals.
A runtime reuses that process identity and start time for every snapshot, then
reports its own final coverage. The runner does not infer token usage from Ti's
unverified stdout format. Dry runs are not registered.

Gateway remains execution infrastructure. No Partners service or protocol change
is required. A Gateway shell job with no actual agent report contributes no token
counter. Known started Ti attempts without usage registrations are shown as
unreported, including Gateway work. The diagnostics use existing Ti retry metadata
and cannot recover exact missing process start times or expired-lease relaunches.
They are a conservative coverage warning, not an invented usage measurement.

## REST and CLI

All usage REST reads/writes require a validated API key. Keys retain the existing
shared-instance access boundary; this feature does not introduce project-membership
ACLs. Every read requires an explicit project scope, validates requirement/task
membership and scopes process lookup to that project. Reporter ownership protects
daemon row updates. Registration additionally requires its active daemon lane.
The Web exposes read-only tRPC procedures behind the existing Web instance boundary;
usage reporting is not exposed through public tRPC mutations.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/agent-usage/runs` | Register/update daemon process snapshot |
| `GET /api/v1/agent-usage/runs?projectId=...` | Paginated process rows |
| `GET /api/v1/agent-usage/runs/:processId?projectId=...` | One process in project scope |
| `GET /api/v1/agent-usage/summary?projectId=...` | Unpaginated aggregate |
| `POST /api/v1/pi-agent/runs/:runId/usage` | Register/update actual Ti process snapshot |
| `POST /api/v1/pi-agent/runs/:runId/usage/:processId/finish` | Preserve latest totals while finalizing a local runner |

Query filters: `requirementId`, `taskId`, `since`, `until`, `phase`, `completeness`,
`limit` (1–100) and `offset`. The date range uses process start time, with inclusive
`since` and exclusive `until`. Summary results ignore pagination and return exact
numeric sums as decimal strings, nullable when no process reports a counter.
Each counter includes its reporting-process count. Coverage combines complete
registered processes with known unregistered Ti attempts. The latter diagnostic
uses the entire selected project/requirement/task scope regardless of time, phase
or coverage filters because those missing process timestamps are unavailable.
Unregistered daemon processes and historical runs cannot be counted; this limit is
explicit in CLI/Web results. Coverage never represents a complete lifetime ledger.

```bash
# List whole-process runs and task/requirement/project totals
tw usage runs --project <project-id> --json
tw usage summary --project <project-id> --req <requirement-id> --json
tw usage summary --project <project-id> --task <task-id> --since 2026-10-02T00:00:00Z --json
tw usage run <process-id> --project <project-id> --json

# Report a compact Ti process snapshot
tw usage report-ti <ti-run-id> --file usage.json --json
```

Example `usage.json` (use the actual process/attempt identifiers):

```json
{
  "processId": "11111111-1111-4111-8111-111111111111",
  "workerId": "ti-worker-1",
  "attempt": 0,
  "startedAt": "2026-10-02T00:00:00.000Z",
  "endedAt": "2026-10-02T00:01:00.000Z",
  "outcome": "succeeded",
  "revision": 1,
  "summary": {
    "inputTokens": 1200,
    "outputTokens": 300,
    "cacheReadTokens": 800,
    "cacheWriteTokens": null,
    "cacheSemantics": "included",
    "provider": "unknown",
    "model": "multiple",
    "completeness": "complete"
  }
}
```

The Web Agent Usage page provides searchable project/requirement/task scopes,
local-time date filters, paginated runs, compact run details, counters and coverage.
A task total intentionally excludes shared requirement work.

## Validation and rollout

`node scripts/verify-agent-usage-postgres.mjs` provisions a disposable loopback
PostgreSQL/pgvector database, applies migrations twice, verifies authenticated
REST reporting, concurrent/replayed snapshots, retries, cancellation, late usage,
project isolation, attribution and coverage, then removes the container. It stores
no release artifacts or database backups. Unit tests cover fragmented/malformed
stdout, truncation, counter semantics and collection failures.

Migration `0046_agent_usage_runs` is additive. Existing Ti `costMetadata` is not
backfilled because infrastructure/cost metadata is not an agent token report.
The migration generator currently rejects a pre-existing malformed historical
snapshot, so the additive SQL/journal entry was authored explicitly and verified
with the real migrator. Production migration/deployment and a new release are
separate owner-authorized operations; this implementation does neither.

Validation completed on 2026-10-02: workspace tests, type checking and builds;
module-boundary and public-export tests; targeted Web lint and interaction checks;
the disposable PostgreSQL integration test; and a local browser walkthrough of
project/task attribution, unknown counters, run details and invalid date filters.
No production database, deployment or release was changed.
