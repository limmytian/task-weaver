import { createHash } from "node:crypto";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type Database, authMigrationReceipts, authActors, projects, projectMemberships,
  tasks, documents, memories, schedules, mcpServers, skillPackages, repositories,
  tiAgentModelConfigs, tiAgentPolicies, tiAgentRuns, daemons, taskClaims,
  requirementClaims, requirements, executionDelegations, repositoryCheckoutBindings,
  apiKeys, authAuditEvents, embeddingProfiles,
} from "@task-weaver/db";
import { explicitProjectPermissionSchema, projectRoleSchema, ValidationError } from "@task-weaver/contracts";
import { loadActivePrincipal } from "./auth-principals";
import { lockIdentityLifecycle } from "./auth-security";

const resources = { tasks, documents, memories, schedules, mcpServers, skillPackages, repositories, tiAgentModelConfigs, tiAgentPolicies, daemons, embeddingProfiles };
const resourceName = z.enum(["tasks", "documents", "memories", "schedules", "mcpServers", "skillPackages", "repositories", "tiAgentModelConfigs", "tiAgentPolicies", "daemons", "embeddingProfiles"]);
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reference = z.object({ resource: resourceName, id: z.string().uuid() }).strict();
export const ownershipMigrationManifestSchema = z.object({
  id: z.string().uuid(),
  legacyBefore: z.string().datetime(),
  ownership: z.array(reference.extend({ ownerFingerprint: z.string().regex(/^[a-f0-9]{64}$/), actorId: z.string().uuid() }).strict()).max(10000),
  memberships: z.array(z.object({ projectId: z.string().uuid(), actorId: z.string().uuid(), role: projectRoleSchema, explicitPermissions: z.array(explicitProjectPermissionSchema) }).strict()).max(10000),
}).strict();

type MigrationDb = Parameters<Parameters<Database["transaction"]>[0]>[0];
type InventoryRow = { resource: keyof typeof resources; id: string; projectId: string | null; ownerFingerprint: string; historicalActorFingerprint: string | null; disposition: "restricted" | "unowned" };

function ownerColumns(name: keyof typeof resources, table: any) {
  return name === "daemons" ? { id: table.actorId, type: table.actorType }
    : ["repositories", "tiAgentModelConfigs", "tiAgentPolicies"].includes(name) ? { id: table.ownerId, type: table.ownerType }
    : { id: table.personalOwnerId, type: table.personalOwnerType };
}

async function inventory(db: MigrationDb, legacyBefore: string) {
  const cutoff = z.string().datetime().parse(legacyBefore);
  const actors = await db.select({ id: authActors.id, type: authActors.type, status: authActors.status }).from(authActors);
  const rows: InventoryRow[] = [];
  for (const [name, table] of Object.entries(resources) as [keyof typeof resources, any][]) {
    const owner = ownerColumns(name, table);
    for (const row of await db.select({ id: table.id, ownerId: owner.id, ownerType: owner.type, ...(table.projectId ? { projectId: table.projectId } : {}), ...(table.createdBy ? { historicalActor: table.createdBy } : table.registeredBy ? { historicalActor: table.registeredBy } : {}) }).from(table).where(lte(table.createdAt, new Date(cutoff)))) {
      // Actor labels and private content never leave the offline inventory.

      rows.push({ resource: name, id: row.id, projectId: row.projectId ?? null, ownerFingerprint: digest([row.ownerId, row.ownerType]), historicalActorFingerprint: row.historicalActor ? digest(row.historicalActor) : null, disposition: row.ownerId ? "restricted" : "unowned" });
    }
  }
  rows.sort((a, b) => `${a.resource}:${a.id}`.localeCompare(`${b.resource}:${b.id}`));
  const projectRows = (await db.select({ id: projects.id, createdBy: projects.createdBy }).from(projects).where(lte(projects.createdAt, new Date(cutoff))).orderBy(projects.id)).map(row => ({ id: row.id, historicalActorFingerprint: digest(row.createdBy) }));
  const memberships = await db.select({ projectId: projectMemberships.projectId, actorId: projectMemberships.actorId, role: projectMemberships.role, permissions: projectMemberships.explicitPermissions, removedAt: projectMemberships.removedAt }).from(projectMemberships).orderBy(projectMemberships.projectId, projectMemberships.actorId);
  const leases = await db.select({ id: requirementClaims.id, requirementId: requirementClaims.requirementId, expiresAt: requirementClaims.expiresAt }).from(requirementClaims).orderBy(requirementClaims.id);
  const taskLeases = await db.select({ id: taskClaims.id, taskId: taskClaims.taskId, expiresAt: taskClaims.expiresAt }).from(taskClaims).orderBy(taskClaims.id);
  const keys = await db.select({ id: apiKeys.id, actorId: apiKeys.actorId, revokedAt: apiKeys.revokedAt }).from(apiKeys).orderBy(apiKeys.id);
  const runtime = {
    daemons: await db.select({ id: daemons.id, status: daemons.status, workers: daemons.activeWorkerStates, heartbeat: daemons.lastHeartbeatAt }).from(daemons).orderBy(daemons.id),
    runs: await db.select({ id: tiAgentRuns.id, status: tiAgentRuns.status, leaseExpiresAt: tiAgentRuns.leaseExpiresAt }).from(tiAgentRuns).orderBy(tiAgentRuns.id),
    delegations: await db.select({ id: executionDelegations.id, revokedAt: executionDelegations.revokedAt, expiresAt: executionDelegations.expiresAt }).from(executionDelegations).orderBy(executionDelegations.id),
    readiness: await db.select({ id: repositoryCheckoutBindings.id, verifiedAt: repositoryCheckoutBindings.lastVerifiedAt }).from(repositoryCheckoutBindings).orderBy(repositoryCheckoutBindings.id),
    requirements: await db.select({ id: requirements.id, generation: requirements.leaseGeneration }).from(requirements).orderBy(requirements.id),
  };
  return { fingerprint: digest({ legacyBefore, rows, projectRows, memberships, leases, taskLeases, keys, runtime, actors: actors.sort((a, b) => a.id.localeCompare(b.id)) }), rows, projects: projectRows, memberships, leases: leases.length, taskLeases: taskLeases.length, legacyKeys: keys.filter(key => !key.actorId && !key.revokedAt).length };
}

