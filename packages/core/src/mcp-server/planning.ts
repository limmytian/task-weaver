import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Database, mcpPlanReceipts } from "@task-weaver/db";
import { AuthorizationError, planSchema, type VerifiedRequestContext } from "@task-weaver/contracts";
import { createResourceServices } from "../services/resource-services";
import { lockIdentityLifecycle } from "../services/auth-security";
import { requireResource, resourceAuthority } from "../services/resource-authorization";
import { preflightPlan } from "../services/plan-preflight";
import { McpToolFailure } from "./index";

/** Canonical hashes ignore object key order but preserve array order and values. */
export function canonicalPlanJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalPlanJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalPlanJson(item)}`).join(",")}}`;
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
    await preflightPlan(database, authority, plan);
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
