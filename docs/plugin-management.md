# Manage installed plugins

Open **Plugins** in the Web navigation (`/projects/plugins`). Select your personal
space, global space, or a project you can access. Installations are paginated and
show their current version, installation revision and active/disabled/uninstalled
state. The selected installation shows its declared permissions, publisher,
manifest, page link when available, and paginated immutable generation history.
A supplied signature is not displayed as current verified publisher trust;
historical verification is explicitly labeled **Verified at install**.

## Review and apply

**Install plugin** accepts pasted or selected publisher-manifest JSON, limited to
128 KiB. Choosing a file does not install or approve it. **Review access** loads a
normalized manifest review with artifact/runtime pins and exact access additions
and removals, including hosted skill and declared MCP bindings. Only **Confirm**
submits the reviewed operation. Installation scope is shown and stays fixed while
the confirmation is open. The API still performs live publisher/profile/package,
permission and isolated-runtime preflight checks.

**Review upgrade** compares against the currently authorized installation fetched
by the server, rather than accepting a client-supplied previous manifest. Its
confirmation binds that installation revision, the candidate manifest hash and
permission-diff hash. Changed installations require a refresh and new review.

**Review recovery** selects an immutable historical generation. Review its access
delta, then confirm to reactivate it at a new revision with retained state. Old
verification is not reused: publisher, profile and dependencies are checked again.
Unsupported storage-schema changes remain rejected by the initial host.

**Disable** stops calls and keeps data; use reviewed recovery to reactivate.
**Uninstall** permanently retires the instance and retains its data. Reinstalling
creates a new empty namespace. **Purge retained data** is available only for an
already disabled/uninstalled instance and requires a separate destructive review.
It removes retained storage and cached result payloads; audit and anti-replay
metadata remain. Purged data cannot be recovered through this workflow.

Each confirmation creates one immutable retry request. A failed/ambiguous result
keeps that request open for **Retry same request**; it does not silently generate
a new key. Inspect current state before retrying after a network failure. Cancel
and prepare a fresh review when the revision or requested operation changes.

## Access and session boundary

The page uses the existing human browser session. The same-origin management BFF
allows only listed read, review and lifecycle paths, checks live session/origin
and mutation CSRF, bounds JSON bodies, and proxies credentials only to the
operator-configured Core API with redirects disabled. Browser API keys and agent
identities are rejected. It does not expose Core credentials or an arbitrary
proxy, and it never forwards authentication material to an artifact origin.

Scope metadata controls whether management and activation buttons are shown.
Read-only users can inspect permitted installations; the API independently
rechecks all current grants on every operation. Management needs resource read,
resource write and mcp.manage; activation also needs mcp.invoke. Revoked access,
empty scopes and failed operations have explicit states in the page. Runtime
availability is checked on use rather than inferred from a list entry.

The existing [isolated viewer](plugin-frontends.md) remains the only page execution
surface. This management page does not execute uploaded HTML or backend code in
the Web process. The [lifecycle API and CLI](plugin-lifecycle.md) use the same Core
broker and preserve the same revisions, approval hashes and receipts.

## Local verification

`pnpm dev:plugin-browser-fixture` creates an owned disposable loopback database,
starts the actual API, artifact listener and production-built Web application,
and writes random login details and signed manifest-file paths to a private
fixture file. Build before starting it. The fixture contains a counter and a
signed compatible upgrade that removes storage.read. Stop it to remove only its
own processes, database container and temporary files.

The real browser workflow verifies project selection, signed upgrade/access diff,
status refresh, disable/stale-viewer rejection, and recovery to the original
version with a persisted counter value. Install-review and failed duplicate
installation keep their confirmation/retry state. Automated PostgreSQL tests
cover uninstall/purge/anti-resurrection; browser verification does not claim an
irreversible purge was manually submitted. A reviewed distribution directory and
the complete application acceptance matrix are separate remaining work.
