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
server health and grants. This bridge does not provision server-side stdio
workers, install dependencies, or claim that all configured services are ready.
