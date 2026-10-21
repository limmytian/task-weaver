# Real-application plugin acceptance

This is an executable acceptance runbook and evidence map for the initial isolated
plugin contract. Local source acceptance uses the actual Task Weaver API, database,
application viewer and container worker. Deployment and owner acceptance remain
separate delivery steps. Do not replace the application with a demonstration host. Run against a disposable project/database and record the
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

## Automated evidence

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

## Real browser attack observations

Run `pnpm dev:plugin-browser-fixture --probes` after building. The explicit flag
adds loopback test proxies in front of the actual production-built Next viewer
and dedicated artifact listener. The database guard still requires the owned
disposable database. Ordinary fixture mode has no injected controls. No production
route, runtime switch or publisher artifact enables these probes.

The proxies keep the shipped CSP, permissions policy and iframe sandbox unchanged.
They append a trusted test script using the existing response nonce. This deliberately
models executable attack attempts beyond the closed HTML compiler: uploaded scripts
remain rejected by the normal compiler. The proxy test compares policy headers
exactly, checks unchanged ordinary HTML/binary responses, and confirms that the
sink counter detects a request when one actually arrives. Do not enable this
instrumentation on an operator instance or treat it as publisher-provided code.

Observed with the in-app Chromium browser against the actual application:

| Probe | Browser and server observation |
| --- | --- |
| Direct network | Fetches to Web, API and a separate loopback sink failed with connect-src violations; API and sink counters stayed zero |
| Unauthorized assets | Image and nested iframe loads produced img-src/frame-src violations and a blocked nested document; the sink received nothing |
| Top navigation | Sandbox rejected a top-level navigation attempt with SecurityError |
| Frame navigation | Attempts to navigate the bound frame to Web, API and an unauthorized path on the artifact origin produced parent frame-src violations and blocked documents; no destination request arrived |
| Bound-frame malformed messages | Eleven null, wrong-nonce/identity/revision/hash/protocol/method/request-ID, extra-SQL-field, oversized and cyclic messages produced no host invocation, state or receipt |
| Opaque sibling | A second opaque frame loaded the same ticket and sent a well-formed invocation with the same nonce; pinned-window validation rejected it without a host call |
| Unexpected host message | A message sent from the host window/origin could not impersonate the artifact frame |
| Positive control | The original bound frame's Add one button produced exactly one API invocation, counter=1 and one receipt after all rejected message probes |

These observations complement the earlier actual counter page, four isolation
self-checks, direct-artifact denial, lifecycle upgrade/disable/recovery with retained
state and directory installation proof. Server tests cover artifact capabilities
rejected as Core credentials and live caller/profile/publisher/dependency authority.
Protocol simulation independently isolates origin and source checks and verifies
that pending replies cannot cross a frame navigation epoch.

Browser probing also found stale host status after a blocked frame navigation.
The viewer now clears its previous isolation evidence on every load, waits for a
fresh handshake, and prevents a pending request from overwriting that state.
The rebuilt actual viewer visibly showed the waiting state after the blocked Core
navigation, with zero host calls, state or receipts in the fresh fixture.

This completes the local evidence set for the documented initial contract, not an
exhaustive security certification or a production acceptance claim. Arbitrary plugin
JavaScript, privileged storage migrations, executable skill bindings and external
MCP writes remain unsupported. Keep source evidence in the linked project documents
and repeat the runbook when changing these boundaries.
