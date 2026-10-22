# Unified MCP registry access

One Task Weaver HTTP connection or `tw mcp serve` exposes scoped memory, skill
packages and external MCP registry tools. Clients do not need to install each
external server. External tool schemas are retrieved on demand:

1. Call `tw_mcp_search` with an intent and optional project/personal inclusion.
   Results contain at most 20 summaries within 16 KiB, stable registry UUIDs and
   schema hashes. They contain no complete tool schemas or server credentials.
2. Call `tw_mcp_tool` with the selected `toolId` to read its schema (up to 32 KiB),
   read-only classification, target-project argument and exact `schemaHash`.
3. Call `tw_mcp_call` with that ID/hash, reviewed `arguments` and `confirmed: true`.
   Arguments are limited to 16 KiB. Outputs are untrusted data subject to the
   common MCP response budget. A tool error remains inside the external result.
   Successful dispatch results include `_meta["task-weaver/auditId"]` to locate
   their registry audit entry without logging arguments or output.

The bridge uses existing registry authorization, connection partitioning, target
checks, approvals and audit services. It rechecks schema pins while preparing
actual invocation. Disabled, expired, denied or inaccessible tools cannot be
invoked from cached discovery. A read-only Task Weaver connection cannot dispatch
external calls, regardless of the external tool's annotation.

The existing target policy can return an approval request. After authorized
review, pass its ID as `targetApprovalId`. If an administrator also protects the
`tw_mcp_call` facade itself, its separate approval ID uses `approvalId`; these
approvals bind different operations and cannot substitute for one another.

Network waits run outside the authorization lifecycle transaction. The bridge
never automatically retries a dispatched call. After a timeout, inspect the
external system before deciding whether to retry a write. Outbound connections
carry a forwarding marker; Task Weaver rejects marked inbound MCP requests to
prevent forwarding loops between Task Weaver endpoints. An arbitrary independent
external service remains responsible for its own internal recursion controls.

Server registration, synchronization, credential configuration and the explicit
local bridge remain available through REST/CLI. Discoverability is subject to live
server health and grants. The bridge does not provision runtimes or install dependencies automatically.
Approved server-side stdio profiles use [hosted MCP runtimes](mcp-hosted-runtimes.md);
registration alone does not establish readiness.

## Readiness, deadlines and admission

`tw_mcp_readiness` or `tw mcp readiness SERVER_ID --json` returns scoped
configuration and observed connection state without exposing headers, Secret
values or launching a tool. The management page shows the same status, remediation
and observation time, and accepts approved hosted profile references. Managers
can inspect an unavailable registration even when tool schemas cannot load.
Remote credential validity remains `unknown` until the upstream service accepts
an operation; a registered name does not establish OAuth readiness.

`tw_mcp_call.timeoutMs` is 100–25000 milliseconds (default 25000). Cancellation
and deadlines reach downstream SDK requests and cancel local mailbox waits. A
remote write may continue or commit despite a disconnected or cancelled client;
inspect external state before deciding to retry. SDK cancellation notifications
are best effort on stateless transports; a bounded call deadline remains the
fallback. No dispatched tool call is automatically replayed.

Per API host, each actor/server pair permits four active invocation requests,
with 32 per server and 64 overall. Admission has a burst of 20 requests per pair
and refills at five per second. `busy` means admission failed before dispatch;
REST returns 429 with `Retry-After`. These host-local limits supplement existing
credential grants and do not claim a distributed quota across replicas. Memory
and skill reads are outside this external-tool budget.

Failed connection initialization uses a bounded passive cooldown from one to
30 seconds, partitioned by credential/configuration. An explicit later call or
synchronization may reconnect; unrelated connections remain usable. Successful
initialization resets the cooldown. Credential, policy, profile, schema and
configuration changes are still checked for each operation.
