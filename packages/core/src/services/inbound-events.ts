import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { inboundSources, inboundEvents, inboundActionReceipts, tasks, authSessions, type Database } from "@task-weaver/db";
import { AuthorizationError, AuthenticationError, ConflictError, NotFoundError, ValidationError, credentialGrantsSchema,
  createInboundSourceSchema, updateInboundSourceSchema, inboundEventSchema, inboundRuleSchema, listInboundEventsSchema,
  requestIdentitySnapshotSchema, stableActorReferenceSchema, type VerifiedRequestContext, type AuthorizationGrant, type InboundAction, type InboundEvent, type InboundRule } from "@task-weaver/contracts";
import { lockIdentityLifecycle, auditIdentity } from "./auth-security";
import { getBoundCredentialAuthority } from "./api-keys";
import { intersectGrants } from "./auth-principals";
import { requireResource, requireScope, resourceAuthority, type ResourceAuthority } from "./resource-authorization";
import { createResourceServices } from "./resource-services";
import { withEventActor } from "./durable-events";

export class InboundRateLimitError extends Error {
  constructor() { super("Inbound source rate or backlog limit exceeded"); this.name = "InboundRateLimitError"; }
}
type Source = typeof inboundSources.$inferSelect;
const sources = inboundSources, events = inboundEvents;
const sourceDto = (row: Source) => ({ id: row.id, name: row.name, projectId: row.projectId, requirementId: row.requirementId,
  active: row.active, rules: row.rules, createdAt: row.createdAt, updatedAt: row.updatedAt, endpoint: `/api/v1/inbound/events/${row.id}` });
const eventDto = (row: typeof events.$inferSelect) => ({ id: row.id, sourceId: row.sourceId, externalId: row.externalId, eventType: row.eventType,
  status: row.status, attempts: row.attempts, errorCode: row.errorCode, nextAttemptAt: row.nextAttemptAt, receivedAt: row.receivedAt, processedAt: row.processedAt });
function rulesFor(row: Source): InboundRule[] { return inboundRuleSchema.array().min(1).max(20).parse(row.rules); }
function manage(authority: ResourceAuthority, projectId: string) {
  requireScope(authority, { projectId }, "resource.read"); requireScope(authority, { projectId }, "resource.write"); requireScope(authority, { projectId }, "webhook.manage");
}
async function liveSource(db: Database, row: Source) {
  if (!row.active || row.deletedAt) throw new AuthorizationError();
  const current = await getBoundCredentialAuthority(db, { actorId: row.ownerActorId, credentialId: row.credentialId, credentialKind: row.credentialKind });
  const authority = { ...current, grants: intersectGrants(current.grants, credentialGrantsSchema.parse(row.authorityCeiling)) };
  manage(authority, row.projectId);
  const requirement = await requireResource(db, authority, "requirement", row.requirementId, "resource.write");
  if (requirement.projectId !== row.projectId) throw new AuthorizationError();
  const session = row.credentialKind === "session" ? await db.query.authSessions.findFirst({ where: eq(authSessions.id, row.credentialId) }) : null;
  const credential = row.credentialKind === "session"
    ? { kind: "session", id: row.credentialId, actorId: row.ownerActorId, expiresAt: session!.expiresAt.toISOString() }
    : { kind: "api_key", id: row.credentialId, actorId: row.ownerActorId, expiresAt: null, grants: authority.grants };
  const context = requestIdentitySnapshotSchema.parse({ actor: current.actor, credential, verifiedAt: new Date().toISOString() }) as VerifiedRequestContext;
  return { authority, context };
}
function ceiling(projectId: string, rules: InboundRule[], authority: ResourceAuthority): AuthorizationGrant[] {
  const scheduled = rules.some(rule => rule.actions.some(action => action.type === "run_schedule"));
  const evidence = authority.actor.type === "agent" && rules.some(rule => rule.actions.some(action => action.type === "record_evidence"));
  const permissions = ["resource.read", "resource.write", "webhook.manage", ...(scheduled ? ["project.manage"] : []), ...(scheduled || evidence ? ["execution.run"] : [])] as AuthorizationGrant["permissions"];
  for (const permission of permissions) requireScope(authority, { projectId }, permission);
  const result: AuthorizationGrant[] = [{ scope: "project", projectId, permissions }];
  if (scheduled) {
    const ownerId = authority.actor.type === "human" ? authority.actor.id : authority.actor.managedByActorId;
    requireScope(authority, { personalOwnerId: ownerId, personalOwnerType: "human" }, "resource.read");
    result.push({ scope: "personal", actorId: ownerId, permissions: ["resource.read"] });
  }
  return result;
}

