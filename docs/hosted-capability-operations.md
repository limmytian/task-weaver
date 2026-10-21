# Operate hosted capabilities

Use this guide with [deployment](deployment.md), [authentication](authenticated-access.md),
[skill runtimes](skill-runtimes.md) and [MCP hosting](mcp-hosted-runtimes.md). Store actual hostnames, deployment commands,
resource allocations and acceptance records in project documents. Store secret values
in the deployment Secret facility, never in source, manifests or user instructions.

## Provision and expose only configured capabilities

- Keep the existing authenticated Web/API service and scoped credential model.
  One MCP entry does not grant a caller every capability or project.
- Configure approved `TW_SKILL_RUNTIME_PROFILES` and `TW_MCP_RUNTIME_PROFILES`
  with digest-pinned, pre-provisioned images. The trusted launcher needs an explicitly
  approved Linux container host; the default deployment does not enable it.
  Protect launcher/daemon access as privileged host control. Do not expose a Docker
  socket to skills, public endpoints or untrusted workloads.
- Skill workers require materialized artifacts on a filesystem visible to the
  trusted Docker daemon. Hosted MCP containers have no host mounts or network.
  Tools requiring external network access use approved remote endpoints; machine
  files/devices use the explicit credential-bound local bridge.
- Supply hosted MCP Secret references through `TW_MCP_SECRET_*` variables in the
  trusted launcher. Never put values in profile args, registration data, tool output,
  logs or client configuration. Rotate references and review the new profile hash;
  old connection fingerprints must not retain access.

After setup, explicitly synchronize approved MCP servers. Restoring a missing
Secret or profile alone does not establish healthy registration: inspect readiness,
resynchronize/reconnect, then make a reviewed test call. Registered metadata and an
old successful call are not current health guarantees.

## Backup and retention

Take a coordinated, restorable backup of PostgreSQL, skill-package object storage
(`SKILL_PACKAGE_STORAGE_DIR` for the local adapter), authentication/Secret facilities,
runtime profile configuration and the exact image
inventory. Do not copy secrets into the database backup notes. Immutable manifest
hashes do not substitute for the original artifact bytes or approved runtime image.

The database backup must include memory content/provenance/revisions and
`memory_receipts`; package versions/file inventories/storage references;
registry/policy/approval/audit records and authentication grants. Back up
related records consistently rather than exporting only active content rows.

Forgetting memory hides/deletes its content while retaining retry protection.
 Do not sweep receipts or tombstones because a page
looks empty: old requests must not resurrect forgotten or purged data. Database
backups have their own access, retention and deletion policy; a live purge does not
erase historical backups. Test restores in a separate environment.

## Upgrade and rollback

Record the reviewed source commit, migration journal, package/runtime version,
artifact/profile hashes, image digests and evidence before maintenance. Quiesce
writes and workers, take the coordinated backup, apply the ordered migrations,
then start the reviewed application. Verify authentication, package byte integrity,
memory recall, capability discovery, runtime readiness and an explicitly reviewed
isolated call. Confirm client/server tool schemas after upgrading stdio clients.

If acceptance fails, stop writes/workers before switching back. Do not assume that
an additive migration makes older binaries understand new transport, manifest or
lifecycle records. Restore the matching database/object/configuration snapshot when
compatibility has not been rehearsed, and account for writes after the backup.
A rollback can lose those writes and older receipt state; prevent old requests from
being replayed across a restore without reconciliation. Preserve immutable releases
and exact images; never retag a previous public artifact.

## Health and recovery

Use bootstrap for capability hints, `tw_mcp_readiness` / `tw mcp readiness` for
registration/configuration state, `tw_skill_runtimes_list` for trusted image and
interpreter readiness. Readiness timestamps describe observations, not permanent permission or
remote credential validity. Use live audit IDs and scoped activity for investigation.

Observe API failures/latency, unavailable reasons, connection cooldown/admission,
worker deadlines/output limits, artifact integrity and object-store failures. Avoid
logging arguments, result bodies, credentials or raw TLS/socket diagnostics. CLI
transport categories give safe failure classes without claiming a root cause.

Calls have bounded admission, output and deadlines. Failed initialization cools
down before explicit reconnect; a disconnected write may already have committed.
Inspect external state before retrying. Do not automatically replay external MCP
calls or skill execution. Use identical payload/key retries only for documented
receipt-backed operations. Revoked grants, runtime profiles or
Secret references must deny cached and new operations.

After a launcher crash, reconcile only owned worker containers using the documented
runtime labels and execution inventory. Do not remove unrelated containers. If the
container daemon is unreachable, cleanup is unconfirmed and requires operator
reconciliation before resuming work.

## Release handoff

The source maintainer records completed source checks and the supported client
matrix in Task Weaver. Vendor native UI/OAuth flows require separate named proof;
generic SDK HTTP/stdio tests certify only those paths. Before release, the owner
reviews the candidate notes, backup/restore rehearsal, runtime configuration and
private-registry acceptance deployment. Main integration, immutable publication and
public-image deployment verification remain separately authorized delivery actions.
