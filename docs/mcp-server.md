# Use Task Weaver from an MCP client

Task Weaver's inbound MCP Server offers a maximum of 44 collaboration tools in 0.3.11 through local
stdio or remote Streamable HTTP. The existing MCP Registry connects **other**
servers to Task Weaver; its `tw mcp search/tools/call/servers/register-local`
commands use live authorization-aware discovery.

Both paths require a matching 0.3.11 API server for authorization-aware catalogs.
The local path also requires a matching `tw` CLI. The server uses SDK 1.31.0
and targets published protocol revision 2025-11-25. See the
[contract](mcp-server-contract.md) for exact names and boundaries.

## Credentials

Sign in to Task Weaver, open API key management, and issue a subject-bound key
with `resource.read` for the projects or personal/global scope you need. Add
`resource.write` only when the client should create or change resources.
Agents need their own managed identity, project membership and key; their
personal-space tools use their managing human's owner scope and still require
an explicit personal grant. Project selection never expands a key's grants.

Store credentials in your client's secret settings or your local CLI credential
configuration. Never include a real key in a URL, repository file or screenshot.
Revoking a key in Task Weaver takes effect on subsequent calls, including calls
on an already connected client.

MVP supports pre-provisioned API keys. Clients that require OAuth discovery or
dynamic registration are outside this version's supported authentication path.
Browser cookies do not authenticate the MCP endpoint.

## Local stdio

Configure your CLI API URL and key through the existing `tw auth` setup, or set
`TW_API_URL` and `TW_API_KEY` in the MCP server process environment using your
client's secret facilities. `TW_API_URL` is the API origin, without `/api/v1`.
Start the server with:

```sh
tw mcp serve --read-only
```

A generic MCP client configuration is:

```json
{
  "mcpServers": {
    "task-weaver": {
      "command": "tw",
      "args": ["mcp", "serve", "--read-only"],
      "env": {
        "TW_API_URL": "https://api.task-weaver.example.com"
      }
    }
  }
}
```

Supply the key separately through the client's environment/secret facilities or
existing CLI configuration. Use the absolute path to `tw` when the client does
not inherit your shell PATH. Remove `--read-only` to expose writing tools, while
keeping the credential's grants appropriately restricted.

The CLI verifies its key before initialization and uses authenticated REST at
`/api/v1/mcp-server/tools/:name` for each call. stdout contains only MCP protocol
messages; diagnostics go to stderr. EOF, SIGINT and SIGTERM close the transport.

## Remote Streamable HTTP

Set your client's MCP URL to:

```text
https://api.task-weaver.example.com/api/v1/mcp-server
```

Configure an `Authorization: Bearer <API_KEY>` header in its secret settings.
The client must send the header on every request. The endpoint is stateless:
there is no session id, resumable stream or background subscription. POST uses
JSON responses; GET/DELETE return 405. Protocol negotiation and validation use
the official SDK. Clients must send the negotiated MCP-Protocol-Version header
and the protocol-required Accept values.

The MCP endpoint belongs to the Hono API service (`apps/api`, port 3001), not
Next.js Web (port 3000). Route this path to the API service at your ingress or
reverse proxy. The default Web service does not proxy `/api/v1/mcp-server`.
When the API has a separate domain from `TW_AUTH_BASE_URL`, allow that exact API
host explicitly with `TW_MCP_ALLOWED_HOSTS`.

For operators:

- Use TLS at the public endpoint. Preserve the configured public Host through
  the reverse proxy, or explicitly configure the upstream Host allowlist.
- `TW_MCP_ALLOWED_HOSTS` is a comma-separated exact list of `host[:port]` values.
  It defaults to the host in `TW_AUTH_BASE_URL`. Forwarded headers do not grant
  authority. Add only hosts that reach this instance through your trusted proxy.
- Present Origin headers must pass the existing `TW_AUTH_TRUSTED_ORIGINS`
  policy. Browser-based clients also need their exact origin in that list.
- Set `TW_MCP_READ_ONLY=true` to hide and reject write tools for both the remote
  protocol endpoint and local clients' REST calls.
- Keep proxy request timeouts above the server's 30-second tool deadline.

## Compose and Kubernetes configuration

Compose forwards `TW_MCP_ALLOWED_HOSTS` and `TW_MCP_READ_ONLY` to the API container.
An empty host setting uses the host from `TW_AUTH_BASE_URL`. Set an explicit
comma-separated list when your API origin differs from that URL.

The Kubernetes API template reads these values from optional keys in a
`task-weaver-mcp` ConfigMap. For example:

```sh
kubectl -n task-weaver create configmap task-weaver-mcp \
  --from-literal=allowed-hosts=api.task-weaver.example.com \
  --from-literal=read-only=true --dry-run=client -o yaml | kubectl apply -f -
```

