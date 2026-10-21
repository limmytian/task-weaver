# Isolated plugin pages

A plugin can provide an HTML page alongside its isolated backend. The actual Web
application serves its authenticated viewer at `/plugins/:installationId`;
`tw plugin view <id>` prints this URL. Browsers need no additional local skills,
MCP servers or plugin runtime installation. The first page protocol is
`restricted_html_v1`: declarative controls call the installed backend through the
existing live-authorized broker, and display results as text.

## Page format

The host parses original hash-verified package HTML with a server-side HTML parser,
then compiles a bounded tree. Uploaded markup never enters a browser HTML parser.
A fixed platform renderer creates fresh DOM elements and text nodes from the
validated tree. Only that renderer executes in the browser; plugin logic runs in
the offline backend container. Arbitrary uploaded JavaScript, styles, URLs and
browser API access are outside this first protocol.

Supported elements are `div`, `section`, `article`, `p`, `h1`–`h3`, `strong`, `em`,
`small`, `ul`, `ol`, `li`, `button`, `output`, `code`, `pre`, `table`, `thead`,
`tbody`, `tr`, `th`, `td`, `hr` and `br`. An optional plain text `<title>` and
`<meta charset="utf-8">` are accepted in the head. Other head content is rejected.
Only bounded text `title` attributes and the following method/result bindings are
accepted. Scripts, styles, images, links, forms, child frames, SVG/MathML,
event-handler attributes, document IDs/names and external assets are rejected.

```html
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Counter</title></head>
  <body>
    <h1>Counter</h1>
    <output data-tw-result>0</output>
    <button data-tw-method="increment" data-tw-input='{"amount":1}'>Add one</button>
    <button data-tw-method="read">Refresh</button>
  </body>
</html>
```

Buttons must reference a method declared in the signed manifest. Their optional
`data-tw-input` is bounded finite JSON, defaulting to `{}`. Results replace the text
of `output[data-tw-result]`; the host never inserts returned HTML. One method runs
at a time per page. Real trusted user clicks initiate requests, while programmatic
clicks and unknown methods are ignored. The backend still checks current caller
permissions, installation revision, exact state versions and grants on every call.

HTML artifacts are bounded to 128 KiB, compiled trees to 512 nodes, depth 16 and
64 KiB serialized size. The fixed renderer, parent message envelopes and backend
JSON retain their own byte limits. These restrictions prevent arbitrary browser
code/network behavior while keeping the first counter/page/API/state workflow
interactive. Richer widgets require new reviewed declarative contracts.

## Separate artifact host

Configure these variables on the API host:

- `TW_PLUGIN_WEB_ORIGIN`: the exact canonical Web origin, already in trusted
  authentication origins.
- `TW_PLUGIN_ARTIFACT_ORIGIN`: the exact public origin dedicated to plugin assets.
- `TW_PLUGIN_ARTIFACT_PORT`: the separate artifact listener port, default `3010`.
- `TW_PLUGIN_ARTIFACT_BIND`: listener bind address, default `127.0.0.1`.

The artifact hostname must differ from both Web and API hostnames. Web and API may
share a hostname or origin; different ports alone cannot isolate an artifact
host's cookies. Origins require HTTPS outside explicit loopback development
hosts. For local development, Core can use `127.0.0.1` and artifacts `localhost`
with separate ports. These are operator settings, never manifest/request fields.

The API starts a separate trusted static listener. It exposes only exact
`GET /artifacts/:token` paths, validates the configured Host header, rejects query
strings, and mounts no Core router. A reverse proxy must route this dedicated
hostname to that listener while preserving Host and security headers. Never mount
untrusted artifacts on the Web or Core API origin. The listener ignores Cookie
and Authorization headers and does not forward them to plugin code or set cookies.
The Web server uses its existing trusted `TW_API_URL` to reach Core; redirects are
rejected while forwarding a verified human session and CSRF proof.

Missing/invalid origins or an unavailable listener keep frontend installation and
viewer issuance unavailable. Backend-only plugins continue to work. No same-origin
or `srcdoc` fallback exists. This implementation uses process-local ticket storage;
route ticket downloads to the issuing API replica or provide affinity. A shared
revocable ticket store is future scaling work, not an implicit current guarantee.

## Tickets and message boundary

`GET /api/v1/plugins/:id/viewer` requires live scoped read authority and an active
installation. It materializes and verifies the pinned artifact before issuing a
60-second opaque code-artifact ticket and a separate frame bridge nonce. Tickets
are actor/credential/generation bound, revalidated before delivery, limited to four
reads, and stored in bounded process-local memory. They convey no Core API
credential. Expiry limits new code downloads; an already loaded page still needs
live Core authorization for every method call. Role changes, disable, revision
changes and publisher/profile/artifact revocation withhold new operations/results.

The iframe has `sandbox="allow-scripts"` without `allow-same-origin`. Its response
also carries sandbox/CSP restrictions: only the platform's nonce script/style,
no connections, images, fonts, child frames, forms, objects or base URL changes.
The parent CSP permits only the exact ticket URL as its frame source. Both sides
use no-referrer policy. Uploaded content cannot introduce executable JavaScript
or arbitrary browser APIs; CSP strings alone are not treated as a sandbox for
unrestricted third-party JavaScript.

Before enabling controls, the actual frame checks its opaque origin and denial of
Core DOM, Cookie and localStorage access. A source/origin/nonce/generation-bound
initialize/ready handshake enables the page only when all checks pass. Direct
navigation to an artifact leaves methods disabled. The parent accepts an opaque
`null` origin only from its exact iframe WindowProxy, with the exact message shape,
nonce, installation, revision, manifest hash, declared allowed method and byte
budget. Core CORS is never relaxed for null origins.

The parent obtains CSRF proof and invokes the ordinary authenticated backend API;
no session, API key or CSRF token is sent into the frame. Replies target only the
pinned frame. A load epoch suppresses pending responses after frame navigation.
Only installation-owned results cross this bridge; arbitrary Core/SQL or another
installation/namespace are not valid backend operations.

## Verification

`pnpm test:plugin-postgres` exercises real migrations, isolated containers, REST,
CLI and the separate artifact listener, including credential non-forwarding,
Core-route denial, ticket-as-API-key denial, request-close independence and
revocation. Pure compiler/message tests reject scripts, URLs, foreign namespaces,
clobbering attributes, unknown methods, excess depth/bytes, cycles and getters.
Web handler tests cover real HTTP Host validation behind Next internals, opaque
frame policy, session isolation and same-host artifact rejection.

For manual browser acceptance, build the workspace and run
`pnpm dev:plugin-browser-fixture`. It starts only a guarded disposable PostgreSQL
database, the actual API and the actual Next Web application. The log reports a
private temporary `access.json` path containing the local fixture login and viewer
URL; it never prints fixture credentials. Use that disposable account, not an
existing user account. Stop the fixture with Ctrl+C to close listeners/Next and
remove its owned database container and temporary data. No publication or
production deployment occurs.

Local in-app browser acceptance verified real sign-in, the installed counter,
write and reload/read persistence, all four real frame isolation self-checks,
disabled direct-visit controls and denial from a stale viewer after installation
disable, with the database counter unchanged. This is one-browser local proof;
engine build metadata and a cross-browser matrix are not claimed. General MCP
plugin discovery, typed cross-capability invocation and a reviewed directory
remain separate pending work.
