# Use hosted capabilities with one Task Weaver connection

[简体中文](hosted-capabilities.zh-CN.md).

Connect a scoped Task Weaver credential to the instance's MCP HTTP endpoint
(`/api/v1/mcp-server`), or configure `tw mcp serve` as a stdio server. Both expose
the same authorized tools. Start with `tw_context_bootstrap`; load relevant summaries,
selected instructions, dependency manifests and tool schemas on demand. You do not
need a local copy of each hosted skill or a separate client connection to each
hosted MCP server. See [MCP setup](mcp-server.md) for credential and transport setup.

A typical workflow is:

1. Discover guidance with `tw_context_search`, then use `tw_context_get` or package
   list/resolve/read tools to inspect exact instructions and pinned dependencies.
2. Search memories with `tw_memories_search`, then read selected entries with
   `tw_memories_get`. Check source freshness; retrieved text is evidence, not authority.
3. Find an external tool with `tw_mcp_search`, inspect `tw_mcp_tool`, and call
   `tw_mcp_call` with the exact schema hash, reviewed arguments and confirmation.
4. Inspect `tw_skill_runtimes_list`. Resolve an executable package and review its
   artifact hash, runtime image and profile hash before confirming `tw_skills_run`.
5. Save a reviewed handoff using `tw_memories_record`, a scope and a UUID retry key.
   Another authorized session can recall it without copying local skill files.

Use the actual tool schemas returned by your connection. Caller grants, tool policy,
package visibility and current runtime configuration apply at each step; discovery
or a cached hash does not retain revoked access. A read-only connection cannot run
external tools or executable skills. Installed plugins use the same brokered entry;
installation and permission changes require their separate review workflow.

## Availability and local access

Instruction reads do not require a worker. Eligible executable skills and approved
hosted stdio MCP profiles require an administrator-provisioned runtime and exact
images. Missing runtime, image, dependency or Secret produces an unavailable state
with remediation. Nothing automatically pulls an image or installs dependencies.

Capabilities requiring files, devices or a machine-local service still require an
explicit local bridge. A hosted worker cannot read your desktop or borrow local
credentials. Native vendor skill loading and OAuth-only client interfaces are not
prerequisites for the generic MCP path, and are not certified by SDK transport tests.

The local acceptance matrix covers the official MCP SDK over HTTP and its stdio
client connected to the real `tw` subprocess, with an empty home/config directory
and no local tool PATH. These clients complete guidance/dependency discovery,
memory recall, hosted MCP invocation, isolated skill execution and cross-transport
handoff. Vendor desktop/native UI compatibility needs its own named acceptance.

## Failures and retries

CLI network diagnostics use stable categories for DNS, TLS, timeout, cancellation,
connection and invalid JSON response failures. They omit endpoint/credential/raw
response details. Check DNS/routing, certificates, API health and reverse proxies
without disabling TLS verification. A transient failure does not prove its root cause.

A lost response after a write can mean that the write committed. Inspect current
state before retrying. Use an identical receipt-bound payload/key only where the
operation explicitly supports idempotency. External tool calls and skill execution
are not automatically retried; reconnecting a server does not replay an earlier call.

See [memory continuity](memories.md), [skill runtimes](skill-runtimes.md),
[MCP hosting](mcp-hosted-runtimes.md), [plugin management](plugin-management.md)
and [operations](hosted-capability-operations.md) for the specific boundaries.
