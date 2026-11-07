import { asc, eq } from "drizzle-orm";
import { executionSlices, type Database } from "@task-weaver/db";
import { type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockIdentityLifecycle } from "../services/auth-security";
import { resourceAuthority, requireResource } from "../services/resource-authorization";

/** Historical slices remain readable; they cannot schedule new work. */
export async function mcpSlices(db: Database, identity: VerifiedRequestContext, raw: Record<string, unknown>) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const database = tx as unknown as Database, authority = await resourceAuthority(tx, identity);
    const id = raw.id as string;
    await requireResource(database, authority, "requirement", id, "resource.read");
    const page = raw.page as number, pageSize = raw.pageSize as number;
    const rows = await tx.select().from(executionSlices).where(eq(executionSlices.requirementId, id)).orderBy(asc(executionSlices.orderIndex), executionSlices.id).limit(pageSize + 1).offset((page - 1) * pageSize);
    return { items: rows.slice(0, pageSize), meta: { page, pageSize, nextPage: rows.length > pageSize ? page + 1 : null } };
  });
}
