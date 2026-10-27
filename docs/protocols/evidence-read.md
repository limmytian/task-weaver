# Evidence read protocol, version 1

This document specifies the contract for the evidence inspector. The descriptor and message schemas in `@task-weaver/contracts` are available; the producer transport and inspector are not enabled by these schemas alone.

## Identity and access

A reader requests a registered `outputId` and a purpose (`preview`, `download`, or `promotion`). The API resolves the output, its requirement and project from the database and checks current `resource.read`; promotion additionally requires `resource.write`. Every subsequent read and promotion rechecks authorization, including membership and credential revocation. A request never supplies a host path, Git remote, command, or URL for the API to fetch. URL and comment outputs are not local-file evidence.

A public descriptor contains the output, project, and requirement IDs, availability and immutable source identity. Local identity is the producing node, registered full size and SHA-256. Attachment identity is the document and immutable file-version ID, size and SHA-256. Git identity is the authorized requirement repository link and exact head object ID. Legacy outputs missing an immutable identity are `unsupported` until a separately authorized registration supplies one. Relative paths and credentials never appear in a public descriptor or a browser request.

## Producer channel

A read demand is created only after authorization and source selection. It has a random request ID and nonce, an absolute expiry at most 30 seconds away, one output and manifest fingerprint, and the exact daemon and node chosen by the API. The daemon authenticates using its own verified actor and registration; the API verifies both daemon ownership and the node binding on poll, response, and cancellation. A node ID by itself is not authentication. The producer retrieves the registered relative path only through this authenticated, output-bound channel; it never accepts a caller-provided path or another output's manifest. The same actor's unrelated daemon cannot satisfy a demand addressed to a different daemon.

The API stores or atomically owns request state: pending, streaming, completed, cancelled, expired, or failed. Responses carry request ID, daemon ID, output ID, nonce and monotonically increasing sequence. Accept each sequence once, reject stale or duplicate final responses, and close requests on expiration, cancellation, permission revocation, producer disconnect, identity mismatch, or fingerprint mismatch. A response is not reusable for a later request. No response grants task execution authority. Do not log artifact content, path, nonce, credentials or raw transport bodies.

The producer opens the registered artifact beneath its configured root without following symlinks, rejects nonregular files and path replacement, and keeps a stable file descriptor. It verifies the entire object's registered size and SHA-256 before sending any bytes as verified. A sampled hash is never a full-file verification. A 100 MiB full verification ceiling, 30-second deadline and two concurrent reads per node are initial server-enforced ceilings, not measured performance guarantees. Reads support cancellation and backpressure; an interrupted transfer is not a successful verification. Cached verified objects, if introduced, must bind the complete immutable identity and authorization context.

## Rendering, Git and durable storage

Read a matching immutable attachment version first when a verified promotion exists. A missing or offline source may allow an explicitly defined fallback to the matching producer; permission denial, corruption and identity mismatch never do. Promotion verifies full bytes, atomically binds one immutable attachment version to the historical output, and is idempotent. It does not delete local files or approve any workflow stage. Failed uploads need cleanup before promotion is reported complete.

Preview only safe formats within their separate limits. Text and tables are inert and escaped; do not execute spreadsheet formulas. HTML, SVG and unknown active formats are download-only. Browser responses use a restrictive content security policy, `nosniff`, sanitized filenames and no automatic remote content. Initial limits are 256 KiB for text/table input, 100 rows by 50 columns, 10 MiB for inline media/PDF, and 200 files / 1 MiB rendered Git diff. Indicate truncation and keep explicit original download separate from preview.

Git comparison creation pins authorized base and head object IDs and the comparison mode; default to merge-base through head. All pages use those IDs even if a branch later moves. Resolve the repository from the authorized output, disable hooks, external diff and text conversion, and treat binary, missing, oversized and renamed files as explicit states.

## Availability and compatibility

`available`, `offline`, `missing`, `changed`, `retired`, `unsupported`, and `too_large` are distinct outcomes. `offline` describes producer reachability, not evidence deletion; `changed` never falls through to another source without matching immutable identity. Existing output rows remain valid: no reinterpretation of their IDs, paths or checksums is required. Durable attachment bindings and request state require additive migrations, and old daemon versions must report the channel unsupported until they advertise the protocol capability. Deploy the API and producer compatibly before exposing node reads. Existing attachment downloads and direct workflow operations remain unchanged.
