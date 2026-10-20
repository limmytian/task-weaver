# Isolated hosted MCP servers

The registry distinguishes three remote/client paths and one hosted path:

- `sse` and `streamable-http` connect to an existing remote MCP endpoint.
- `stdio` remains a credential-bound client mailbox for local files and devices.
- `hosted-stdio` launches an approved server inside a restricted Docker container.
  The connecting agent needs no local server package or language runtime.

Hosting is opt-in and disabled without operator configuration. A dedicated Linux
Docker host must enforce CPU, memory and process limits and contain the exact
approved image. Task Weaver never pulls images or installs packages automatically.
The default deployment does not provision Docker access.

## Trusted profiles and scoped Secrets

Set `TW_MCP_RUNTIME_PROFILES` in the runtime launcher's environment to at most 16
profiles. The shared `hostedMcpRuntimeProfileSchema` validates each profile:

- `id`, digest-pinned `image`, absolute container `command`, bounded fixed `args`.
- Explicit allowed `projectIds`, `personalActorIds` and/or `global: true`.
  A profile cannot be selected outside its approved resource scopes.
- Optional `secretReferences`: application environment names mapped to operator
  environment references with the `TW_MCP_SECRET_` prefix. Referenced values must
  exist. Runtime-control environment names are rejected.

Parse the profile through the shared schema to apply defaults, then calculate
`capabilityDigest(profile)`. Register a server with `transport: "hosted-stdio"`
and `config: { profileId, profileHash }`. Registry management grants are still
required. Changing a profile requires a newly confirmed hash; losing a Secret
reference or scope allowance prevents cached invocation. Secret values never
enter registration records, command arguments, tool schemas or audit payloads.
The configured Secret facility supplies those environment references to the
trusted launcher; this does not add a new general-purpose credential vault.

Call the existing server synchronization endpoint to initialize and index tools.
Calls use the same scoped registry approvals, policy checks and inbound bridge as
remote servers. Missing runtime configuration is an availability failure.

## Isolation and lifecycle

Hosted containers use a non-root user, read-only image, no host mounts, no network,
no privilege escalation, no capabilities, 64 processes, 256 MiB memory and one CPU.
Temporary storage is limited to 32 MiB. Image volumes receive bounded read-only
mount overrides. Fixed image dependencies must already be present. These workers
support offline tools; services requiring network access should use a separately
hosted remote connector. No unrestricted egress mode is implied.

The JSON-lines transport caps each protocol message at 1 MiB and discards server
stderr without returning raw host diagnostics. Runtime Secrets are redacted from
returned values. Outputs remain untrusted; redaction is defense in depth and does
not make arbitrary secret-handling server code trustworthy.

Connections are partitioned by verified credential and configuration/Secret
fingerprint. Initialization is coalesced and bounded; the pool permits at most 64
connections/initializations and at most 16 active hosted containers. Initialization
has a 10-second protocol deadline. Disconnection removes the container; the next
explicit call may reconnect but dispatched tool writes are never automatically
replayed. Idle and invalidated runtime connections are reaped. Operator
supervision must reconcile `task-weaver.mcp-runtime=true` containers after a host
or launcher crash; an unreachable Docker daemon prevents confirmed cleanup.

Remote initialization and schema retrieval happen outside the identity lifecycle
transaction. Scope, registration and profile are rechecked before a bounded,
atomic schema update, so a slow server does not hold the global authorization
lock. Authorization and pinned runtime state are rechecked before releasing call
results. Registered metadata alone does not certify current runtime health.
