# Use Task Weaver from an MCP client

Task Weaver's inbound MCP Server exposes 29 collaboration tools through local
stdio or remote Streamable HTTP. The existing MCP Registry connects **other**
servers to Task Weaver; its `tw mcp search/tools/call/servers/register-local`
commands retain their existing behavior.

Both paths require an API server with the 0.3.10 inbound MCP implementation.
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
