import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { type Database, pluginInstallations, pluginGenerations, pluginLifecycleReceipts, pluginStorage, pluginInvocationReceipts } from "@task-weaver/db";
import { installPluginSchema, upgradePluginSchema, recoverPluginSchema, changePluginStatusSchema, pluginManifestSchema, ConflictError, NotFoundError, ValidationError, AuthorizationError, stableActorReferenceSchema, type PluginManifest, type VerifiedRequestContext } from "@task-weaver/contracts";
import { capabilityDigest } from "./capability-digest";
import { resourceAuthority, resourcePredicate, requireScope, personalResourceOwnerId, type ResourceScope } from "./resource-authorization";
import { auditIdentity, lockIdentityLifecycle } from "./auth-security";
import { verifyPluginManifest, type PluginTrustKey } from "./plugin-trust";
import { planPluginState } from "./plugin-state";
import type { PluginExecution } from "./plugin-broker";

type Installation = typeof pluginInstallations.$inferSelect;
type Configuration = { keys: Readonly<Record<string, PluginTrustKey>>; allowUnverified?: boolean };
type Preparation = (manifest: PluginManifest, signal: AbortSignal) => Promise<PluginExecution>;
const scopeKey = (scope: ResourceScope) => scope.projectId ? `project:${scope.projectId}` : scope.personalOwnerId ? `personal:${scope.personalOwnerId}` : "global";

/** The exact ordered permission delta is a review binding, independent of product versions. */
export function pluginPermissionDiff(current: PluginManifest, next: PluginManifest) {
  const added = next.permissions.filter(value => !current.permissions.includes(value)).sort();
  const removed = current.permissions.filter(value => !next.permissions.includes(value)).sort();
  return { added, removed, hash: capabilityDigest({ added, removed }) };
}