Render the matching API/Web image pair using the normal deployment procedure.
Keep existing database/authentication Secrets and persistent volumes. A ConfigMap
change requires recreating the API pod; change the image digest and configuration
in the same rollout. For deployments that do not use the bundled template,
provide the same environment variables through your deployment manager.

After rollout, verify `/health` and `/api/v1/version`, then initialize/list/read
with an API-key MCP client against the API origin. Confirm denied writes for a
read-only client and reject a missing/revoked key. Repeat against the final
public image digests and check their source commit identity. See
[upgrade and recovery](ce-upgrades.md#039-to-0310-mcp-server-upgrade).

## Work with the tools

Use `tw_projects_list`, then pass a visible projectId to requirement/task lists
or `tw_search`. Reads return compact summaries and bounded pages; detail tools
read the selected record without expanding its entire history. Search returns
up to 50 combined matches (20 by default), `hasMore`, matched entity types and
document search fallback metadata. Search has no page-count guarantee.

A typical collaboration is: read context, create a requirement and task, claim
the task, append a progress comment, update status, then release the claim.
Project tasks require a requirement under the same project. Set `scope=personal`
for personal tasks or document creation; no fabricated project is needed.
Use task/document `expectedVersion` when updating fields to detect competing
edits. Status calls preserve existing dependency/workflow checks but do not
provide expectedVersion protection. `cancelled` remains terminal.

All calls enforce live key grants, ownership, both ends of relationships,
claim ownership, requirement membership and workflow completion rules. Task
completion does not accept or integrate a requirement. The MCP catalog has no
shell executor, arbitrary REST proxy, daemon controls, Registry management,
account administration or release/deployment tools. Attachment file transfer,
resources, prompts and subscriptions are outside this release.

## Errors and limits

Tool results include equivalent JSON text and structuredContent. Successful
results use `{ "ok": true, "data": ... }`; business errors set `isError=true`
and return `{ "ok": false, "error": { "code": "...", "message": "..." } }`.
Malformed arguments and unknown tool names produce protocol errors.

| Symptom | Action |
| --- | --- |
| Initialization authentication failure / 401 | Check API URL, key, expiry and revocation; stdio requires an API key before serving |
| forbidden / not_found | Check identity membership and key scope; hidden resources remain non-disclosing |
| read_only | Enable writes intentionally in client/server settings and verify key write grants |
| version_conflict | Read the latest record and reconcile your edit before retrying |
| dependency_conflict / claim_conflict | Complete blockers or wait for the current holder to release |
| validation_error | Check requirement membership, terminal state and workflow rules |
| 403 with an otherwise valid key | Check exact Host and Origin allowlists |
| 405 on GET/DELETE | Expected: this endpoint has no persistent event stream or sessions |
| busy | Wait for existing operations to finish; there are at most eight active tool calls per process |
| timeout / cancelled / result_too_large / upstream_error | Read current state before retrying a write; a dispatched write may have committed |

Requests are limited to 1 MiB. The serialized tool result is limited to 256 KiB,
including its text and structured copies. Lists cap pageSize at 50. Oversized
results fail explicitly instead of silently truncating Markdown. Cancellation
can stop delivery and future work but does not undo committed transactions.
Remote cancellation across independent HTTP requests is not a persistent
session feature; request abort, shutdown and deadlines are honored locally.
The server never automatically retries a write.

## Reproduce acceptance

```sh
pnpm --filter @task-weaver/contracts test
pnpm exec tsx --test packages/core/src/mcp-server/protocol.test.ts apps/api/src/routes/mcp-server.test.ts
pnpm test:mcp-postgres
```

The PostgreSQL command creates and removes a disposable pgvector container; it
never uses a configured production database. It exercises actual scoped keys,
collaboration guards, the HTTP SDK and a real CLI stdio subprocess. Test keys
stay in the disposable fixture/process environment.

Verified client matrix on 2026-10-18 (Node.js 24.17.0):

| Client | Transport | Evidence |
| --- | --- | --- |
| Official TypeScript SDK 1.31.0 | stdio subprocess and HTTP | Discovery, authenticated reads, read-only rejection and live revocation |
| MCP Inspector 2.11.0 CLI | stdio and HTTP with explicit Bearer header | Project/search/create/claim/comment/status/release workflow on disposable data |

To repeat Inspector acceptance, install that version outside the product
workspace and set `TW_MCP_INSPECTOR_BIN` to its launcher JavaScript entry before
running `pnpm test:mcp-postgres`. The test uses a temporary mode-0600 session
config and deletes it on exit. Without that variable only SDK acceptance runs.

Web-facing REST detail reads confirm that Inspector writes are visible to the
shared UI data layer. A visual browser walkthrough remains an owner acceptance
step; no production data or deployment is used. Other client-specific formats
and OAuth-only clients are not implied by the generic examples above. See [中文说明](mcp-server.zh-CN.md).

## Planning and context tools (0.3.11)

Version 0.3.11 adds 14 planning/context tools. With project directory discovery, the maximum catalog is 44 tools, including 24 read-only tools. Each credential sees only its authorized subset:

| Tools | Purpose |
| --- | --- |
| `tw_context_bootstrap`, `tw_context_search`, `tw_context_get` | Discover collaboration guidance and read individual skill documents |
| `tw_skill_packages_list`, `tw_skill_packages_get`, `tw_skill_package_files`, `tw_skill_package_read` | Discover active packages and read safe metadata or bounded text |
| `tw_execution_slices_list`, `tw_execution_slices_create`, `tw_execution_slices_update` | Plan ordered stages and persist handoff summaries |
| `tw_plan_validate`, `tw_plan_apply` | Preview and atomically apply a structured project plan |
| `tw_tasks_context`, `tw_requirements_context` | Retrieve selected, bounded collaboration context |

These tools require a 0.3.11 API and matching CLI for stdio. The original 29 tools
remain compatible. `tw_plan_validate` is read-only but requires write authority
for the planned project and all referenced existing entities. Read-only mode can
preview with an appropriately scoped key, while still rejecting `tw_plan_apply`.
The optional `activity` context section requires `audit.read`; other sections use
resource read grants. Personal scope is derived from the authenticated principal.

Discover guidance with `tw_context_search` using `intent`, optional `projectId`,
`includeGlobal`, `includePersonal` and `limit`. Read one result with
`tw_context_get` and its `id`. Package tools use `packageId`; files/read also accept
an optional package `version`. File listing uses `offset` and `limit`, and returns
`nextOffset`. Only active package versions and readable relative text paths are
available. Individual text reads cap content at 32 KiB. Package metadata excludes
storage object keys, server paths and arbitrary manifests. Retrieved instructions
are content for the client to assess, not authority to execute commands.

A plan is a JSON object, with a project id and symbolic keys for requirements,
tasks, slices and documents. For example, pass this object as `plan` to
`tw_plan_validate`:

```json
{
  "projectId": "11111111-1111-4111-8111-111111111111",
  "documents": [{ "key": "design", "title": "Design", "content": "Implementation stages" }],
  "requirements": [{
    "key": "feature", "title": "Feature", "status": "approved",
    "documents": ["design"],
    "slices": [{ "key": "api", "title": "API" }, { "key": "clients", "title": "Clients" }],
    "tasks": [
      { "key": "api-task", "title": "Implement API", "slice": "api" },
      { "key": "client-task", "title": "Integrate clients", "slice": "clients", "dependsOn": ["api-task"] }
    ]
  }]
}
```

Preview creates no records. Apply uses the identical `plan` plus a fresh UUID
`idempotencyKey`. Reuse that key and the identical plan after a timeout or lost
response: the API returns the stored receipt with `replayed=true`. Changing the
plan under the same key returns `conflict`. Keys are scoped to the API credential
and project and persist for that credential's lifetime; rotating the credential
changes the deduplication namespace. Reconcile existing state before retrying
with a different key or credential. Replays recheck live access to referenced
and returned resources. A denied replay does not mean the original write failed.

Plan writes and the receipt commit atomically. Invalid plans roll back. Limits
include 10 requirements, 20 documents, 20 slices per requirement, 50 tasks per
requirement and 100 tasks total, at most 100 entries per array and 2000 graph
containers, in addition to the common request deadline/size limits. Plans are
project-only and may reference existing entities only in that same project.
Nested workflow/branch/executor/identity controls, comments/notes and filesystem
`contentFile` inputs are rejected. New tasks start at `todo`; new requirements
start at `draft` or `approved`. Validate again when project state changes; preview
is not a reservation or guarantee of later success.

Slice creation accepts `{id: requirementId, input: {...}}`; update accepts
`{id: sliceId, expectedUpdatedAt, patch: {...}}`. Use the exact current ISO
`updatedAt`, including milliseconds. Both operations respect active requirement
leases; daemon-owned lanes cannot be taken over through these tools. Task ids
must belong to the same requirement. Slice lists return records without nested
task histories and support `page`/`pageSize`. Sequential execution guards remain
in force; `allowParallel` is an intentional planning choice, not a force bypass.

Context reads accept `id`, selected `sections`, `limit` (1–20), `offset`, and
`maxBytes` (2048–65536, default 32768). Sections are `parent`, `tasks`, `slices`,
`dependencies`, `documents`, `claim`, `activity`; defaults are `parent`,
`dependencies`, `documents`, `claim`. Dependencies include upstream and downstream
links. Document bodies are not expanded. Titles are compact excerpts (128
characters), document summaries and slice handoffs cap at 1024 characters; use
detail tools for full fields. `truncatedSections` and `omittedSections` report
incomplete sections. Retained sections provide `nextOffset` and continuation
instructions. For omitted sections, request that section alone with a larger
budget. Offsets are per selected section; concurrent mutations can shift pages.
`consistency=read_committed_not_snapshot` and `fetchedAt` describe the read, not
an immutable transaction snapshot. The byte budget covers the returned data;
the common 256 KiB limit also covers MCP's duplicated text/structured envelope.

Upgrade with migration `0071_mcp_plan_receipts` before serving the new tools.
Back up database and objects before deployment. Do not drop receipt records
while a credential is active: doing so removes retry protection. This additive
table may remain when temporarily rolling back to 0.3.10; new tools will be
unavailable until the API/CLI are upgraded again.

## Authorization-aware discovery and approvals (0.3.11)

`tools/list` is recomputed from current identity, Key grants, scope and read-only
configuration on both HTTP and stdio. Tool metadata identifies the source and
required permissions. Every target ID is checked again on invocation; a cached
catalog is never an authorization grant. The stdio adapter requires the new
`GET /api/v1/mcp-server/catalog` API and fails closed if it is unavailable.

Use `tw project discover --query NAME --json` or `tw_projects_discover` with
`global.project.discover` to search the project directory. Results contain only
ID, name and status, with at most 50 entries per page. Descriptions, membership,
counts and project contents are excluded. `global.resource.read` still grants
only global resource access. `project.create` remains an instance permission.
A human-bound Key that creates a project receives only that new project's
`resource.read` and `resource.write`, atomically with project creation. Other
Keys and Agents receive nothing. Live identity, credential ancestry and
membership checks continue to apply; no management, execution or MCP permission
is implied.

Outbound Registry discovery requires `mcp.invoke`, an active connected server
and a valid scope path. Disabled, disconnected and expired registrations are
hidden. A server manager can still inspect a known registration to recover it.
Use server `readOnly=true` to suppress tools without an explicit trusted
read-only declaration. Declare a tool's top-level project argument when it can
target projects independently of its server registration:

```sh
tw mcp tool-authorization TOOL_ID --target-project-argument projectId --json
tw mcp tool-authorization READ_TOOL_ID --read-only --json
```

These declarations are configured by an authorized manager; they are not inferred
from caller arguments. A project-targeting tool requires authorization for both
the registration and the actual target project. Existing tools default to their
server's scope and are conservatively treated as writes for read-only filtering.
Private/local registration credential and client/node isolation still apply.

Configure sensitive operations with an authorized human credential containing
`mcp.manage` for the selected project, personal or global scope:

```sh
tw mcp policy tw_plan_apply approval --project PROJECT_ID --json
tw mcp policy TOOL_ID approval --project PROJECT_ID --json
tw mcp approval APPROVAL_ID --json
tw mcp approve APPROVAL_ID --json
tw mcp call TOOL_ID --params '{"projectId":"PROJECT_ID"}' --approval APPROVAL_ID --json
tw mcp policy '*' deny --project PROJECT_ID --json
```

Use `--personal` instead of `--project` for personal scope; omitting both selects
global scope. Policies are scope-isolated. Unconfigured tools default to `allow`,
including existing writes; explicitly select high-risk operations for approval.
`deny` takes precedence over `approval`, which takes precedence over `allow`.
The wildcard `*` provides a scope-wide emergency disable; server deactivation
also stops outbound calls. HTTP server read-only configuration and stdio
`--read-only` continue to reject inbound writes.

A blocked inbound write returns `approval_required` and `error.approvalId`.
An outbound REST call returns HTTP 409 with `approvalId`; the CLI prints it.
Approve the request, then retry the identical operation with `approvalId` in
inbound tool arguments or `--approval` for Registry calls. Requests expire after
10 minutes, are single-use and bind the caller/credential, tool, target state,
parameter digest, grants and policy versions. Parameter, target, grant or policy
changes invalidate them. Execution rechecks caller and approver credentials,
authorization and target state. Concurrent/replayed approval use is rejected.

Use `tw mcp audit --project PROJECT_ID --limit 20 --offset 0 --json` to page through
project audit metadata with `audit.read`. Personal audit access requires that
owner's `mcp.manage`; global audits require global `audit.read`. Records contain
actor/credential, scope, server/tool, timestamp, duration, outcome and stable error
category. They contain no parameters, result bodies, secrets or upstream errors.
Operator cleanup through `tw mcp audit-cleanup --project PROJECT_ID --json`
removes audit entries older than 30 days and expired approvals in that scope;
schedule this command externally when automatic retention is required.