export function createInboundSourceService(identity: VerifiedRequestContext) {
  const operation = <T>(db: Database, work: (tx: Database, authority: ResourceAuthority) => Promise<T>) => db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const authority = await resourceAuthority(tx, identity);
    if (authority.bounds || identity.credential.kind === "delegation") throw new AuthorizationError();
    return work(tx as unknown as Database, authority);
  });
  async function get(db: Database, authority: ResourceAuthority, id: string) {
    if (!stableActorReferenceSchema.safeParse({ id, type: "human" }).success) throw new ValidationError("Invalid inbound source ID");
    const row = await db.query.inboundSources.findFirst({ where: eq(sources.id, id) });
    if (!row || row.deletedAt) throw new NotFoundError("Inbound source not found");
    manage(authority, row.projectId); return row;
  }
  return {
    async create(db: Database, raw: unknown) {
      const input = createInboundSourceSchema.parse(raw);
      return operation(db, async (tx, authority) => {
        manage(authority, input.projectId);
        const requirement = await requireResource(tx, authority, "requirement", input.requirementId, "resource.write");
        if (requirement.projectId !== input.projectId) throw new AuthorizationError();
        const secret = randomBytes(32).toString("hex");
        const [row] = await tx.insert(sources).values({ ...input, ownerActorId: authority.actor.id, credentialId: identity.credential.id,
          credentialKind: identity.credential.kind, secret, authorityCeiling: ceiling(input.projectId, input.rules, authority) }).returning();
        await auditIdentity(tx, "inbound.source_created", authority.actor.id, authority.actor.id, row!.id);
        return { ...sourceDto(row!), secret };
      });
    },
    async list(db: Database, projectId: string) {
      return operation(db, async (tx, authority) => {
        manage(authority, projectId); await requireResource(tx, authority, "project", projectId);
        return (await tx.select().from(sources).where(and(eq(sources.projectId, projectId), isNull(sources.deletedAt))).orderBy(desc(sources.createdAt))).map(sourceDto);
      });
    },
    async update(db: Database, id: string, raw: unknown) {
      const input = updateInboundSourceSchema.parse(raw);
      return operation(db, async (tx, authority) => {
        const row = await get(tx, authority, id);
        const rules = input.rules ?? rulesFor(row);
        const { rotateSecret, ...patch } = input;
        const [updated] = await tx.update(sources).set({ ...patch, bindingId: randomUUID(), ownerActorId: authority.actor.id,
          credentialId: identity.credential.id, credentialKind: identity.credential.kind, authorityCeiling: ceiling(row.projectId, rules, authority),
          ...(rotateSecret ? { secret: randomBytes(32).toString("hex") } : {}), updatedAt: new Date() }).where(eq(sources.id, id)).returning();
        await auditIdentity(tx, "inbound.source_updated", authority.actor.id, authority.actor.id, id);
        return { ...sourceDto(updated!), ...(rotateSecret ? { secret: updated!.secret } : {}) };
      });
    },
    async delete(db: Database, id: string) {
      return operation(db, async (tx, authority) => {
        await get(tx, authority, id);
        await tx.update(sources).set({ active: false, deletedAt: new Date(), updatedAt: new Date(), bindingId: randomUUID() }).where(eq(sources.id, id));
        await auditIdentity(tx, "inbound.source_deleted", authority.actor.id, authority.actor.id, id);
        return { deleted: true };
      });
    },
    async history(db: Database, id: string, raw: unknown = {}) {
      const input = listInboundEventsSchema.parse(raw);
      return operation(db, async (tx, authority) => {
        await get(tx, authority, id);
        return (await tx.select().from(events).where(eq(events.sourceId, id)).orderBy(desc(events.receivedAt)).limit(input.limit).offset(input.offset)).map(eventDto);
      });
    },
    async receipts(db: Database, id: string, eventId: string) {
      if (!stableActorReferenceSchema.safeParse({ id: eventId, type: "human" }).success) throw new ValidationError("Invalid inbound event ID");
      return operation(db, async (tx, authority) => {
        await get(tx, authority, id);
        const event = await tx.query.inboundEvents.findFirst({ where: and(eq(events.id, eventId), eq(events.sourceId, id)) });
        if (!event) throw new NotFoundError("Inbound event not found");
        return tx.select().from(inboundActionReceipts).where(eq(inboundActionReceipts.eventId, eventId)).orderBy(asc(inboundActionReceipts.createdAt));
      });
    },
    async retry(db: Database, id: string, eventId: string) {
      if (!stableActorReferenceSchema.safeParse({ id: eventId, type: "human" }).success) throw new ValidationError("Invalid inbound event ID");
      return operation(db, async (tx, authority) => {
        const source = await get(tx, authority, id); await liveSource(tx, source);
        const [event] = await tx.update(events).set({ status: "pending", nextAttemptAt: null, leaseId: null, leaseExpiresAt: null, errorCode: null })
          .where(and(eq(events.id, eventId), eq(events.sourceId, id), eq(events.bindingId, source.bindingId), eq(events.status, "failed"))).returning();
        if (!event) throw new NotFoundError("Retryable inbound event not found");
        return eventDto(event);
      });
    },
  };
}

