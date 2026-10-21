# Isolated plugin contracts

The shared schemas in `@task-weaver/contracts/schemas/plugins` define the first
plugin protocol. Installations use the broker and lifecycle APIs described below. Optional pages
use the restricted HTML protocol and a separately configured artifact host.
The common MCP facade discovers and invokes installed plugins. Pinned hosted
skill instructions can be declared as read-only inputs; external tool execution
from plugin code remains pending. The protocol revision is independent of product
release versions.

## Identity and immutable artifacts

A manifest identifies `publisher/name`, an exact plugin version, a version-pinned
skill-package artifact and its resolved manifest hash. A publisher string does
not establish verified publisher trust. Optional Ed25519 signatures cover the
normalized manifest hash without its signature field. `verifyPluginManifest`
checks the operator's trusted key and publisher binding; a changed artifact or
manifest fails verification. Unknown, revoked or mismatched keys fail closed even
when an explicitly configured development policy permits unsigned manifests.
Unsigned manifests remain unverified and must never inherit a verified badge.
Key configuration belongs to the operator; this requires no artifact mirror or
separate signing service. Original artifact bytes must be verified
by the package materializer; a cached index or mutable document cannot replace
them. Installation scope is explicit and personal ownership comes from the
verified credential. The host generates installation IDs and storage namespaces.

The artifact may provide an HTML entry, an isolated backend entry or both. Backend
entries reference an operator-approved profile ID/hash; manifests cannot supply a
host command, environment values, network mounts or Docker arguments. Uploaded
code never executes inside the API/Web process. First-party application runtime
modules are not a third-party sandbox.

## Grants and host-owned state

Manifest permissions are `ui.render`, `backend.execute`, `storage.read`,
`storage.write` and `skills.read`. Requested permissions are unique and reviewed with the
manifest hash. Method names are unique and declare read/write access. A read
method cannot persist a storage patch, even when another method has write grants.
The host must check both the current installation grant and caller authority on
every operation; permission declarations do not enforce isolation by themselves.

The broker accepts plugin-owned storage patches and supplies explicitly pinned
read-only skill inputs. Core SQL, arbitrary Core
operations, filesystem paths, another installation ID and another namespace are
not valid backend response fields. Core integration is a future typed broker
surface, with the same caller and scope checks; it is not an escape through an
arbitrary operation string. Storage keys are data, never filesystem or SQL paths.

State is partitioned by host-derived installation identity. The initial limits
are 32 keys and 64 KiB per installation, 16 KiB per value/input and 64 KiB per
backend response. Backend patches contain at most eight unique keys and exact
expected versions. The host applies allowed patches atomically after execution,
rechecks grants and the installation revision, and rejects conflicts. Containers
receive only their authorized state snapshot, not database credentials or mounts.

## Installation, upgrade and recovery

Install requests confirm an immutable manifest hash and reuse one idempotency key
after an ambiguous response. Upgrades additionally confirm the permission diff
and current installation revision. The confirmation hash is an exact review binding; it does not replace
verification of the optional publisher signature. Verified installations must not
silently downgrade to unverified publisher trust during upgrade. The host must reject same-version artifact replacement.

Preparation and runtime preflight happen before an atomic generation switch.
Failure preserves the last active generation. Disable/revocation stops new calls
and withholds pending results; it never upgrades a caller's scope. Recovery uses
a pinned earlier generation and a new revision check. State remains retained by
default when disabling; purge is an explicit separate operation. Receipt hashes
must survive purge/uninstall so old requests cannot resurrect removed state.
The first implementation must reject storage-schema changes until a reviewed
host-controlled migration path exists. Uploaded privileged SQL is never accepted.

## Frontend boundary

Plugin HTML must run in a sandboxed iframe on a dedicated configured origin,
distinct from both Web and API origins, with no host session token and no access
to the Core DOM. The trusted static gateway must not forward cookies, authorization
headers or Core API routes into plugin code. Serve sandbox restrictions through
response headers as well as the iframe attribute; direct navigation must not
turn an artifact into credentialed Core-origin code. The trusted application
viewer must constrain frame navigation, scripts, connections and nested frames;
script restrictions alone do not prevent navigation-based data exfiltration.
The narrow message broker validates source window, origin/provenance, nonce,
message shape, size, installation and current grants. It derives target scope
from the installation rather than trusting a message's project or namespace.
A sandbox without `allow-same-origin` produces an opaque message origin. Accept
its `null` origin only together with the exact iframe window and fresh bridge
nonce; never accept arbitrary null-origin messages or relax Core CORS for them.
Replies target only that pinned frame and contain no host credential. Missing
origin/isolation configuration is unavailable, never a successful setup.

## Real-application acceptance

See the [concrete counter and failure matrix](plugin-acceptance.md).

Use the actual Task Weaver application, API and isolated worker, not a replacement
host. Install one small extension with a page, a namespaced API and persistent
owned state. Verify:

- Successful use across worker restart, immutable version upgrade and recovery.
- Denial of Core SQL, other-plugin state, host files and host credentials.
- Grant/caller revocation during execution and stale revision/receipt retries.
- Read-method write rejection, malformed JSON, output/CPU/memory/storage quotas.
- Frontend origin/source/nonce rejection, blocked navigation and token isolation.
- Permission diff review, failed upgrade preservation and explicit data retention.

