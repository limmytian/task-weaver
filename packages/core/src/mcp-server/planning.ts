import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Database, mcpPlanReceipts, tasks } from "@task-weaver/db";
import { AuthorizationError, ValidationError, planSchema, type PlanInput, type VerifiedRequestContext } from "@task-weaver/contracts";
import { createResourceServices } from "../services/resource-services";
import { lockIdentityLifecycle } from "../services/auth-security";
import { requireResource, resourceAuthority, type ResourceAuthority } from "../services/resource-authorization";
import { assertRequirementLease } from "../services/claims";
import { McpToolFailure } from "./index";

/** Canonical hashes ignore object key order but preserve array order and values. */
export function canonicalPlanJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalPlanJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalPlanJson(item)}`).join(",")}}`;
}

async function preflight(db: Database, authority: ResourceAuthority, plan: PlanInput) {
  const actor = { id: authority.actor.id, type: authority.actor.type };
  await requireResource(db, authority, "project", plan.projectId, "resource.write");
  const keys = {
    requirement: new Map(plan.requirements.map(item => [item.key, item.existingId])),
    task: new Map(plan.requirements.flatMap(item => item.tasks.map(task => [task.key, task.existingId] as const))),
    document: new Map(plan.documents.map(item => [item.key, item.existingId])),
  };
  const checked = new Set<string>();
  async function ref(kind: keyof typeof keys, key: string) {
    const id = keys[kind].has(key) ? keys[kind].get(key) : key;
    if (!id || checked.has(`${kind}:${id}`)) return;
    checked.add(`${kind}:${id}`);
    const scope = await requireResource(db, authority, kind, id, "resource.write");
    if (scope.projectId !== plan.projectId) throw new ValidationError("MCP plans must remain inside their project");
    if (kind === "requirement") await assertRequirementLease(db, id, actor);
    if (kind === "task") {
      const [task] = await db.select({ requirementId: tasks.requirementId }).from(tasks).where(eq(tasks.id, id));
      if (task?.requirementId) await assertRequirementLease(db, task.requirementId, actor);
    }
  }
  const docRef = async (value: string | { document: string }) => ref("document", typeof value === "string" ? value : value.document);
  for (const doc of plan.documents) {
    if (doc.existingId) await ref("document", doc.key);
    for (const link of doc.links) await ref("document", link.document);
  }
  for (const requirement of plan.requirements) {
    if (requirement.existingId) await ref("requirement", requirement.key);
    for (const dep of [...requirement.dependsOn, ...requirement.dependencies]) await ref("requirement", typeof dep === "string" ? dep : dep.requirement);
    for (const doc of requirement.documents) await docRef(doc);
    for (const slice of requirement.slices) for (const task of slice.tasks) await ref("task", task);
    for (const task of requirement.tasks) {
      if (task.existingId) await ref("task", task.key);
      for (const dep of [...task.dependsOn, ...task.dependencies]) await ref("task", typeof dep === "string" ? dep : dep.task);
      for (const doc of task.documents) await docRef(doc);
    }
  }
  for (const link of plan.requirementDependencies) { await ref("requirement", link.requirement); await ref("requirement", link.dependsOn); }
  for (const link of plan.taskDependencies) { await ref("task", link.task); await ref("task", link.dependsOn); }
  for (const link of plan.documentLinks) { await ref("document", link.source); await ref("document", link.target); }
  for (const link of plan.documentTaskLinks) { await ref("document", link.document); await ref("task", link.task); }
  for (const link of plan.documentRequirementLinks) { await ref("document", link.document); await ref("requirement", link.requirement); }
}

export async function submitMcpPlan(db: Database, identity: VerifiedRequestContext, raw: { plan: unknown; idempotencyKey?: string }, signal: AbortSignal) {
  if (identity.credential.kind !== "api_key") throw new AuthorizationError();
  const plan = planSchema.parse(raw.plan);
  const hash = createHash("sha256").update(canonicalPlanJson(plan)).digest("hex");
  return db.transaction(async tx => {
    // Same lifecycle lock as business services serializes identical submissions and
    // policy changes. Receipt and all nested service writes commit together.
    await lockIdentityLifecycle(tx);
    const database = tx as unknown as Database, authority = await resourceAuthority(tx, identity);
    await preflight(database, authority, plan);
    signal.throwIfAborted();
    const where = and(eq(mcpPlanReceipts.credentialId, identity.credential.id), eq(mcpPlanReceipts.projectId, plan.projectId), raw.idempotencyKey ? eq(mcpPlanReceipts.idempotencyKey, raw.idempotencyKey) : undefined);
    if (raw.idempotencyKey) {
      const [receipt] = await tx.select().from(mcpPlanReceipts).where(where);
      if (receipt) {
        if (receipt.planHash !== hash) throw new McpToolFailure("conflict", "Idempotency key already identifies a different plan.");
        const result = receipt.result as { refs: Record<string, Array<{ id: string }>> };
        for (const [kind, rows] of Object.entries(result.refs)) {
          if (kind === "slices") continue;
          for (const row of rows) await requireResource(database, authority, kind === "requirements" ? "requirement" : kind === "tasks" ? "task" : "document", row.id);
        }
        return { ...receipt.result, replayed: true };
      }
    }
    const result = await createResourceServices(identity).planService.applyPlan(database, { plan, dryRun: !raw.idempotencyKey }, { id: identity.actor.id, type: identity.actor.type });
    const safeResult = { dryRun: result.dryRun, summary: result.summary, refs: result.refs, warnings: result.warnings };
    if (Buffer.byteLength(JSON.stringify(safeResult), "utf8") > 65536) throw new McpToolFailure("result_too_large", "Plan receipt exceeds the limit; transaction was rolled back.");
    signal.throwIfAborted();
    if (raw.idempotencyKey) await tx.insert(mcpPlanReceipts).values({ credentialId: identity.credential.id, projectId: plan.projectId, idempotencyKey: raw.idempotencyKey, planHash: hash, result: JSON.parse(JSON.stringify(safeResult)) });
    return { ...safeResult, replayed: false };
  });
}
