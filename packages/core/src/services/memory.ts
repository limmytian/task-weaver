import type { SQL } from "drizzle-orm";
import { and, eq, isNull, or, sql, desc } from "drizzle-orm";
import { type Database, memories, memoryReceipts } from "@task-weaver/db";
import { createHash } from "node:crypto";
import type { Actor } from "@task-weaver/contracts";
import type {
  RecordMemoryInput,
  UpdateMemoryInput,
  SearchMemoryInput,
  ListMemoriesInput,
} from "@task-weaver/contracts";
import { NotFoundError, ConflictError } from "@task-weaver/contracts";

// -- Helpers --

function buildMemoryScopeCondition(input: {
  projectId?: string;
  includeGlobal?: boolean;
  includePersonal?: boolean;
  personalOwnerId?: string;
  personalOwnerType?: "human" | "agent";
}) {
  const scopes = [];

  if (input.projectId) {
    scopes.push(eq(memories.projectId, input.projectId));
    if (input.includeGlobal) {
      scopes.push(and(isNull(memories.projectId), isNull(memories.personalOwnerId))!);
    }
  } else if (input.includeGlobal !== false) {
    scopes.push(and(isNull(memories.projectId), isNull(memories.personalOwnerId))!);
  }

  if (input.includePersonal && input.personalOwnerId && input.personalOwnerType) {
    scopes.push(
      and(
        isNull(memories.projectId),
        eq(memories.personalOwnerId, input.personalOwnerId),
        eq(memories.personalOwnerType, input.personalOwnerType),
      )!,
    );
  }

  return or(...scopes) ?? sql`false`;
}

function notExpired() {
  return or(isNull(memories.expiresAt), sql`${memories.expiresAt} > now()`);
}

function buildSearchTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[%_\\]/g, "\\$&"));
}

export const MAX_INCREMENT = Number(process.env.TW_MEM_MAX_INCREMENT_DAYS || 30) * 24 * 60 * 60 * 1000;
export const MAX_LIFESPAN = Number(process.env.TW_MEM_MAX_LIFESPAN_DAYS || 180) * 24 * 60 * 60 * 1000;

export function calculateSlidingRenewal(
  expiresAt: Date,
  now: number,
  maxIncrement: number = MAX_INCREMENT,
  maxLifespan: number = MAX_LIFESPAN,
): Date {
  const expiresTime = expiresAt.getTime();
  if (expiresTime <= now) return expiresAt;

  const R = expiresTime - now;
  if (R >= maxLifespan) return expiresAt;

  const delta = maxIncrement * Math.pow(1 - R / maxLifespan, 2);
  const newExpiresTime = Math.min(expiresTime + delta, now + maxLifespan);

  return newExpiresTime > expiresTime ? new Date(newExpiresTime) : expiresAt;
}

// -- CRUD --

export async function recordMemory(
  db: Database,
  input: RecordMemoryInput,
  actor: Actor,
) {
  const { idempotencyKey, ...payload } = input;
  const scopeKey = input.projectId ? `project:${input.projectId}` : input.personalOwnerId ? `personal:${input.personalOwnerType}:${input.personalOwnerId}` : "global";
  // Normalize key order recursively so equivalent retries share the same receipt.
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  const payloadHash = createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
  const receiptWhere = and(eq(memoryReceipts.actorId, actor.id), eq(memoryReceipts.actorType, actor.type), eq(memoryReceipts.scopeKey, scopeKey), idempotencyKey ? eq(memoryReceipts.key, idempotencyKey) : undefined);
  if (idempotencyKey) {
    const [receipt] = await db.insert(memoryReceipts).values({ actorId: actor.id, actorType: actor.type, scopeKey, key: idempotencyKey, payloadHash }).onConflictDoNothing().returning();
    if (!receipt) {
      const existing = await db.query.memoryReceipts.findFirst({ where: receiptWhere });
      if (!existing || existing.payloadHash !== payloadHash) throw new ConflictError("Memory save key was already used for different content", 0);
      if (!existing.memoryId) throw new ConflictError("The saved memory was forgotten; use a new key for an intentional new save", 0);
      return getMemory(db, existing.memoryId);
    }
  }
  const [memory] = await db
    .insert(memories)
    .values({
      title: input.title,
      content: input.content,
      provenance: input.provenance ?? { origin: "explicit" },
      memoryType: input.memoryType ?? "other",
      projectId: input.projectId ?? null,
      personalOwnerId: input.personalOwnerId ?? null,
      personalOwnerType: input.personalOwnerType ?? null,
      tags: input.tags,
      metadata: input.metadata ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdBy: actor.id,
      createdByType: actor.type,
    })
    .returning();
  if (idempotencyKey) await db.update(memoryReceipts).set({ memoryId: memory!.id }).where(receiptWhere);
  return memory!;
}

export async function getMemory(db: Database, id: string) {
  const memory = await db.query.memories.findFirst({
    where: eq(memories.id, id),
  });
  if (!memory) throw new NotFoundError("Memory not found");
  return memory;
}

export async function updateMemory(
  db: Database,
  id: string,
  input: UpdateMemoryInput,
  _actor: Actor,
) {
  const current = await getMemory(db, id);
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) throw new ConflictError("Memory changed", current.version);

  const { expectedVersion: _version, ...patch } = input;
  const updates: Record<string, unknown> = { ...patch, updatedAt: new Date(), version: sql`${memories.version} + 1` };
  if (input.expiresAt === null) {
    updates.expiresAt = null;
  } else if (input.expiresAt) {
    updates.expiresAt = new Date(input.expiresAt);
  }

  const [updated] = await db
    .update(memories)
    .set(updates)
    .where(and(eq(memories.id, id), eq(memories.version, current.version)))
    .returning();

  if (!updated) throw new ConflictError("Memory changed", (await getMemory(db, id)).version);
  return updated;
}

