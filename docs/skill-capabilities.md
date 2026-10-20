# Skill capability resolution

Use `tw_skill_packages_resolve` with a package ID and optional exact version.
An omitted version selects the current active version once; the response pins
the actual version and a digest. Nodes are ordered with dependencies first and
contain references, scopes and hashes, not recursively loaded text or tool
schemas. `executionAuthorized: false` is deliberate: resolution never grants
access, launches scripts or authorizes invocation.

Package declarations use the version manifest's `capabilities` field:

```json
{
  "capabilities": {
    "executionMode": "instructions",
    "dependencies": [
      {
        "reference": {
          "kind": "skill_package",
          "id": "11111111-1111-4111-8111-111111111111"
        },
        "version": "1.0",
        "required": true
      }
    ]
  }
}
```

Without this field a package is instruction-only with no declared dependencies.
Package dependencies require exact versions. Skill document references pin a
positive integer document revision. External MCP tool references resolve only
with a currently authorized invocation path; the version pins the tool name,
schema and trusted authorization declarations by hash. Other kinds are reported
as unavailable rather than implying an unimplemented runtime.

The resolver rejects cycles, incompatible versions and graphs exceeding 100
distinct lookups or 16 levels. Each node has at most 32 dependencies; unavailable
optional dependencies also count against the lookup budget. A missing or
unauthorized required dependency prevents resolution. Optional dependencies are
reported uniformly as unavailable without leaking their names or contents.
The serialized result is capped at 64 KiB. Every resolution and subsequent read
uses current caller grants and package/version status.

Read pinned package files using their exact version and path. Use
`tw_context_get` with `expectedVersion` for a pinned skill document. If a document
changes, the stale pin fails; deliberately resolve a revised package declaration
instead of silently mixing revisions. Readability is separate from executable
readiness. An `isolated` or `local_required` declaration does not itself provision
an execution worker or local bridge.

Registering an existing package version is an idempotent operation only when its
entry point, manifest and file hashes/flags are identical. Changed content needs
a new version. File order does not matter. Version status may still be explicitly
deprecated or revoked. Managed presets already derive versions from content
hashes, so source changes naturally create a new version.

Package text is served from an indexed document only when its hash still matches
the immutable file. Otherwise the stored original is used and its hash verified.
Editing an independent indexed document cannot replace bytes in a pinned package;
corrupt storage is rejected. Storage keys, arbitrary manifest metadata and secret
configuration are not included in dependency resolution.