/** Authentication precedes JSON interpretation or persistence. All accepted identities are durable before acknowledgment. */
export async function acceptInboundEvent(db: Database, sourceId: string, body: Uint8Array, headers: Headers) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId)) throw new AuthenticationError("invalid_credential");
  if (body.byteLength > 65_536) throw new ValidationError("Inbound event exceeds 65536 bytes");
  const signature = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(headers.get("x-taskweaver-signature-v1") ?? "");
  if (!signature || Math.abs(Date.now() / 1000 - Number(signature[1])) > 300) throw new AuthenticationError("invalid_credential");
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const [source] = await tx.select().from(sources).where(eq(sources.id, sourceId)).limit(1).for("update");
    if (!source) throw new AuthenticationError("invalid_credential");
    const expected = createHmac("sha256", source.secret).update(signature[1] + ".").update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature[2]!, "hex"))) throw new AuthenticationError("invalid_credential");
    await liveSource(tx as unknown as Database, source);
    let value: InboundEvent;
    try { value = inboundEventSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))); }
    catch { throw new ValidationError("Invalid inbound event envelope"); }
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const existing = await tx.query.inboundEvents.findFirst({ where: and(eq(events.sourceId, sourceId), eq(events.bindingId, source.bindingId), eq(events.externalId, value.eventId)) });
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new ConflictError("An inbound event ID cannot be reused with different content", 0);
      return { ...eventDto(existing), duplicate: true };
    }
    const [rate] = await tx.select({ total: count() }).from(events).where(and(eq(events.sourceId, sourceId), gt(events.receivedAt, new Date(Date.now() - 60_000))));
    const [backlog] = await tx.select({ total: count() }).from(events).where(and(eq(events.sourceId, sourceId), inArray(events.status, ["pending", "processing"])));
    if (rate!.total >= 100 || backlog!.total >= 1000) throw new InboundRateLimitError();
    const [stored] = await tx.insert(events).values({ sourceId, bindingId: source.bindingId, externalId: value.eventId, eventType: value.type,
      payloadHash, payload: value as unknown as Record<string, unknown>, status: "pending" }).returning();
    return { ...eventDto(stored!), duplicate: false };
  });
}

