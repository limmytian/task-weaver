# Inbound MCP server contract

This document specifies the 0.3.10 inbound interface and its tested acceptance
boundaries. See the [usage guide](mcp-server.md) for setup and the verified client
matrix. The outbound MCP Registry remains a separate feature.

## Protocol and implementation boundaries

Target published protocol revision: `2025-11-25`. Use the installed official
TypeScript SDK `1.31.0` for the first compatibility run; pin the tested SDK in
both adapter packages before shipping. Negotiate versions through the SDK rather
than accepting arbitrary client protocol headers. Revalidate this baseline when
running interoperability acceptance.

- Shared names, limits, result errors and policy live in
  `@task-weaver/contracts/schemas/mcp-server` without SDK or database imports.
- Share the tool catalog and schema construction through a dedicated public
  contracts module; keep SDK server registration in the API and CLI adapters.
- Remote endpoint: `/api/v1/mcp-server`, distinct from `/api/v1/mcp/*` Registry
  routes. Use the SDK Web Standard Streamable HTTP transport in the Hono runtime.
  Start with stateless JSON responses: no persistent sessions, subscriptions or
  resumable event store. Unsupported GET/DELETE requests return 405.
- Authenticated JSON tool adapter: `/api/v1/mcp-server/tools/:name`. Local
  clients use the existing CLI REST request helper against this fixed allowlist;
  the server executes the same authorized catalog as the protocol transport.
- Local entry: `tw mcp serve [--read-only]`, using the SDK stdio transport and the
  existing CLI `request` helper. Require configured API credentials before serving.
  stdout is protocol-only; initialization failures and diagnostics use stderr.
- Remote calls use `createResourceServices(verifiedIdentity)` and the request's
  database. Local calls use authenticated REST. Neither invokes shell commands,
  proxies arbitrary paths, or imports unguarded database services.

## Catalog and service audit

All tools use object inputs with `additionalProperties: false`. Reuse existing
Zod fields and refinements; omit identity, daemon lease, force, workflow override
and executor selection fields. Identifiers use the existing UUID schemas.
The `tw_` names below are fixed for both transports.

| Tools | Existing service / REST source | Input and output rule |
| --- | --- | --- |
| `tw_projects_list`, `tw_projects_get` | projectService; `/projects`, `/projects/:id` | Existing project filters plus bounded page; get by id |
| `tw_requirements_list`, `tw_requirements_get` | requirementService; `/projects/:projectId/requirements`, `/requirements/:id` | List requires projectId; use listRequirementsSchema; detail by id |
| `tw_requirements_create`, `tw_requirements_update` | requirementService; same routes | createRequirementSchema/updateRequirementSchema without workflow and lease controls; update takes id and patch |
| `tw_requirement_dependencies_list`, `tw_requirement_dependencies_add`, `tw_requirement_dependencies_remove` | requirementService; `/requirements/:id/dependencies[/:depId]` | Parent id plus createRequirementDependencySchema or dependency id; validate both resources |
| `tw_tasks_list`, `tw_tasks_get` | taskService; `/projects/:projectId/tasks`, `/personal/tasks`, `/tasks/:id` | Preserve listTasksSchema scope refinement; get by id |
| `tw_tasks_create`, `tw_tasks_update` | taskService; project/personal creation routes and `/tasks/:id` | Preserve createTaskSchema membership refinement; personal owner derives from credentials; update uses expectedVersion |
| `tw_tasks_status` | taskService.updateTaskStatus; `/tasks/:id/status` | id, status, optional reason; no force or daemon lease fields |
| `tw_tasks_claim`, `tw_tasks_heartbeat`, `tw_tasks_release` | claimService; `/tasks/:id/claim`, `/heartbeat`, `/release` | Duration validated to 1–1440 minutes; optional release reason; holder identity derives from credentials |
| `tw_task_comments_list`, `tw_task_comments_add` | taskService.getTaskDetail/addTaskComment; `/tasks/:id`, `/comments` | listTaskCommentsPage; bounded JSON tool adapter; add uses createTaskCommentSchema |
| `tw_task_dependencies_list`, `tw_task_dependencies_add`, `tw_task_dependencies_remove` | taskService; `/tasks/:id`, `/dependencies[/:depId]` | listTaskDependenciesPage; bounded JSON tool adapter; add uses createTaskDependencySchema; removal includes parent id |
| `tw_documents_list`, `tw_documents_get` | documentService; `/documents`, `/documents/:id` | Existing listDocumentsSchema; only authorized metadata and Markdown content; no attachment payloads |
| `tw_documents_create`, `tw_documents_update` | documentService; same routes | createDocumentSchema/updateDocumentSchema; owner identity cannot be supplied; update preserves expectedVersion |
| `tw_document_task_links_add` | documentService; `/documents/:id/task-links` | document id plus linkDocumentToTaskSchema |
| `tw_document_requirement_links_add` | requirementService; `/requirements/:id/document-links` | requirement id plus linkDocumentToRequirementSchema |
| `tw_search` | authorized search routes and documentService search | query, optional projectId, explicit project/personal scope, entity filter, document search mode and limit; preserve fallback metadata |

Audit findings that adapters must resolve before acceptance:

1. `getTaskDetail` eagerly includes comments, notes and dependencies. Do not
   retrieve an unbounded detail and truncate it as the implementation of a list.
   The implementation adds authorized paginated comment/dependency services,
   exposed to stdio through the fixed JSON tool adapter and to HTTP directly. Detail responses must also remain bounded.
