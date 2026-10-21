import { and, eq } from "drizzle-orm";
import { type Database, pluginInstallations, pluginStorage, pluginInvocationReceipts } from "@task-weaver/db";
import { invokePluginSchema, pluginManifestSchema, ConflictError, NotFoundError, ValidationError, stableActorReferenceSchema, type VerifiedRequestContext } from "@task-weaver/contracts";
import { resourceAuthority, resourcePredicate, requireScope } from "./resource-authorization";
import { lockIdentityLifecycle, auditIdentity } from "./auth-security";
import { capabilityDigest } from "./capability-digest";
import { planPluginState } from "./plugin-state";

export type PluginExecution = {
  /** A trusted host implementation, never an uploaded callback or Core API proxy. */
  execute(input: { method: string; input: unknown; state: Array<{ key: string; version: number; value: unknown; deleted: number }> }, signal: AbortSignal): Promise<unknown>;
  revalidate(connection?: Database): Promise<void>;
  dispose(): Promise<void>;
};

/** No worker execution occurs while holding the identity lifecycle or installation lock. */
export async function invokeInstalledPlugin(db: Database, identity: VerifiedRequestContext, installationId: string, raw: unknown,
  prepare: (manifest: ReturnType<typeof pluginManifestSchema.parse>, signal: AbortSignal) => Promise<PluginExecution>, signal: AbortSignal) {
  stableActorReferenceSchema.parse({ id: installationId, type: "human" });
  const input = invokePluginSchema.parse(raw);
  const payloadHash = capabilityDigest(input);
  const guarded = async (tx: Database) => {
    const authority = await resourceAuthority(tx, identity);
    const [row] = await tx.select().from(pluginInstallations).where(and(eq(pluginInstallations.id, installationId), resourcePredicate(authority, pluginInstallations))).for("update");
    if (!row) throw new NotFoundError("Resource not found");
    if (row.status !== "active" || row.revision !== input.expectedRevision) throw new ConflictError("Plugin installation is inactive or changed", row.revision);
    const manifest = pluginManifestSchema.parse(row.manifest);
    if (manifest.pluginId !== row.pluginId || capabilityDigest(manifest) !== row.manifestHash) throw new ValidationError("Plugin installation manifest integrity failed");
    const method = manifest.methods.find(method => method.name === input.method);
    if (!method || !manifest.backend || !manifest.permissions.includes("backend.execute")) throw new ValidationError("Plugin method is unavailable");
    requireScope(authority, row, "mcp.invoke");
    if (method.access === "write") requireScope(authority, row, "resource.write");
    const writable = method.access === "write" && manifest.permissions.includes("storage.write");
    const [receipt] = await tx.select().from(pluginInvocationReceipts).where(and(eq(pluginInvocationReceipts.installationId, row.id), eq(pluginInvocationReceipts.actorId, identity.actor.id), eq(pluginInvocationReceipts.key, input.idempotencyKey)));
    if (receipt && (receipt.payloadHash !== payloadHash || receipt.revision !== row.revision)) throw new ConflictError("Plugin invocation key was already used for another payload or revision", row.revision);
    const state = await tx.select({ key: pluginStorage.key, version: pluginStorage.version, value: pluginStorage.value, deleted: pluginStorage.deleted }).from(pluginStorage).where(eq(pluginStorage.installationId, row.id)).limit(33);
    // Verify persisted quotas before exposing any data to an untrusted worker.
    planPluginState(state, { result: null }, false);
    return { row, manifest, writable, receipt, state: manifest.permissions.includes("storage.read") ? state : [] };
  };
  const transaction = <T>(operation: (tx: Database) => Promise<T>) => db.transaction(async tx => {
    const connection = tx as unknown as Database;
    await lockIdentityLifecycle(connection);
    signal.throwIfAborted();
    return operation(connection);
  });
  const initial = await transaction(guarded);
  const execution = await prepare(initial.manifest, signal);
  try {
    await execution.revalidate();
    if (initial.receipt) return transaction(async tx => {
      const current = await guarded(tx);
      await execution.revalidate(tx);
      if (!current.receipt) throw new ConflictError("Plugin receipt is no longer available", current.row.revision);
      signal.throwIfAborted();
      return { result: current.receipt.result, replayed: true, revision: current.row.revision };
    });
    const revoked = new AbortController();
    const runningSignal = AbortSignal.any([signal, revoked.signal]);
    let checkFlight: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (checkFlight) return;
      checkFlight = transaction(guarded).then(() => execution.revalidate()).catch(() => revoked.abort()).finally(() => { checkFlight = undefined; });
    }, 1000);
    timer.unref();
    let result: unknown;
    try {
      result = await execution.execute({ method: input.method, input: input.input, state: initial.state }, runningSignal);
      runningSignal.throwIfAborted();
    } finally { clearInterval(timer); await checkFlight; }
    await execution.revalidate();
    return await transaction(async tx => {
      const current = await guarded(tx);
      await execution.revalidate(tx);
      if (current.row.manifestHash !== initial.row.manifestHash) throw new ConflictError("Plugin generation changed during execution", current.row.revision);
      if (current.receipt) return { result: current.receipt.result, replayed: true, revision: current.row.revision };
      // Always plan against all current rows, even if the worker cannot read storage.
      const state = await tx.select().from(pluginStorage).where(eq(pluginStorage.installationId, installationId)).limit(33);
      const planned = planPluginState(state, result, current.writable);
      signal.throwIfAborted();
      for (const change of planned.changes) await tx.insert(pluginStorage).values({ installationId, ...change }).onConflictDoUpdate({ target: [pluginStorage.installationId, pluginStorage.key], set: change });
      await tx.insert(pluginInvocationReceipts).values({ installationId, actorId: identity.actor.id, key: input.idempotencyKey, payloadHash, revision: current.row.revision, result: planned.result });
      await auditIdentity(tx, "plugin.invoke", identity.actor.id, identity.actor.id, installationId, { revision: current.row.revision, method: input.method, changedKeys: planned.changes.length });
      return { result: planned.result, replayed: false, revision: current.row.revision };
    });
  } finally { await execution.dispose(); }
}
