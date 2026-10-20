# Hosted capability contracts

Task Weaver exposes a small bootstrap and retrieves relevant summaries, files
and schemas on demand. One remote MCP connection or the `tw mcp serve` stdio
adapter is the client entry. Native client skill installation and dynamic tool
registration are not prerequisites for this path. A client must support MCP
tool discovery and calls; vendor-specific interfaces require separate verification.

## Identity, scope and immutable execution inputs

The shared schemas live in `@task-weaver/contracts/schemas/capabilities`.
References pair a kind (`skill`, `skill_package`, `memory`, `mcp_tool`, `plugin`)
with the resource UUID. Their stable address is `tw:KIND:UUID`. An address never
grants access. An external MCP tool uses its registry UUID rather than a possibly
colliding server/tool display name.

Scope is explicitly global, project or personal. Personal ownership is derived
from the credential; an agent cannot select another owner's identity. A project's
global inclusion option does not expand its grants. Discovery and manifest
schemas describe data contracts; they do not create a new permission system or
imply that every capability kind already has an endpoint.

Execution manifests pin an immutable version and SHA-256. Each has at most 32
dependencies; package/plugin dependencies require exact versions. Floating
selectors, duplicate dependencies and self-references are rejected. The resolver
must additionally reject transitive cycles, conflicting versions, missing
dependencies and graphs exceeding 100 nodes. Freeze the resolved hashes and
versions for one execution, but reauthorize every read/call. A pin or cache must
not retain access after revocation. Manifests contain no secrets, shell commands,
host paths or authority to launch a process.

## Availability and execution

Availability states refer to the actual operation, not just a registered name:

| Execution mode | Meaning |
| --- | --- |
| `instructions` | Guidance or package text can be read; this does not run scripts |
| `remote` | An authorized remote invocation path is operational |
| `isolated` | A separately managed isolated worker can execute the declared capability |
| `local_required` | A configured local bridge is required for machine/device access |

Unavailable results include a reason and remediation. Missing credentials,
dependencies, unhealthy servers, approvals or unsupported clients must not be
reported as ready. Plugin code and executable skills never run in API/Web
processes. Ordinary instruction reads remain useful without an execution runtime.

## Minimal bootstrap and budgets

`tw_context_bootstrap` is the inbound MCP starting point. Its additive response
includes a schema revision, permission-filtered read-tool hints, availability and
on-demand loading limits. Existing `transport`, `guidance` and `tools` fields
remain available. Use `tools/list` for the current full authorized catalog;
bootstrap does not inject every schema or skill body. Tool hints are not a
promise that an arbitrary resource ID is authorized.

Initial budgets for the capability path are:

| Item | Budget |
| --- | --- |
| Serialized bootstrap data | 4 KiB; no more than 12 tool hints |
| Summary discovery | At most 20 results and 16 KiB total |
| Dependency graph | At most 32 direct dependencies and 100 resolved nodes |
| Package text read | Existing 32 KiB per-file limit |
| Local fixture warm bootstrap | p95 at most 1 second over 10 sequential reads |
| Local fixture stdio first bootstrap | At most 5 seconds including subprocess startup |

The existing skill-search endpoint retains its compatibility contract; summary
and graph budgets above are enforced by new capability discovery/resolution
paths as those paths are implemented. The bootstrap budget is enforced now.
Report measured HTTP/stdio setup, cold/warm latency, context bytes and failure
behavior using real clients and a disposable database. Timing budgets describe
the local acceptance fixture, not an external network/provider SLA. Later hosted
execution acceptance must compare warm proxy overhead and cold starts against
direct use on the same runner, with workload-specific limits.

## Compatibility and current coverage

Generic official-SDK clients can discover tools and call the bootstrap over
HTTP or the real CLI stdio subprocess. This does not certify a particular client
UI, native skill loader, OAuth-only client or dynamic schema refresh behavior.
Use the ordinary tool-call path when a client's native loading features differ.

Skill text and package reads already have scoped inbound tools. Memory services
and external MCP registry calls exist through REST/CLI, but should be advertised
through the inbound bootstrap only once their corresponding inbound tools are
implemented. Isolated executable skills and plugins require their own runtime
proof. Runtime discovery is the source of availability; release notes record
historical feature boundaries.
