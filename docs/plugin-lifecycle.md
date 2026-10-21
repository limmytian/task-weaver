# Backend plugin lifecycle

The REST API and `tw plugin` CLI support operator-configured backends with
optional [restricted HTML pages](plugin-frontends.md). Frontend manifests are
rejected unless the dedicated artifact listener has valid origin configuration
and is running. Installed-plugin discovery and invocation use the common MCP
facade described below. Typed dependencies inside plugin code and the full
acceptance matrix remain pending, so bootstrap does not advertise blanket plugin
execution readiness. See [plugin contracts](plugin-contracts.md) for the sandbox
and owned-state protocol.

## Operator configuration

The API reads `TW_PLUGIN_RUNTIME_PROFILES`, using the same digest-pinned image,
interpreter and timeout schema as hosted skill profiles. Profiles are independent
of `TW_SKILL_RUNTIME_PROFILES`: enabling skill execution does not automatically
enable plugin execution. The dedicated runtime host needs the pinned image and a
Docker engine enforcing CPU, memory and process limits. No image is pulled or
published by installation.

`TW_PLUGIN_PUBLISHER_KEYS` is a JSON object mapping key IDs to objects with
`publisher` and an Ed25519 SPKI PEM `publicKey`. Only matching publisher/key bindings
verify signed manifests. Keys are public verification material; private signing
keys are never provided to the API or plugins. No artifact mirror or signing
service is required. Missing profiles or keys prevent activation.

Unsigned development artifacts require the explicit operator setting
`TW_PLUGIN_ALLOW_UNVERIFIED=true`. They remain unverified. A verified installation
cannot upgrade or recover into an unsigned manifest even under that policy.
Removing a key prevents subsequent execution/activation; managers can still
inspect, disable, uninstall or purge an affected installation.

## Prepare and activate

Each backend must accept the reserved host preflight request:

```json
{"method":"__tw_preflight","input":{"hostProtocol":1},"state":[]}
```

It must exit successfully with one valid backend JSON response and no storage
changes. This method cannot be invoked through the ordinary user method broker.
Preflight runs in the actual isolated container with verified original artifact
bytes. It never receives or mutates installation state. Backend code must handle
this request explicitly rather than treating every request as a state mutation.

Install/upgrade/recovery preflight happens outside identity/installation locks.
The host then rechecks caller authority, publisher/profile/artifact availability,
expected installation revision and version immutability in a short activation
transaction. Failure leaves the last active generation and owned state untouched.
Concurrent activation of different candidates for the same expected revision has
one winner. An identical retry reuses its actor-bound receipt instead of applying
another transition. Receipt responses distinguish `operationRevision` from
`currentRevision`, and report the installation's current status rather than
claiming an older operation has just run again.

The installation namespace derives from verified scope and actor ownership.
There is at most one installed instance of a plugin identity in each scope.
Self-contained artifacts reuse the immutable skill-package store and resolver;
implicit dependency execution and storage-schema migrations are rejected. Backend
callbacks can request only installation-owned storage patches. General Core,
skill and external MCP invocation from plugin code remain unavailable until a
typed, scoped common-broker surface is implemented and accepted.

## REST and CLI

