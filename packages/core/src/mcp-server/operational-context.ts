import { and, asc, eq, ilike, isNull, not, or, sql } from "drizzle-orm";
import { repositories, schedules, type Database } from "@task-weaver/db";
import { ValidationError, agentUsageQuerySchema, repositoryReadinessInputSchema, type VerifiedRequestContext } from "@task-weaver/contracts";
import { createResourceServices } from "../services/resource-services";
import { repositoryPredicate } from "../services/repository-authorization";
import { schedulePredicate } from "../services/metadata-authorization";
import { resourceAuthority, requireResource, personalResourceOwnerId } from "../services/resource-authorization";

function boundedPage<T>(rows: T[], offset: number, limit: number) {
  const result = { items: rows.slice(0, limit), meta: { offset, limit, nextOffset: null as number | null, hasMore: rows.length > limit, maxBytes: 16384 } };
  while (Buffer.byteLength(JSON.stringify(result)) > 16384 - 128 && result.items.length) { result.items.pop(); result.meta.hasMore = true; }
  if (result.meta.hasMore) result.meta.nextOffset = offset + result.items.length;
  return result;
}

/** Compact operational reads exclude prompts, auth policy and checkout material. */
export async function readOperationalContext(db: Database, identity: VerifiedRequestContext, kind: "repositories" | "readiness" | "schedules" | "usage", raw: Record<string, unknown>) {
  const services = createResourceServices(identity);
  if (kind === "usage") {
    const until = raw.until as string | undefined ?? new Date().toISOString();
    const since = raw.since as string | undefined ?? new Date(Date.parse(until) - 30 * 86400000).toISOString();
    if (Date.parse(until) - Date.parse(since) > 90 * 86400000) throw new ValidationError("Usage summary windows cannot exceed 90 days");
    const input = agentUsageQuerySchema.parse({ ...raw, since, until, scope: "project" });
    return { ...await services.agentUsageService.summarizeUsage(db, input), window: { since, until }, maxWindowDays: 90 };
  }
  if (kind === "readiness") return services.repositoryService.getRepositoryReadiness(db, raw.id as string, identity.actor, repositoryReadinessInputSchema.parse({ operation: raw.operation, transport: raw.transport, nodeId: raw.nodeId }));
  const authority = await resourceAuthority(db, identity);
  const offset = raw.offset as number, limit = raw.limit as number;
  const owner = personalResourceOwnerId(identity);
  if (kind === "repositories") {
    const scope = raw.scope === "global" ? and(eq(repositories.visibility, "instance"), isNull(repositories.ownerId)) : and(eq(repositories.ownerId, owner), eq(repositories.ownerType, "human"));
    const query = raw.query as string | undefined;
    const rows = await db.select({ id: repositories.id, displayName: sql<string>`left(${repositories.displayName}, 128)`, provider: sql<string>`left(${repositories.provider}, 100)`, canonicalKey: sql<string>`left(${repositories.canonicalKey}, 512)`, defaultBranch: sql<string | null>`left(${repositories.defaultBranch}, 128)`, status: repositories.status, visibility: repositories.visibility, updatedAt: repositories.updatedAt }).from(repositories).where(and(repositoryPredicate(authority), scope, query ? or(ilike(repositories.displayName, `%${query}%`), ilike(repositories.canonicalKey, `%${query}%`)) : undefined)).orderBy(asc(repositories.canonicalKey), repositories.id).limit(limit + 1).offset(offset);
    return boundedPage(rows, offset, limit);
  }
  if (raw.projectId) await requireResource(db, authority, "project", raw.projectId as string);
  const scope = raw.scope === "personal" ? and(eq(schedules.targetScope, "personal"), eq(schedules.personalOwnerId, owner), eq(schedules.personalOwnerType, "human")) : and(eq(schedules.targetScope, "project"), eq(schedules.projectId, raw.projectId as string));
  const rows = await db.select({ id: schedules.id, title: sql<string>`left(${schedules.title}, 128)`, projectId: schedules.projectId, requirementId: schedules.requirementId, status: schedules.status, kind: schedules.kind, timezone: schedules.timezone, nextRunAt: schedules.nextRunAt, autoRun: schedules.autoRun, updatedAt: schedules.updatedAt }).from(schedules).where(and(schedulePredicate(authority), scope, not(eq(schedules.status, "archived")))).orderBy(asc(schedules.nextRunAt), schedules.id).limit(limit + 1).offset(offset);
  return boundedPage(rows, offset, limit);
}