export function createPluginLifecycle(db: Database, identity: VerifiedRequestContext, configuration: () => Configuration, prepare: Preparation) {
  const transaction = <T>(fn: (tx: Database) => Promise<T>) => db.transaction(async transaction => {
    const tx = transaction as unknown as Database;
    await lockIdentityLifecycle(tx);
    return fn(tx);
  });
  const authorizeScope = async (tx: Database, scope: ResourceScope, activate = false) => {
    const authority = await resourceAuthority(tx, identity);
    if (authority.bounds) throw new AuthorizationError();
    requireScope(authority, scope, "resource.read");
    requireScope(authority, scope, "resource.write");
    requireScope(authority, scope, "mcp.manage");
    if (activate) requireScope(authority, scope, "mcp.invoke");
    return authority;
  };
  const installation = async (tx: Database, id: string, activate = false) => {
    stableActorReferenceSchema.parse({ id, type: "human" });
    const authority = await resourceAuthority(tx, identity);
    const [row] = await tx.select().from(pluginInstallations).where(and(eq(pluginInstallations.id, id), resourcePredicate(authority, pluginInstallations))).for("update");
    if (!row) throw new NotFoundError("Resource not found");
    await authorizeScope(tx, row, activate);
    if (row.scopeKey !== scopeKey(row)) throw new ValidationError("Plugin installation scope integrity failed");
    return row;
  };
  const receipt = async (tx: Database, scope: string, key: string, payloadHash: string) => {
    const [record] = await tx.select().from(pluginLifecycleReceipts).where(and(eq(pluginLifecycleReceipts.actorId, identity.actor.id), eq(pluginLifecycleReceipts.scopeKey, scope), eq(pluginLifecycleReceipts.key, key)));
    if (record && record.payloadHash !== payloadHash) throw new ConflictError("Plugin lifecycle key was already used for another operation", record.revision);
    return record;
  };
  const summary = (row: Installation, revision: number, replayed: boolean) => ({ installationId: row.id, operationRevision: revision, currentRevision: row.revision, status: row.status, manifestHash: row.manifestHash, replayed });
  const saveReceipt = async (tx: Database, row: Installation, key: string, payloadHash: string) => {
    await tx.insert(pluginLifecycleReceipts).values({ actorId: identity.actor.id, scopeKey: row.scopeKey, key, installationId: row.id, payloadHash, revision: row.revision });
    return summary(row, row.revision, false);
  };
  const verify = (manifest: PluginManifest, confirmedHash: string) => {
    const config = configuration();
    const verified = verifyPluginManifest(manifest, config.keys, config.allowUnverified);
    if (verified.manifestHash !== confirmedHash) throw new ConflictError("Confirm the exact plugin manifest hash", 0);
    // No same-origin fallback while the dedicated artifact gateway/viewer is not implemented.
    if (manifest.frontend || !manifest.backend) throw new ValidationError("Plugin frontend hosting is not available; only backend-only installations are supported");
    return verified;
  };
  const preflight = async <T>(manifest: PluginManifest, signal: AbortSignal, activate: (execution: PluginExecution) => Promise<T>) => {
    const execution = await prepare(manifest, signal);
    try {
      await execution.revalidate();
      const result = await execution.execute({ method: "__tw_preflight", input: { hostProtocol: 1 }, state: [] }, signal);
      planPluginState([], result, false);
      await execution.revalidate();
      signal.throwIfAborted();
      return await activate(execution);
    } finally { await execution.dispose(); }
  };
  const checkRevision = (row: Installation, expected: number) => {
    if (row.revision !== expected || row.revision >= 2147483647) throw new ConflictError("Plugin installation revision changed or reached its limit", row.revision);
  };
  const compatible = (row: Installation, next: PluginManifest, diffHash: string) => {
    const current = pluginManifestSchema.parse(row.manifest);
    if (capabilityDigest(current) !== row.manifestHash) throw new ValidationError("Plugin installation manifest integrity failed");
    if (row.status === "uninstalled") throw new ConflictError("Uninstalled plugins cannot be reactivated; install a new instance", row.revision);
    if (current.pluginId !== next.pluginId || row.pluginId !== next.pluginId) throw new ValidationError("Plugin identity cannot change");
    if (current.storageSchemaVersion !== next.storageSchemaVersion) throw new ValidationError("Plugin storage schema changes require a host-controlled migration");
    if (current.signature && !next.signature) throw new ValidationError("Verified plugin publisher trust cannot be downgraded");
    if (pluginPermissionDiff(current, next).hash !== diffHash) throw new ConflictError("Confirm the current plugin permission diff", row.revision);
  };
  const generation = async (tx: Database, row: Installation, manifest: PluginManifest, manifestHash: string, trust: "verified" | "unverified") => {
    const [known] = await tx.select().from(pluginGenerations).where(and(eq(pluginGenerations.installationId, row.id), eq(pluginGenerations.version, manifest.version)));
    if (known && known.manifestHash !== manifestHash) throw new ConflictError("Plugin version is immutable", row.revision);
    if (!known) await tx.insert(pluginGenerations).values({ installationId: row.id, version: manifest.version, manifest, manifestHash, trust });
  };
  return {
    install: async (raw: unknown, signal: AbortSignal) => {
      const input = installPluginSchema.parse(raw);
      const scope: ResourceScope = input.scope.kind === "project" ? { projectId: input.scope.projectId.toLowerCase() } : input.scope.kind === "personal" ? { personalOwnerId: personalResourceOwnerId(identity), personalOwnerType: "human" } : {};
      const key = scopeKey(scope), payloadHash = capabilityDigest({ operation: "install", input });
      const check = async (tx: Database) => {
        await authorizeScope(tx, scope, true);
        const record = await receipt(tx, key, input.idempotencyKey, payloadHash);
        if (record) {
          const row = await installation(tx, record.installationId, true);
          if (row.status === "uninstalled") throw new ConflictError("Old install receipts cannot resurrect an uninstalled plugin", row.revision);
          return summary(row, record.revision, true);
        }
        const [existing] = await tx.select({ id: pluginInstallations.id }).from(pluginInstallations).where(and(eq(pluginInstallations.scopeKey, key), eq(pluginInstallations.pluginId, input.manifest.pluginId), ne(pluginInstallations.status, "uninstalled")));
        if (existing) throw new ConflictError("Plugin is already installed in this scope", 0);
      };
      const replay = await transaction(check);
      if (replay) return replay;
      verify(input.manifest, input.confirmedManifestHash);
      return preflight(input.manifest, signal, execution => transaction(async tx => {
        const replay = await check(tx);
        if (replay) return replay;
        const verified = verify(input.manifest, input.confirmedManifestHash);
        await execution.revalidate(tx);
        signal.throwIfAborted();
        const [row] = await tx.insert(pluginInstallations).values({ id: randomUUID(), ...scope, scopeKey: key, createdBy: identity.actor.id, pluginId: input.manifest.pluginId, manifest: input.manifest, manifestHash: verified.manifestHash, status: "active" }).returning();
        await generation(tx, row!, input.manifest, verified.manifestHash, verified.trust);
        await auditIdentity(tx, "plugin.install", identity.actor.id, identity.actor.id, row!.id, { manifestHash: verified.manifestHash, revision: 1 });
        return saveReceipt(tx, row!, input.idempotencyKey, payloadHash);
      }));
    },
    activate: async (id: string, operation: "upgrade" | "recover", raw: unknown, signal: AbortSignal) => {
      const input = operation === "upgrade" ? upgradePluginSchema.parse(raw) : recoverPluginSchema.parse(raw);
      const payloadHash = capabilityDigest({ operation, installationId: id, input });
      const initial = await transaction(async tx => {
        const row = await installation(tx, id, true);
        const record = await receipt(tx, row.scopeKey, input.idempotencyKey, payloadHash);
        if (record) {
          if (row.status === "uninstalled") throw new ConflictError("Uninstalled plugins cannot be reactivated", row.revision);
          return { row, replay: summary(row, record.revision, true) };
        }
        checkRevision(row, input.expectedRevision);
        const known = "version" in input ? await tx.query.pluginGenerations.findFirst({ where: and(eq(pluginGenerations.installationId, id), eq(pluginGenerations.version, input.version)) }) : undefined;
        const next = "manifest" in input ? input.manifest : known ? pluginManifestSchema.parse(known.manifest) : undefined;
        if (!next) throw new NotFoundError("Plugin generation not found");
        compatible(row, next, input.confirmedPermissionDiffHash);
        // Check immutable versions before potentially expensive worker preparation.
        const version = await tx.query.pluginGenerations.findFirst({ where: and(eq(pluginGenerations.installationId, id), eq(pluginGenerations.version, next.version)) });
        if (version && version.manifestHash !== input.confirmedManifestHash) throw new ConflictError("Plugin version is immutable", row.revision);
        return { row, next };
      });
      if (initial.replay) return initial.replay;
      const next = initial.next!;
      verify(next, input.confirmedManifestHash);
      return preflight(next, signal, execution => transaction(async tx => {
        const row = await installation(tx, id, true);
        const record = await receipt(tx, row.scopeKey, input.idempotencyKey, payloadHash);
        if (record) {
          if (row.status === "uninstalled") throw new ConflictError("Uninstalled plugins cannot be reactivated", row.revision);
          return summary(row, record.revision, true);
        }
        checkRevision(row, input.expectedRevision);
        compatible(row, next, input.confirmedPermissionDiffHash);
        const verified = verify(next, input.confirmedManifestHash);
        await execution.revalidate(tx);
        await generation(tx, row, next, verified.manifestHash, verified.trust);
        signal.throwIfAborted();
        const [updated] = await tx.update(pluginInstallations).set({ manifest: next, manifestHash: verified.manifestHash, revision: row.revision + 1, status: "active", updatedAt: new Date() }).where(eq(pluginInstallations.id, id)).returning();
        await auditIdentity(tx, `plugin.${operation}`, identity.actor.id, identity.actor.id, id, { manifestHash: verified.manifestHash, revision: updated!.revision });
        return saveReceipt(tx, updated!, input.idempotencyKey, payloadHash);
      }));
    },
    changeStatus: async (id: string, raw: unknown) => {
      const input = changePluginStatusSchema.parse(raw), payloadHash = capabilityDigest({ operation: "status", installationId: id, input });
      return transaction(async tx => {
        const row = await installation(tx, id);
        const record = await receipt(tx, row.scopeKey, input.idempotencyKey, payloadHash);
        if (record) return summary(row, record.revision, true);
        checkRevision(row, input.expectedRevision);
        if (row.status === "uninstalled" && input.action !== "purge") throw new ConflictError("Plugin is uninstalled", row.revision);
        if (input.action === "purge") {
          if (row.status === "active") throw new ConflictError("Disable or uninstall the plugin before purging its data", row.revision);
          await tx.delete(pluginStorage).where(eq(pluginStorage.installationId, id));
          await tx.update(pluginInvocationReceipts).set({ result: null }).where(eq(pluginInvocationReceipts.installationId, id));
        }
        const [updated] = await tx.update(pluginInstallations).set({ revision: row.revision + 1, status: input.action === "disable" ? "disabled" : "uninstalled", updatedAt: new Date() }).where(eq(pluginInstallations.id, id)).returning();
        await auditIdentity(tx, `plugin.${input.action}`, identity.actor.id, identity.actor.id, id, { revision: updated!.revision });
        return saveReceipt(tx, updated!, input.idempotencyKey, payloadHash);
      });
    },
  };
}
