import { asc, eq } from "drizzle-orm";
import { executionSlices, type Database } from "@task-weaver/db";
import { ConflictError, NotFoundError, createExecutionSliceSchema, updateExecutionSliceSchema, type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockIdentityLifecycle } from "../services/auth-security";
import { resourceAuthority, requireResource } from "../services/resource-authorization";
import { assertRequirementLease } from "../services/claims";
import { createResourceServices } from "../services/resource-services";

export async function mcpSlices(db: Database, identity: VerifiedRequestContext, operation: "list" | "create" | "update", raw: Record<string, unknown>) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const database = tx as unknown as Database, authority = await resourceAuthority(tx, identity);
    const id = raw.id as string;
    await requireResource(database, authority, operation === "update" ? "slice" : "requirement", id, operation === "list" ? "resource.read" : "resource.write");
    if (operation === "list") {
      const page = raw.page as number, pageSize = raw.pageSize as number;
      const rows = await tx.select().from(executionSlices).where(eq(executionSlices.requirementId, id)).orderBy(asc(executionSlices.orderIndex), executionSlices.id).limit(pageSize + 1).offset((page - 1) * pageSize);
      return { items: rows.slice(0, pageSize), meta: { page, pageSize, nextPage: rows.length > pageSize ? page + 1 : null } };
    }
    const actor = { id: identity.actor.id, type: identity.actor.type }, services = createResourceServices(identity);
    let requirementId = id;
    if (operation === "update") {
      const [current] = await tx.select().from(executionSlices).where(eq(executionSlices.id, id)).for("update");
      if (!current) throw new NotFoundError("Resource not found");
      if (current.updatedAt.toISOString() !== raw.expectedUpdatedAt) throw new ConflictError("Slice changed; read current updatedAt", 0);
      requirementId = current.requirementId;
    }
    await assertRequirementLease(database, requirementId, actor);
    const result = operation === "create"
      ? await services.requirementService.createExecutionSlice(database, id, createExecutionSliceSchema.parse(raw.input), actor, true)
      : await services.requirementService.updateExecutionSlice(database, id, updateExecutionSliceSchema.parse(raw.patch), actor, true);
    // Service results contain nested tasks; return only the slice record.
    const [record] = await tx.select().from(executionSlices).where(eq(executionSlices.id, result.id));
    return record;
  });
}
