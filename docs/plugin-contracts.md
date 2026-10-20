# Isolated plugin contracts

The shared schemas in `@task-weaver/contracts/schemas/plugins` define the first
plugin protocol. They are contracts, not a running plugin loader. Runtime
availability remains disabled until installation, broker enforcement and real
application acceptance exist. The protocol revision is independent of product
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

Initial manifest permissions are `ui.render`, `backend.execute`, `storage.read`
and `storage.write`. Requested permissions are unique and reviewed with the
manifest hash. Method names are unique and declare read/write access. A read
method cannot persist a storage patch, even when another method has write grants.
The host must check both the current installation grant and caller authority on
every operation; permission declarations do not enforce isolation by themselves.

The initial broker supports plugin-owned state only. Core SQL, arbitrary Core
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
