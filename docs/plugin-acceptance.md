# Real-application plugin acceptance

This is an executable acceptance plan for the isolated plugin implementation.
It does not certify that the runtime already exists. Use the actual Task Weaver
API, database, application viewer and container worker; do not replace them with
a demonstration host. Run against a disposable project/database and record the
browser engine, image digest, artifact hashes and source commit.

## Small reference extension

Use `example/counter` with a packaged HTML page and isolated backend, using a
host-approved digest image. Declare `get` as read and `increment` as write.
The host supplies only the installation's authorized `counter` state/version.
The backend returns a bounded result and an optional versioned storage patch;
it never receives database or application credentials. The page uses the narrow
message broker to display and increment the counter through its namespaced API.

Use immutable fixture generations with the same storage schema: an initial
version, a compatible upgrade with an explicit permission difference, and an
invalid generation that fails preflight. Sign fixture manifests with a temporary
operator-trusted publisher key. Keep the private fixture key outside source and
application configuration. No registry publication is needed for this test.

## Acceptance matrix

| Case | Required evidence |
| --- | --- |
| Install and invoke | Approved manifest/profile/artifact hashes, exact scoped installation, working application page/API/state and normal audit records |
| Ambiguous retry | Reuse the same key and payload without duplicate installation or counter update; changed payload conflicts |
| Caller and plugin grants | A missing caller grant or missing plugin grant independently denies the operation; read methods cannot persist patches |
| Namespace boundaries | A second plugin/installation cannot read or write the first one's keys, including crafted IDs, paths and raw SQL requests |
| Worker isolation | No Core DB/session/host credential, socket or unrelated file access; network and resource limits enforced by the worker |
| Restart | Stop the worker, reconnect explicitly, and retain the committed counter state without replaying a dispatched mutation |
| Upgrade | Show and confirm permission changes, preflight the pinned generation, atomically activate it and preserve compatible state |
| Failed upgrade | Missing images/profiles, bad signatures or protocol failure leave the last good generation active |
| Recovery | Activate a pinned compatible prior generation with a current revision check; state remains retained unless explicitly purged |
| Live revocation | Revoke caller/grant/profile/publisher trust while work waits; withhold results and deny storage commit/new invocations |
| Quotas and protocol | Reject malformed/deep/cyclic-equivalent JSON, duplicate patches, wrong state versions and oversized output; terminate deadline/resource overruns |
| Purge and retention | Disable retains data by default; explicit purge removes state/result payloads while receipt tombstones prevent resurrection |

Backend state writes and receipts must commit atomically after reauthorization.
An interrupted remote operation can have uncertain effects; do not claim that
cancellation erases data already read or safely permits automatic replay.

## Browser proof

Use a dedicated plugin origin distinct from Web and API origins. For local
acceptance, a distinct hostname also avoids treating different ports as cookie
isolation. The static gateway receives only an artifact-scoped capability and
never forwards host credentials or Core routes to plugin code.

In the actual application viewer, verify all of the following:

- The plugin frame cannot inspect the Core DOM, cookies or storage. Directly
  visiting an artifact does not grant Core-origin execution rights.
- The parent frame policy blocks navigation to Core/API and external origins;
  the plugin policy blocks direct network, nested frames and unauthorized assets.
- Wrong frame, wrong nonce, malformed/oversized messages, another installation
  and unexpected origins are rejected. Opaque `null` origin is accepted only
  with the pinned window/provenance, never by a generic null-origin exception.
- No host session token appears in artifact HTML, iframe messages or backend
  input. A namespaced artifact capability is not accepted by Core APIs.
- Disable, upgrade and grant changes invalidate stale viewer/API revisions;
  cached UI cannot bypass current server checks.

Record real browser network/frame observations. Unit policy strings and a
manifest declaration alone do not prove these boundaries. Keep runtime
availability disabled when required origin/worker configuration is missing.

## Catalog gate

After the installed extension passes, seed only a modest reviewed directory with
publisher verification status, immutable artifact hashes, maintenance ownership,
required grants, supported host protocol and actual availability. Entries are not
automatically installed or granted. Distribution does not replace the runtime
proof, and payments/ratings or another application variant remain out of scope.

## Automated evidence and remaining observations

Run `pnpm test:plugin-postgres` against its owned disposable database and pinned
container image. The broker test uses signed artifact bytes and actual offline
workers, not a mocked executor. Its hostile-result subtests cover malformed JSON,
excessive nesting, duplicate writes, stale state versions, path traversal, forged
installation ownership, a raw SQL field, oversized stdout and deadline expiry.
Each rejection must leave both namespaces and the original receipt count intact.
The test checks expected rejection reasons, so an unrelated worker startup failure
cannot satisfy a protocol rejection. Two signed plugin identities using the same
artifact receive independent storage. These broker fixtures seed installation
records directly; the separate REST lifecycle test proves reviewed installation
and preflight through the actual API.

The same suite rejects cyclic, deeply nested and oversized caller values before
worker preparation. Caller, installation and common MCP policy revocation are
covered alongside dispatched-worker publisher/profile revocation. Existing
lifecycle tests cover failed activation, concurrent receipt replay, permission
review, recovery, retained uninstall and purge tombstones. The container fixture
checks non-root execution, missing Core credentials/socket, read-only artifact
files and lack of an external network interface.

`packages/core/src/services/plugin-viewer-protocol.test.ts` executes the shipped
trusted viewer script with controlled frame events. It checks wrong frame/source,
origin, nonce, installation, generation, manifest, method, request ID, extra fields,
oversized/cyclic messages and readiness failure before any host request. A valid
control proves that the same script can invoke its bound installation, keeps the
host CSRF token out of frame replies, and suppresses replies after frame navigation.
This verifies message-handler behavior; it does not establish browser sandbox or
CSP enforcement.

Real application browser observations already cover the counter page, four
isolation self-checks, retained state, reviewed upgrade/recovery, stale-viewer
disable denial and directory installation. Complete acceptance still requires
explicit browser observations of hostile navigation/network/nested-frame attempts
and attacker-frame message provenance. Keep those observations separate from the
compiler, handler and container tests; do not infer a completed matrix from policy
strings or simulated frame events.
