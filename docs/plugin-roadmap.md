# Deferred Plugin Ecosystem Roadmap

Status: low-priority planning only, not scheduled implementation. One Task Weaver
application hosts official and third-party extensions; there is no separate Pro
application. A catalog is a later distribution layer, not a substitute for safe
runtime integration. Payments, ratings and marketplace UI are not current scope.

## Security boundary

- Run backend plugins in isolated processes/containers. In-process arbitrary code
  is trusted application code and cannot be sandboxed by permission declarations.
- Keep host DB credentials, arbitrary SQL, host secrets/files and application
  tokens outside plugins. Apply resource, network and filesystem restrictions.
- Expose scoped host APIs; check plugin grant AND caller/user/project authority
  for every operation. Plugin identity never upgrades caller privileges.
- Provide plugin-owned storage with enforced namespace ownership. Deny direct
  Core-table access and cross-plugin storage access; Core writes go through
  existing validation, events and audit. Migrations are host-controlled with
  restricted declarative operations, not uploaded privileged SQL.
- Isolate frontend code with a narrow message bridge and enforce origins/request
  provenance. Do not provide the host session token to plugin code.
- Require reviewed permission diffs for install/upgrade, revocable scoped grants,
  audit records, execution limits and credential rotation/revocation behavior.

## Planning phases

1. Define threat model, identities, host API scopes and isolated storage contracts.
2. Define versioned manifests, artifacts, lifecycle, compatibility/conflicts,
   resource limits, installation approval, disable/recovery and data retention.
3. Verify one small real-host plugin providing a page, namespaced API and owned
   storage. Demonstrate denial of Core/other-plugin data and secrets, permission
   revocation, malicious inputs, upgrades and recovery. No alternate application
   fork or hand-built demonstration host is sufficient for acceptance.
4. Evaluate a plugin directory, provenance, maintenance ownership and distribution
   after the runtime proof. Commercial extensions use the same stable boundaries.

Extensibility may include new modules/pages/routes and explicit UI/behavior hooks;
those surfaces must remain brokered and conflict-checked. Unrestricted API
replacement or DOM/DB mutation is not a stable extension contract. Current
application functionality remains independent of installing or licensing plugins.