export function inboundPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (["__proto__", "prototype", "constructor"].includes(key) || !current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
export function inboundTemplate(template: string, event: InboundEvent, limit = 4000) {
  const output = template.replace(/\{\{([A-Za-z0-9_.]+)\}\}/g, (_match, path: string) => {
    const value = inboundPath(event, path);
    if (!["string", "number", "boolean"].includes(typeof value)) throw new ValidationError("Event template references an unavailable scalar");
    return String(value);
  });
  if (!output || output.length > limit) throw new ValidationError("Rendered inbound value exceeds its limit");
  return output;
}
async function performAction(db: Database, source: Source, event: InboundEvent, action: InboundAction, authority: ResourceAuthority, identity: VerifiedRequestContext) {
  const service = createResourceServices(identity), actor = { id: authority.actor.id, type: authority.actor.type };
  const taskTarget = async (target: { taskId: string } | { taskIdPath: string }) => {
    const id = "taskId" in target ? target.taskId : inboundPath(event, target.taskIdPath);
    if (typeof id !== "string") throw new ValidationError("An inbound task target is required");
    await requireResource(db, authority, "task", id, "resource.write");
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    if (!task || task.projectId !== source.projectId || task.requirementId !== source.requirementId) throw new AuthorizationError();
    return task;
  };
  if (action.type === "create_task") {
    requireScope(authority, { projectId: source.projectId }, "resource.write");
    return (await service.taskService.createTask(db, { projectId: source.projectId, requirementId: source.requirementId,
      title: inboundTemplate(action.title, event, 500), description: action.description ? inboundTemplate(action.description, event) : undefined, priority: action.priority }, actor)).id;
  }
  if (action.type === "run_schedule") {
    requireScope(authority, { projectId: source.projectId }, "project.manage"); requireScope(authority, { projectId: source.projectId }, "execution.run");
    const ownerId = authority.actor.type === "human" ? authority.actor.id : authority.actor.managedByActorId;
    requireScope(authority, { personalOwnerId: ownerId, personalOwnerType: "human" }, "resource.read");
    const schedule = await service.scheduleService.getSchedule(db, action.scheduleId);
    if (schedule.projectId !== source.projectId || schedule.requirementId !== source.requirementId || schedule.targetScope !== "project") throw new AuthorizationError();
    return (await service.scheduleService.runScheduleNow(db, action.scheduleId, actor)).id;
  }
  const task = await taskTarget(action.target);
  if (action.type === "update_task") {
    const { status, ...changes } = action.changes;
    if (changes.title) changes.title = inboundTemplate(changes.title, event, 500);
    if (changes.description) changes.description = inboundTemplate(changes.description, event);
    if (Object.keys(changes).length) await service.taskService.updateTask(db, task.id, changes, actor);
    if (status) await service.taskService.updateTaskStatus(db, task.id, status, actor, "Verified inbound event", false);
    return task.id;
  }
  const content = inboundTemplate(action.content, event);
  const comment = await service.taskService.addTaskComment(db, task.id, content, actor);
  if (action.type === "record_evidence") {
    if (actor.type === "agent") requireScope(authority, { projectId: source.projectId }, "execution.run");
    return (await service.requirementService.registerWorkflowOutput(db, source.requirementId, { type: "comment", taskId: task.id, referenceId: comment.id, summary: content }, actor)).id;
  }
  return comment.id;
}

/** All bounded actions and their receipts commit together; a restarted worker cannot duplicate committed business writes. */
export async function processInboundEventOnce(db: Database) {
  const now = new Date(), leaseId = randomUUID();
  const claimed = await db.transaction(async tx => {
    const [row] = await tx.select().from(events).where(and(
      or(eq(events.status, "pending"), and(eq(events.status, "processing"), lte(events.leaseExpiresAt, now)),
        and(eq(events.status, "failed"), gt(events.attempts, 0), lte(events.nextAttemptAt, now))),
      or(isNull(events.nextAttemptAt), lte(events.nextAttemptAt, now))))
      .orderBy(asc(events.receivedAt)).limit(1).for("update", { skipLocked: true });
    if (!row) return null;
    const [updated] = await tx.update(events).set({ status: "processing", leaseId, leaseExpiresAt: new Date(Date.now() + 60_000), attempts: row.attempts + 1 }).where(eq(events.id, row.id)).returning();
    return updated!;
  });
  if (!claimed) return false;
  const fence = and(eq(events.id, claimed.id), eq(events.leaseId, leaseId));
  try {
    await db.transaction(async tx => {
      await lockIdentityLifecycle(tx);
      const [row] = await tx.select().from(events).where(fence).limit(1).for("update");
      if (!row || !row.leaseExpiresAt || row.leaseExpiresAt <= new Date()) throw new AuthorizationError();
      const source = await tx.query.inboundSources.findFirst({ where: eq(sources.id, row.sourceId) });
      if (!source || source.bindingId !== row.bindingId) throw new AuthorizationError();
      const database = tx as unknown as Database;
      const { authority, context } = await liveSource(database, source);
      const event = inboundEventSchema.parse(row.payload);
      let actions = 0;
      await withEventActor({ id: authority.actor.id, type: authority.actor.type }, async () => {
        for (const rule of rulesFor(source)) {
          if (!rule.eventTypes.includes(event.type) || !rule.conditions.every(condition => {
            const value = inboundPath(event, condition.path);
            return condition.operator === "exists" ? value !== undefined : condition.operator === "equals" ? value === condition.value : value !== condition.value;
          })) continue;
          for (let index = 0; index < rule.actions.length; index++) {
            const entityId = await performAction(database, source, event, rule.actions[index]!, authority, context);
            await tx.insert(inboundActionReceipts).values({ eventId: row.id, ruleId: rule.id, actionIndex: index, actionType: rule.actions[index]!.type, entityId });
            actions++;
          }
        }
      }, { causationId: row.id, correlationId: row.id });
      await tx.update(events).set({ status: actions ? "processed" : "ignored", processedAt: new Date(), errorCode: null, nextAttemptAt: null, leaseId: null, leaseExpiresAt: null }).where(fence);
    });
  } catch (error) {
    const permanent = error instanceof AuthorizationError || error instanceof AuthenticationError || error instanceof NotFoundError || error instanceof ValidationError || (error instanceof Error && error.name === "ZodError");
    await db.update(events).set({ status: "failed", errorCode: permanent ? "ACTION_REJECTED" : "PROCESSING_FAILED",
      nextAttemptAt: !permanent && claimed.attempts < 5 ? new Date(Date.now() + 1000 * 2 ** claimed.attempts) : null, leaseId: null, leaseExpiresAt: null }).where(fence);
  }
  return true;
}