Only then enable runtime discovery and evaluate a modest directory with artifact
provenance and maintenance ownership. Payments, ratings, unrestricted API
replacement and arbitrary DOM/DB mutation are outside this first contract.

The frontend implementation must follow the [HTML sandbox boundary](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)
and [CSP frame-source policy](https://www.w3.org/TR/CSP3/#directive-frame-src), then
prove its behavior in a real browser. Separate artifact hosting limits the
privilege of directly visited hostile content; a parent frame allowlist constrains
embedded navigation. Specification review is not a substitute for browser tests.

## Backend implementation status

The internal `invokeInstalledPlugin` broker and `preparePluginWorker` now implement
installation-scoped state and an offline backend worker. The
[backend lifecycle APIs and CLI](plugin-lifecycle.md) install and manage these
plugins. The [isolated page protocol](plugin-frontends.md) now provides a trusted
application viewer and dedicated artifact listener. Installation-management UI,
external MCP dependencies inside plugin code and the remaining acceptance matrix still
limit the complete plugin experience.

The worker uses operator-supplied digest-pinned profiles and publisher keys;
request payloads cannot choose either configuration. It materializes a
self-contained immutable skill-package artifact, checks its resolved capability
manifest hash, complete file inventory and original content hashes, and runs the
backend entry in a fresh constrained container. Dependency-bearing plugin
artifacts are rejected initially. The backend receives one JSON object with
`method`, bounded `input` and, only with `storage.read`, its installation's state
entries (`key`, `version`, `value`, `deleted`). It emits exactly one JSON response
matching the backend result contract. There is no outgoing Core broker surface.

The trusted host applies storage patches and an actor-bound idempotency receipt
in one short transaction after rechecking live caller authority and installation
revision. A read method cannot write; concurrent independent writes must satisfy
each key's current version. Concurrent identical requests may run duplicate pure
workers but commit only once. The installation row serializes quota enforcement;
worker execution holds no identity or installation lock. Deleted keys retain
versions and count toward the 32-key quota, preventing stale delete/recreate
requests and unlimited tombstones. The complete serialized namespace, including
keys and version metadata, must fit the 64 KiB quota. Runtime failures and denied
calls do not persist receipt payloads or state. Audits contain method/revision and
changed-key count, never backend input, state or output.

The host checks caller/installation/publisher/profile availability while a worker
runs and before committing its result. Container cancellation includes forced
container removal. The per-process admission limits are eight prepared workspaces and four active plugin workers;
operators still need external host resource limits and worker supervision. This
first implementation creates a fresh worker per call; no warm latency claim is
made. The parent application must keep plugins unavailable until its dedicated
origin and lifecycle implementation have passed acceptance.

Run `pnpm test:plugin-postgres` for the real PostgreSQL/container backend proof.
It uses disposable storage and publisher keys, verifies durable state across
fresh containers, CAS conflicts, identical retries, read-method write rejection,
installation disable during execution, live caller and publisher revocation, and
physical user/filesystem/network/credential isolation. It does not stand in for
the pending application/browser acceptance.


## Pinned hosted skill inputs

Optional `skillBindings` (one to eight) require a backend and the `skills.read`
manifest permission. Each binding has a unique `name`, unique skill `documentId`,
positive integer `version` and `contentHash` (the common capability digest of
`{ content }`). Bindings are covered by the publisher signature and confirmed
manifest hash. `tw plugin skill-binding <documentId> --name <name>` reads the
canonical hosted skill facade and prints a candidate pin for manifest review; it
does not install, sign or approve anything. Existing manifests omit the optional field and retain their exact
canonical digest. A new or changed binding appears in `tw plugin diff` as
`skill.read:<name>:<documentId>@<version>#<contentHash>`; confirming only the
unchanged permission names cannot approve a different document or content pin.

The host uses the common live-authorized skill reader, including package/version
quarantine checks. A dependency must belong to the installation's own project or
personal owner, or be globally readable with an explicit caller grant. A caller's
broader grants cannot copy a project/personal skill into a different or global
installation. Loading any dependency fails the entire operation if the caller
cannot read it, its revision/hash changed, or the serialized snapshots exceed
32 KiB in aggregate. The hash also protects Markdown content changes that do not
advance the document row's revision field.

For preflight and each method, the isolated backend receives a host-provided
optional `skills` array beside `method`, `input` and `state`. Each item contains
`name`, `documentId`, `version`, `contentHash`, `content` and `untrusted: true`.
User `input` cannot replace this field. Instructions are data; no script is
executed and no local skill installation, credential, network access or Core
operation is granted. The existing total worker-input budget still applies.

Authorization and pins are checked before worker execution, during normal calls,
and again in the atomic activation/state/receipt transaction. Old receipt retries
also recheck the dependencies. A changed skill cannot silently refresh into a
worker or return a cached result: review a new signed plugin generation and its
binding diff. Backend code cannot write the source skill or request another
binding. External MCP calls and executable skill dependencies remain unavailable.
