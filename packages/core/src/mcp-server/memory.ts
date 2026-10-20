import type { Database } from "@task-weaver/db";
import { NotFoundError, CAPABILITY_LIMITS, recordMemorySchema, updateMemorySchema, searchMemorySchema, type VerifiedRequestContext } from "@task-weaver/contracts";
import { createResourceServices } from "../services/resource-services";
import { personalResourceOwnerId } from "../services/resource-authorization";
import { McpToolFailure } from "./index";

function safeMemory(record: Record<string, any>, detail = true) {
  return {
    id: record.id, title: record.title.slice(0, 500), ...(detail ? { content: record.content } : { summary: record.content }),
    version: record.version, provenance: record.provenance, projectId: record.projectId,
    tags: record.tags?.slice(0, 20).map((tag: string) => tag.slice(0, 100)),
    entityType: record.entityType, entityId: record.entityId,
    createdBy: record.createdBy, createdByType: record.createdByType,
    expiresAt: record.expiresAt, updatedAt: record.updatedAt, createdAt: record.createdAt,
    ...(!detail ? { relevance: { method: "keyword", score: record.score } } : {}),
  };
}

export async function mcpMemory(db: Database, identity: VerifiedRequestContext, operation: "search" | "get" | "record" | "update" | "forget", raw: Record<string, unknown>) {
  const service = createResourceServices(identity).memoryService;
  const actor = { id: identity.actor.id, type: identity.actor.type };
  const owner = { personalOwnerId: personalResourceOwnerId(identity), personalOwnerType: "human" as const };
  const id = raw.id as string;
  if (operation === "search") {
    const limit = raw.limit as number;
    const rows = await service.searchMemories(db, searchMemorySchema.parse({ ...raw, view: "summary", limit: limit + 1, ...(raw.includePersonal ? owner : {}), preferredActorId: actor.id }));
    const result = { items: [] as ReturnType<typeof safeMemory>[], meta: { limit, hasMore: rows.length > limit, paginationSupported: false, continuation: "Narrow the query or use tw_memories_get for a selected ID.", expiresRenewed: false } };
    for (const row of rows.slice(0, limit)) {
      result.items.push(safeMemory(row, false));
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > CAPABILITY_LIMITS.summaryBytes) {
        result.items.pop(); result.meta.hasMore = true; break;
      }
    }
    return result;
  }
  if (operation === "forget") {
    await service.forgetMemory(db, id, actor, raw.expectedVersion as number);
    return { id, forgotten: true };
  }
  const record = operation === "record"
    ? await service.recordMemory(db, recordMemorySchema.parse({ ...raw, ...(raw.scope === "personal" ? owner : {}) }), actor)
    : operation === "update"
      ? await service.updateMemory(db, id, updateMemorySchema.parse(raw.patch), actor)
      : await service.getMemory(db, id);
  const expired = !!record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now();
  if (operation === "get" && expired && !raw.includeExpired) throw new NotFoundError("Resource not found");
  if (Buffer.byteLength(record.content, "utf8") > 32768) throw new McpToolFailure("result_too_large", "Memory content exceeds the 32768-byte read limit.");
  return { ...safeMemory(record), expired };
}