All routes are under `/api/v1/plugins` and use ordinary verified REST credentials
and browser CSRF protection. They never accept client-selected publisher keys,
host commands or runtime environment configuration. Request bodies are bounded
to 128 KiB. Reads require `resource.read`; management requires `resource.write`
and `mcp.manage` in the installation scope. Activation also requires `mcp.invoke`,
and execution checks the caller's read/write method authority separately.
Requirement-bounded daemon credentials cannot manage plugins.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/` | Scoped summaries; `scope=personal`, `scope=global`, or `scope=project&projectId=...`; limit 1–20, bounded offset |
| GET | `/:id` | Current manifest, scope, status, hash and revision; no owned state or host configuration |
| GET | `/:id/generations` | Bounded immutable generation summaries for recovery |
| GET | `/:id/generations/:version` | Selected pinned manifest/hash for review |
| POST | `/` | Confirmed install with explicit scope, manifest/hash and idempotency key |
| POST | `/:id/upgrade` | Confirmed candidate manifest/hash, permission-diff hash and expected revision |
| POST | `/:id/recover` | Confirmed stored version/hash, permission-diff hash and expected revision |
| POST | `/:id/status` | Confirmed `disable`, `uninstall` or `purge`, expected revision and idempotency key |
| POST | `/:id/invoke` | Confirmed declared method/input, expected revision and idempotency key |

Generation metadata labels publisher verification as `verifiedAtInstall`, a
historical observation rather than a claim that the signing key is still trusted.
Every execution and activation rechecks current operator trust.

The CLI validates the same schemas before making requests:

```bash
tw plugin list --project "$PROJECT_ID" --json
tw plugin view "$INSTALLATION_ID" --json
tw plugin get "$INSTALLATION_ID" --manifest > current-manifest.json
tw plugin generations "$INSTALLATION_ID" --json
tw plugin generation "$INSTALLATION_ID" "$PLUGIN_VERSION" --manifest > candidate-manifest.json
tw plugin diff --current current-manifest.json --next candidate-manifest.json
tw plugin install --file reviewed-install-request.json --json
tw plugin upgrade "$INSTALLATION_ID" --file reviewed-upgrade-request.json --json
tw plugin recover "$INSTALLATION_ID" --file reviewed-recovery-request.json --json
tw plugin status "$INSTALLATION_ID" --file reviewed-status-request.json --json
tw plugin invoke "$INSTALLATION_ID" --file reviewed-invocation-request.json --json
```

Request files must include `confirmed: true`, the reviewed immutable hashes,
required expected revision and an explicit UUID `idempotencyKey`. After an
ambiguous response, retry the identical request file. Neither CLI nor API invents
confirmation or silently replaces a retry key. The permission-diff hash covers
canonical JSON `{added, removed}` with sorted permission names. `tw plugin diff`
computes this review binding; any additional/removed permission requires its exact
hash even when a candidate has no net permission change.

## Retention and recovery

Disable increments the installation revision, retains owned state and prevents
new execution. Recovery explicitly selects an existing immutable generation,
rechecks its current trust/profile/artifact availability, confirms the permission
delta, and reactivates it with a new revision while retaining data. Recovery
cannot change the storage schema or silently lower publisher trust.

Uninstall increments the revision and retains data by default, but permanently
retires that instance's execution identity. A new confirmed install uses a fresh
installation ID and empty namespace. Historical uninstall data stays retained for
owner-directed handling; this initial API does not expose a data export/import
path or implicitly restore it into a new installation.

Purge is separate and requires an already disabled or uninstalled instance. It
removes owned key/value data, scrubs invocation receipt result payloads and retires
the instance. Receipt hashes and generation/audit metadata remain as tombstones.
Old install, activation and invocation requests cannot recreate the purged data.
An old status retry reports current metadata without repeating a transition.

Run `pnpm test:plugin-postgres` for actual PostgreSQL/container/REST/CLI coverage.
The dedicated viewer also has local browser isolation proof. The complete installed
application acceptance matrix remains pending.


## Common MCP access

`tw_plugins_list` lists one explicit project/personal/global scope with at most 20
summaries and a 16 KiB response budget. Personal ownership comes from the verified
credential. `tw_plugins_get` loads one authorized manifest, installation status
and revision on demand. Neither discovery operation starts a worker or guarantees
that its operator profile, publisher key or artifact is currently available.

`tw_plugins_call` accepts `installationId` plus the same confirmed method/input,
`expectedRevision` and `idempotencyKey` as REST invocation. It uses the same
isolated worker, owned-state CAS and actor-bound receipt. An identical retry can
cross REST, HTTP MCP and CLI stdio without executing a second write. Changed
payloads or revisions conflict. Output and manifest text remain untrusted data.

All MCP calls require live resource read access; this initial facade also requires
`resource.write` and `mcp.invoke` for every plugin call, including a declared read
method. Read-only MCP mode omits and rejects the call tool. Installation management
is still through REST/CLI. MCP deny/approval policy applies independently of
explicit request confirmation, and policy or grant changes during execution block
late storage commits and cached-result disclosure. Runtime preparation/execution
occurs outside the identity lifecycle lock.

No local plugin worker, plugin package, extra skill or external MCP server is
required on the client. The API host must have the approved plugin runtime and
publisher configuration. Uploaded plugin code cannot use these tools to acquire
Core authority or invoke arbitrary skills/external tools; typed cross-capability
dependencies remain a separate implementation step.