2. Existing unified search is bounded per entity but has no cross-entity page
   contract. For MVP use a total limit of 20 by default, maximum 50, return
   `hasMore` and explicitly mark pagination unsupported; do not invent page counts
   or silently drop entity types. Bound per-entity queries and the merged result.
   Document-only search preserves existing keyword/fulltext/semantic/hybrid
   modes and fallback metadata. Results preserve each source ordering and interleave entity types; matchedTypes
   reports which sources matched. Search pagination remains unsupported.
3. Authentication middleware rejects routes outside its ordinary resource
   classification. Explicitly classify the MCP endpoint and perform per-tool
   resource authorization; do not exempt it from authentication. Existing CORS
   preflight also needs the protocol headers explicitly allowlisted.
4. `createTaskSchema` and `listTasksSchema` are refined schemas. Reuse their
   validation after constructing narrowed MCP inputs; do not discard membership
   refinements while deriving JSON Schema.
5. Status mutation has no expectedVersion field today. Promise optimistic
   concurrency for task/document update tools that actually support it; do not
   advertise version protection for status calls without extending all interfaces.

## Results, bounds and annotations

Lists use summary projection, page=1 and pageSize=20, maximum 50, with ids,
`meta.page`, `meta.pageSize`, `meta.total`, and nullable `meta.nextPage` where the
service supports pages. Search uses the distinct limit/hasMore contract above.
Full content is available only through detail tools. Never silently truncate
Markdown or a successful write result.

Success is `{ ok: true, data: ... }` in structuredContent and the equivalent JSON
text content for clients that do not render structured output. Tool failures use
`isError: true` and the shared `{ ok: false, error: { code, message } }` schema.
Do not reflect raw exception messages, database errors, response bodies or stacks.

| Failure | Public behavior |
| --- | --- |
| Malformed JSON-RPC, unknown method/tool, invalid arguments | SDK protocol error; no mutation |
| Missing/invalid/revoked HTTP credential | HTTP 401 before protocol dispatch |
| Credential denied resource access | forbidden or non-disclosing not_found, following existing service semantics |
| Invalid business input | validation_error |
| Stale version / blocking dependency / competing claim | version_conflict / dependency_conflict / claim_conflict when typed evidence exists; otherwise conflict |
| Write in read-only mode | read_only, rejected before service dispatch |
| Excess result / concurrency / deadline | result_too_large / busy / timeout |
| Upstream failure | upstream_error with a generic message |

Shared default limits: 1 MiB request, 256 KiB serialized result, eight concurrent
calls per process, 30-second deadline. Enforce byte limits before parsing and
serialization respectively. Refuse oversized input before mutation; bound result
queries at source. If a mutation succeeds but its response exceeds the result
limit or the connection disappears, report an uncertain outcome and require a
read to reconcile; never retry writes automatically. Cancellation does not undo
an already committed mutation. Each adapter must propagate AbortSignal where
supported and release its concurrency permit in finally.

Read tools have readOnlyHint=true, destructiveHint=false, idempotentHint=true.
Write tools have readOnlyHint=false and idempotentHint=false conservatively.
Updates/removals/status use destructiveHint=true; append/create tools use false.
All tools have openWorldHint=true because they use external persistent state.
Annotations never substitute for permission checks. Read-only discovery hides
writes and dispatch independently rejects them, including known write names.

## Authentication and compatibility acceptance

MVP uses pre-provisioned subject-bound scoped API keys. HTTP clients must send
Authorization: Bearer on every request; stdio uses existing CLI credential
configuration. No OAuth discovery, dynamic registration or anonymous access is
implemented by this contract. API-key clients are a documented compatibility
subset; do not claim full MCP OAuth authorization support.

Verify key validity and grants for each call. Project selection narrows scope;
owner identity derives from verified credentials. Enforce access to both ends of
links/dependencies. No shared mutable actor state between callers. Reject
untrusted Origin values, validate configured public Host/proxy boundaries, and
use TLS for remote traffic. Do not treat nodeId/clientId or actor arguments as
credentials. Preserve actor-attributed activity without duplicate mutation logs.

| Target | Authentication | Required evidence | Current evidence |
| --- | --- | --- | --- |
| SDK 1.31.0 client, stdio | configured scoped key | initialize/list/read/write/read-only/shutdown | Passed in disposable PostgreSQL integration |
| SDK 1.31.0 client, Streamable HTTP | per-request Bearer | same plus Origin, revocation and concurrent identities | Passed in disposable PostgreSQL integration |
| Real stdio client | configured scoped key | exact client version and isolated collaboration workflow | MCP Inspector 2.11.0 CLI; isolated workflow passed |
| Real remote client with custom headers | per-request Bearer | exact client version and isolated collaboration workflow | MCP Inspector 2.11.0 CLI; isolated workflow passed |
| OAuth-only remote client | OAuth | Outside MVP | Unsupported |

Negative tests cover unknown tools, malformed arguments, spoofed identity,
missing/revoked/restricted keys, guessed ids, cross-project/personal reads and
links, stale updates, blocked status, competing claims, read-only writes, large
payloads, cancellation, deadlines, shutdown and no cross-caller result leakage.
Keep existing Registry commands/routes under regression. Resources, prompts,
subscriptions, attachments, daemon/registry/account/release controls and dedicated
workflow-stage actions remain outside this catalog.

References: [published transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