/** Offline database-owner operation only. Never expose this through a request adapter. */
export async function inspectOwnershipMigration(db: Database, legacyBefore: string) {
  return db.transaction(tx => inventory(tx, legacyBefore), { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Apply an explicit reviewed manifest during maintenance, with atomic fencing and a replay receipt. */
export async function applyOwnershipMigration(db: Database, input: unknown, expectedInventory: string, dryRun = false) {
  const manifest = ownershipMigrationManifestSchema.parse(input);
  const manifestHash = digest(manifest);
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    // Raw SQL is limited to PostgreSQL maintenance locking; all data operations use Drizzle.
    await tx.execute(sql`LOCK TABLE task_weaver.tasks, task_weaver.documents, task_weaver.memories, task_weaver.schedules, task_weaver.mcp_servers, task_weaver.skill_packages, task_weaver.embedding_profiles, task_weaver.repositories, task_weaver.ti_agent_model_configs, task_weaver.ti_agent_policies, task_weaver.daemons, task_weaver.requirements, task_weaver.requirement_claims, task_weaver.task_claims, task_weaver.ti_agent_runs, task_weaver.execution_delegations, task_weaver.api_keys, task_weaver.repository_checkout_bindings IN EXCLUSIVE MODE`);
    const [receipt] = await tx.select().from(authMigrationReceipts).where(eq(authMigrationReceipts.id, manifest.id));
    if (receipt) {
      if (receipt.manifestHash !== manifestHash) throw new ValidationError("Migration receipt does not match manifest");
      return { ...receipt.result, replayed: true };
    }
    const before = await inventory(tx, manifest.legacyBefore);
    if (before.fingerprint !== expectedInventory) throw new ValidationError("Migration inventory changed; review a fresh dry run");
    const mapped = new Map<string, string>();
    for (const item of manifest.ownership) {
      const key = `${item.resource}:${item.id}`;
      if (mapped.has(key)) throw new ValidationError("Duplicate ownership mapping");
      const row = before.rows.find(row => row.resource === item.resource && row.id === item.id);
      if (!row || row.ownerFingerprint !== item.ownerFingerprint || row.projectId) throw new ValidationError("Ownership mapping does not match a restricted resource");
      const actor = await loadActivePrincipal(tx, item.actorId);
      if (actor.type !== (item.resource === "daemons" ? "agent" : "human")) throw new ValidationError("Ownership target has an invalid principal type");
      mapped.set(key, item.actorId);
    }
    const memberKeys = new Set<string>();
    for (const member of manifest.memberships) {
      const key = `${member.projectId}:${member.actorId}`;
      if (memberKeys.has(key) || !before.projects.some(project => project.id === member.projectId) || before.memberships.some(existing => existing.projectId === member.projectId)) throw new ValidationError("Migration only initializes explicitly selected unowned projects");
      memberKeys.add(key);
      const actor = await loadActivePrincipal(tx, member.actorId);
      if (member.role === "owner" && actor.type !== "human") throw new ValidationError("Project ownership requires a human");
    }
    for (const projectId of new Set(manifest.memberships.map(member => member.projectId))) {
      if (!manifest.memberships.some(member => member.projectId === projectId && member.role === "owner")) throw new ValidationError("Migrated project requires an explicit human owner");
    }
    const result = { mapped: mapped.size, quarantined: before.rows.filter(row => !row.projectId && !mapped.has(`${row.resource}:${row.id}`)).length, memberships: manifest.memberships.length, revokedLegacyKeys: before.legacyKeys, releasedRequirementLeases: before.leases, releasedTaskLeases: before.taskLeases };
    if (dryRun) return { ...result, replayed: false, dryRun: true };
    for (const row of before.rows) {
      if (row.projectId) continue;
      // Restricted scope tombstones are deliberately not valid actor IDs.
      const actorId = mapped.get(`${row.resource}:${row.id}`);
      const table: any = resources[row.resource];
      const columns = ownerColumns(row.resource, table);
      const patch: Record<string, unknown> = { [columns.id.name === "actor_id" ? "actorId" : columns.id.name === "owner_id" ? "ownerId" : "personalOwnerId"]: actorId ?? `quarantine:${row.resource}:${row.id}`, [columns.type.name === "actor_type" ? "actorType" : columns.type.name === "owner_type" ? "ownerType" : "personalOwnerType"]: row.resource === "daemons" ? "agent" : "human" };
      if (row.resource === "repositories") patch.visibility = "private";
      if (row.resource === "embeddingProfiles") patch.scope = "personal";
      if (row.resource === "mcpServers" && actorId) patch.registeredBy = actorId;
      await tx.update(table).set(patch).where(eq(table.id, row.id));
      await tx.insert(authAuditEvents).values({ action: "auth.ownership_mapped", subjectActorId: actorId ?? null, entityId: row.id, metadata: { resource: row.resource, previousOwnerFingerprint: row.ownerFingerprint, quarantined: !actorId } });
    }
    for (const member of manifest.memberships) {
      const actor = await loadActivePrincipal(tx, member.actorId);
      await tx.insert(projectMemberships).values({ ...member, actorType: actor.type });
    }
    const now = new Date();
    await tx.update(apiKeys).set({ revokedAt: now }).where(and(isNull(apiKeys.actorId), isNull(apiKeys.revokedAt)));
    // Upgrade never resumes work under inherited authority. Re-register, acquire and authorize afresh.
    await tx.delete(taskClaims);
    await tx.delete(requirementClaims);
    await tx.update(requirements).set({ leaseGeneration: sql`${requirements.leaseGeneration} + 1` });
    await tx.update(executionDelegations).set({ revokedAt: now }).where(isNull(executionDelegations.revokedAt));
    await tx.update(daemons).set({ status: "offline", lastHeartbeatAt: new Date(0), controlState: "paused", activeTaskIds: [], activeWorkerStates: [], capabilities: [], controlReason: "Authenticated upgrade requires fresh registration" });
    await tx.update(tiAgentRuns).set({ status: "cancelled", leaseOwnerId: null, leaseOwnerType: null, leaseExpiresAt: null, nextAttemptAt: null, completedAt: now }).where(sql`${tiAgentRuns.status} IN ('queued', 'running')`);
    await tx.update(tiAgentPolicies).set({ enabled: false, executionMode: "disabled", assistantAutoEnabled: false, assistantAutoMode: "disabled" });
    await tx.update(tiAgentModelConfigs).set({ credentialStatus: "unknown", availabilityCheckedAt: null });
    await tx.update(repositoryCheckoutBindings).set({ lastVerifiedAt: null });
    await tx.update(schedules).set({ autoRun: false });
    await tx.update(embeddingProfiles).set({ status: "disabled", activeGenerationId: null, lastValidatedAt: null });
    await tx.update(mcpServers).set({ active: false, registeredCredentialId: null, status: "disconnected" });
    await tx.insert(authMigrationReceipts).values({ id: manifest.id, manifestHash, inventoryHash: before.fingerprint, result });
    await tx.insert(authAuditEvents).values({ action: "auth.ownership_migrated", entityId: manifest.id, metadata: { manifestHash, inventoryHash: before.fingerprint, ...result } });
    return { ...result, replayed: false };
  }, { isolationLevel: "serializable" });
}
