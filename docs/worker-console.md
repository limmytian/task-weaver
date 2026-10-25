# Worker console observation

The daemon page can request recent diagnostic output from a currently executing
worker. Open the console for a bounded snapshot. Select **Follow live** to request
later output. Stop, close or hide the page to cancel demand. **Pause scrolling**
only changes the display; it does not suspend the process. Filters and copying
apply to the displayed text. Output is diagnostic information, not proof of task
completion, capability use or a stuck process.

## Transport and deployment

The daemon uses its existing execution-control polling tick to retrieve short-lived
console requests. It returns batches by authenticated HTTP POST. No viewer demand
means no console-body upload. Polling works behind NAT; no daemon listening port or
new permanent output connection is needed. Observation failure is isolated from
execution. SSE remains available for existing controls and does not carry bodies.

Single-process API deployments use the default `local` route. Multiple API
processes require a unique `TW_CONSOLE_NODE_ID` for each process and the same
`TW_CONSOLE_PEERS` JSON map of route names to operator-trusted per-process HTTPS
origins. At most eight peers are supported. Loopback HTTP is permitted for local
fixtures. Do not use a load-balanced address as a per-process origin. Credentials
and original CSRF headers are forwarded only to those configured peers, and are
verified there again. Redirects and caller-provided peer URLs are rejected.

Control polling collects request metadata from these peers. Session reads,
cancellation and responses route to the owner process. Boot and random request
identifiers prevent a restarted process from reviving an old session. There is no
automatic peer discovery or durable replay. A missing/unreachable route is an
explicit unavailable result. Configure peers before using multiple processes;
without distinct routes, requests may fail closed as history unavailable.

Console routes must be excluded from proxy body logging, payload tracing and
response recording. Responses are `no-store`. The implementation sends neither
bodies nor body hashes to database, activity, telemetry, durable events or PG
NOTIFY. It uses no shared persistent message broker.

## Authority and boundaries

Observers need a current human credential with `resource.read` and `audit.read`
for the exact requirement. Fleet visibility or instance administration alone does
not grant output access. Sessions bind to the opening credential kind/ID and actor.
Every read, renewal, dispatch and response rechecks current access. Denied sessions
are deleted; regrant requires a fresh request. Already delivered bytes cannot be
recalled. Execution delegations cannot observe or upload console output.

Producer checks reuse the current daemon lease, requirement/run ID, worker index,
generation and planning fence. The selected active task must still belong to the
requirement. A capture UUID additionally separates successive model subprocesses
inside one requirement lane; an old console cannot silently attach to a new
capture. Index reuse, replanning and stale-node return never migrate a session.
Request revisions reject duplicate/late responses.

Current capture covers executor workers. Codex JSONL stdout allows emitted command
output and final assistant messages; reasoning, prompts, arguments and unknown
events are omitted. Command output is labeled as the model process's stdout;
Codex may aggregate a nested command's stdout/stderr before emitting it. Process
stderr stays a separate diagnostic stream. Other provider formats explicitly report unsupported capture for both streams. Reviewer/merger console capture is unavailable.
No stdin, remote terminal or arbitrary command/file interface is added.

## Limits and missing history

| Layer | Bound |
| --- | --- |
| Daemon current process | 256 KiB / 1024 frames / 60 seconds, combined streams |
| Frame / batch | 4096 UTF-8 bytes / 32 KiB |
| Structured record parser | 64 Ki characters; larger/incomplete records omitted |
| API | 128 sessions per process, four per credential/run; one pending batch per session |
| Initial snapshot | 15-second deadline |
| Follow renewal | 10-second lease; 15-minute absolute session lifetime |
| Browser | 256 KiB / 1024 frames |
| Control tick | One serialized observation tick per worker; at most four batch responses |

Reopen after the absolute deadline. A snapshot is a bounded batch, not a complete
transcript. Slow readers may lose batches; sequence discontinuities and truncation
are shown. No unbounded queue or child-process backpressure is introduced. Bodies
expire from API memory even if no further request arrives. Daemon buffers clear
at managed-process exit/authority abort and restart. Uncaptured, expired and
restart-lost output cannot be reconstructed. In-flight responses after cancellation
may reach the API but are rejected. Timeouts and disconnected states are explicit.

Streaming UTF-8 decoding, exact known-secret masking across chunk boundaries and
terminal-control removal run before text enters the output ring. Secret rotation
updates the known set. Partial possible-secret prefixes are withheld and discarded
at close. Excessive known-secret inventories fail capture closed. This does not
claim detection of every arbitrary secret a command might print. Browser rendering
uses text nodes, with no HTML, Markdown or terminal evaluation.

## Verification

Run `pnpm exec tsx --test apps/cli/src/worker-console*.test.ts` for bounded decoding,
filtering, redaction and observer-isolation checks. Run
`node scripts/verify-worker-console-postgres.mjs` for disposable PostgreSQL and
actual two-API HTTP routing, live authorization, expiry, restart, run fences and
durable-sink inspection. It uses an existing local image with `--pull=never`.
Actual daemon/model verification requires a separately applicable isolated runtime,
provider authentication and bounded execution authorization. Do not treat source
checks, emitted text or an exit code as task-quality or capability-adoption proof.

The opt-in `pnpm exec tsx scripts/verify-real-worker-console.mts --confirm-one-local-model-turn` harness runs one actual installed Codex model turn in a disposable project/database, using a temporary profile containing only existing ChatGPT authentication and the selected model. It does not install runtimes or use remote Git. It checks zero-demand uploads, recent and subsequent output, last cancellation, task completion, durable sentinel absence and credential/file cleanup. Receipts omit output bodies and monetary estimates. Run only with applicable local model/auth/database authorization.

Use `--verify-synthetic-daemon` instead of the model confirmation flag to run the same daemon lifecycle with a synthetic executor and no provider authentication or model spend. This also checks that output sentinels are absent from captured daemon operational output; it is not actual model evidence.