export async function forgetMemory(db: Database, id: string, _actor: Actor, expectedVersion?: number) {
  const current = await getMemory(db, id);
  if (expectedVersion !== undefined && expectedVersion !== current.version) throw new ConflictError("Memory changed", current.version);
  const result = await db
    .delete(memories)
    .where(and(eq(memories.id, id), eq(memories.version, current.version)))
    .returning({ id: memories.id });

  if (result.length === 0) throw new ConflictError("Memory changed", (await getMemory(db, id)).version);
}

// -- Search --

export async function searchMemories(db: Database, input: SearchMemoryInput, authorizedPredicate?: SQL) {
  const terms = buildSearchTerms(input.query);
  const likePattern = `%${input.query.replace(/[%_\\]/g, "\\$&")}%`;
  const conditions = [];
  const projectBoost = input.projectId
    ? sql<number>`CASE WHEN ${memories.projectId} = ${input.projectId} THEN 0.15 WHEN ${memories.projectId} IS NULL THEN 0.05 ELSE 0 END`
    : sql<number>`0`;
  const personalBoost = input.includePersonal && input.personalOwnerId
    ? sql<number>`CASE WHEN ${memories.personalOwnerId} = ${input.personalOwnerId} THEN 0.2 ELSE 0 END`
    : sql<number>`0`;
  const actorBoost = input.preferredActorId
    ? sql<number>`CASE WHEN ${memories.createdBy} = ${input.preferredActorId} THEN 0.1 ELSE 0 END`
    : sql<number>`0`;

  if (terms.length > 0) {
    conditions.push(
      and(
        ...terms.map((term) =>
          or(
            sql`${memories.title} ILIKE ${`%${term}%`} ESCAPE '\\'`,
            sql`${memories.content} ILIKE ${`%${term}%`} ESCAPE '\\'`,
          )!,
        ),
      ),
    );
  }

  // Filters
  conditions.push(buildMemoryScopeCondition(input));

  if (input.memoryType) conditions.push(eq(memories.memoryType, input.memoryType));
  if (input.entityType) conditions.push(eq(memories.entityType, input.entityType));
  if (input.entityId) conditions.push(eq(memories.entityId, input.entityId));
  if (input.createdBy) conditions.push(eq(memories.createdBy, input.createdBy));
  if (input.tags && input.tags.length > 0) conditions.push(sql`${memories.tags} && ${input.tags}`);
  if (!input.includeExpired) conditions.push(notExpired()!);

  const results = await db
    .select({
      id: memories.id,
      title: memories.title,
      content: input.view === "summary" ? sql<string>`left(${memories.content}, 512)` : memories.content,
      version: memories.version,
      provenance: memories.provenance,
      updatedAt: memories.updatedAt,
      memoryType: memories.memoryType,
      projectId: memories.projectId,
      personalOwnerId: memories.personalOwnerId,
      personalOwnerType: memories.personalOwnerType,
      tags: memories.tags,
      entityType: memories.entityType,
      entityId: memories.entityId,
      createdBy: memories.createdBy,
      createdByType: memories.createdByType,
      expiresAt: memories.expiresAt,
      createdAt: memories.createdAt,
      score: sql<number>`(
        CASE WHEN ${memories.title} ILIKE ${likePattern} ESCAPE '\\' OR ${memories.content} ILIKE ${likePattern} ESCAPE '\\' THEN 0.5 ELSE 0.0 END
        + ${projectBoost}
        + ${personalBoost}
        + ${actorBoost}
      )`.as("score"),
    })
    .from(memories)
    .where(and(...conditions, authorizedPredicate))
    .orderBy(sql`score DESC`, desc(memories.createdAt))
    .limit(input.limit);

  // Discovery does not mutate memory expiry; renewal belongs to an authorized write path.
  return results;
}

// -- List --

export async function listMemories(db: Database, input: ListMemoriesInput,
  authorizedPredicate?: SQL,
) {
  const conditions = [authorizedPredicate];

  conditions.push(buildMemoryScopeCondition(input));

  if (input.memoryType) conditions.push(eq(memories.memoryType, input.memoryType));
  if (input.entityType) conditions.push(eq(memories.entityType, input.entityType));
  if (input.entityId) conditions.push(eq(memories.entityId, input.entityId));
  if (input.createdBy) conditions.push(eq(memories.createdBy, input.createdBy));
  if (input.tags && input.tags.length > 0) conditions.push(sql`${memories.tags} && ${input.tags}`);
  if (!input.includeExpired) conditions.push(notExpired()!);

  return db.query.memories.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: (m, { desc }) => [desc(m.createdAt)],
    limit: input.limit,
    offset: input.offset,
  });
}

// -- Entity-scoped shortcut --

export async function getMemoriesForEntity(
  db: Database,
  entityType: string,
  entityId: string,
  authorizedPredicate?: SQL,
) {
  return db.query.memories.findMany({
    where: and(
      authorizedPredicate,
      eq(memories.entityType, entityType as "project" | "requirement" | "task" | "document"),
      eq(memories.entityId, entityId),
      notExpired()!,
    ),
    orderBy: (m, { desc }) => [desc(m.createdAt)],
  });
}
