import type { Database } from "@task-weaver/db";
import { mcpServerReadinessSchema, NotFoundError, type CapabilityAvailability, type VerifiedRequestContext } from "@task-weaver/contracts";
import { requireMcpServer } from "./mcp-authorization";
import { resourceAuthority, canAccessResource } from "./resource-authorization";
import { resolveHostedMcpRuntime } from "./mcp-hosted-runtime";
import type { McpPool } from "./mcp-registry";

export async function getMcpServerReadiness(db: Database, context: VerifiedRequestContext, serverId: string, pool: McpPool) {
  const authority = await resourceAuthority(db, context);
  const server = await requireMcpServer(db, authority, context, serverId);
  if (!canAccessResource(authority, server, "mcp.invoke") && !canAccessResource(authority, server, "mcp.manage")) throw new NotFoundError("Resource not found");
  const connected = server.transport === "stdio" ? server.status === "connected" && Boolean(server.expiresAt && server.expiresAt > new Date()) : pool.isConnected(server.id);
  let availability: CapabilityAvailability = { state: "unavailable", reason: "unhealthy", remediation: "Synchronize this server to validate its configuration, credentials and protocol initialization." };
  let credentials: "unknown" | "not_required" | "configured" | "missing" = "unknown";
  let runtime: { profileId: string; profileHash: string; image: string; network: "none" } | undefined;
  if (server.active && server.status === "connected" && connected) availability = { state: "available", executionMode: server.transport === "hosted-stdio" ? "isolated" : server.transport === "stdio" ? "local_required" : "remote" };
  if (server.transport === "hosted-stdio") {
    try {
      const resolved = resolveHostedMcpRuntime(server);
      runtime = { profileId: resolved.profile.id, profileHash: (server.config as { profileHash: string }).profileHash, image: resolved.profile.image, network: "none" };
      credentials = Object.keys(resolved.profile.secretReferences).length ? "configured" : "not_required";
    } catch {
      credentials = "missing";
      availability = { state: "unavailable", reason: "not_configured", remediation: "Ask an administrator to restore the approved runtime profile, allowed scope and referenced Secrets, then synchronize." };
    }
  } else if (server.transport === "stdio") {
    credentials = "not_required";
    if (!connected) availability = { state: "unavailable", reason: "local_bridge_required", remediation: "Start the registered local bridge with its original credential and renew its heartbeat." };
  }
  if (!server.active) availability = { state: "unavailable", reason: "not_configured", remediation: "An authorized manager must enable this server before synchronization or invocation." };
  return mcpServerReadinessSchema.parse({ serverId, transport: server.transport, checkedAt: new Date().toISOString(), connected, availability, credentials, runtime,
    guidance: "Observed connection and configuration state only; every call rechecks live policy and targets. Remote credential validity is established by the upstream service. Dispatched writes are not automatically retried." });
}
