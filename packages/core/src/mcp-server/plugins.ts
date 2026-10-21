import { and, desc, eq, isNull } from "drizzle-orm";
import { type Database, pluginInstallations } from "@task-weaver/db";
import { AuthorizationError, CAPABILITY_LIMITS, NotFoundError, ValidationError, pluginManifestSchema, type PluginManifest, type VerifiedRequestContext } from "@task-weaver/contracts";
import { personalResourceOwnerId, resourceAuthority, resourcePredicate, requireScope } from "../services/resource-authorization";
import { invokeInstalledPlugin, type PluginExecution } from "../services/plugin-broker";
import { mcpPolicy, mcpScopeKey } from "../services/mcp-security";
import { DeferredMcpOperation } from "./security";

export type McpPluginRuntime = { prepare(manifest: PluginManifest, signal: AbortSignal): Promise<PluginExecution> };

export async function readPluginTarget(db: Database, identity: VerifiedRequestContext, id: string) {
  const authority = await resourceAuthority(db, identity);
  const [row] = await db.select().from(pluginInstallations).where(and(eq(pluginInstallations.id, id), resourcePredicate(authority, pluginInstallations)));
  if (!row) throw new NotFoundError("Resource not found");
  return row;
}

/** Discovery loads metadata only. Every execution uses the same live broker as REST. */
export async function pluginOperation(db: Database, liveDb: Database, identity: VerifiedRequestContext, operation: "list" | "get" | "call", raw: Record<string, unknown>, runtime: McpPluginRuntime | undefined, signal: AbortSignal) {
  if (operation === "list") {
    if (raw.scope === "project" ? !raw.projectId : !!raw.projectId) throw new ValidationError("Project scope requires projectId; other scopes forbid it");
    const authority = await resourceAuthority(db, identity);
    const scope = raw.scope === "project" ? eq(pluginInstallations.projectId, raw.projectId as string)
      : raw.scope === "personal" ? and(isNull(pluginInstallations.projectId), eq(pluginInstallations.personalOwnerId, personalResourceOwnerId(identity)))
      : and(isNull(pluginInstallations.projectId), isNull(pluginInstallations.personalOwnerId));
    const rows = await db.select({ id: pluginInstallations.id, pluginId: pluginInstallations.pluginId, revision: pluginInstallations.revision, status: pluginInstallations.status, manifestHash: pluginInstallations.manifestHash }).from(pluginInstallations)
      .where(and(resourcePredicate(authority, pluginInstallations), scope)).orderBy(desc(pluginInstallations.updatedAt), pluginInstallations.id).limit((raw.limit as number) + 1).offset(raw.offset as number);
    const items: typeof rows = [];
    for (const row of rows.slice(0, raw.limit as number)) {
      if (Buffer.byteLength(JSON.stringify({ items: [...items, row] })) > CAPABILITY_LIMITS.summaryBytes - 512) break;
      items.push(row);
    }
    return { items, meta: { limit: raw.limit, offset: raw.offset, hasMore: rows.length > items.length, nextOffset: rows.length > items.length ? (raw.offset as number) + items.length : null, manifestLoading: "on_demand", runtimeReadiness: "checked_on_call" } };
  }
  const row = await readPluginTarget(db, identity, raw.installationId as string);
  if (operation === "get") return { id: row.id, pluginId: row.pluginId, status: row.status, revision: row.revision, manifestHash: row.manifestHash, manifest: pluginManifestSchema.parse(row.manifest), runtimeReadiness: "checked_on_call", untrustedManifest: true };
  if (!runtime) throw new ValidationError("The isolated plugin runtime is unavailable");
  const policy = await mcpPolicy(db, mcpScopeKey(row), "tw_plugins_call");
  const { installationId, ...input } = raw;
  return new DeferredMcpOperation(async () => {
    const result = await invokeInstalledPlugin(liveDb, identity, installationId as string, input, async (manifest, workerSignal) => {
      const execution = await runtime.prepare(manifest, workerSignal);
      return {
        ...execution,
        revalidate: async (connection = liveDb, checkSignal) => {
          const authority = await resourceAuthority(connection, identity);
          requireScope(authority, row, "resource.write");
          requireScope(authority, row, "mcp.invoke");
          if (JSON.stringify(await mcpPolicy(connection, mcpScopeKey(row), "tw_plugins_call")) !== JSON.stringify(policy)) throw new AuthorizationError();
          await execution.revalidate(connection, checkSignal);
        },
      };
    }, signal);
    return { installationId, untrustedOutput: true, ...result };
  }, async () => {});
}
