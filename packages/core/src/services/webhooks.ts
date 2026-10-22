import { eq, and, or, desc, inArray, isNull, isNotNull, lte, asc, type SQL } from "drizzle-orm";
import { type Database, webhooks, webhookDeliveries, webhookEvents, webhookDeliveryAttempts } from "@task-weaver/db";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { AuthenticationError, AuthorizationError, NotFoundError, ValidationError, stableActorReferenceSchema, credentialGrantsSchema, type AuthorizationGrant, type VerifiedRequestContext, type CreateWebhookInput, type RealtimeEvent, type UpdateWebhookInput } from "@task-weaver/contracts";
import { lockIdentityLifecycle, auditIdentity } from "./auth-security";
import { getBoundCredentialAuthority } from "./api-keys";
import { intersectGrants } from "./auth-principals";
import { canAccessResource, requireResource, requireScope, resourceAuthority, type ResourceAuthority } from "./resource-authorization";
import { authorizedRealtimeEvent } from "./realtime-authorization";

type Webhook = typeof webhooks.$inferSelect;
type Delivery = typeof webhookDeliveries.$inferSelect;
const eventMap: Partial<Record<RealtimeEvent["type"], string>> = {
  task_created: "task.created", task_updated: "task.updated", task_status_changed: "task.status_changed", task_commented: "task.commented", task_deleted: "task.deleted",
  requirement_created: "requirement.created", requirement_updated: "requirement.updated", requirement_deleted: "requirement.deleted",
  document_created: "document.created", document_updated: "document.updated", document_deleted: "document.deleted", document_linked: "document.linked", document_unlinked: "document.linked", document_task_linked: "document.linked", document_task_unlinked: "document.linked",
};

function dto(row: Webhook) {
  return { id: row.id, projectId: row.projectId, ownerActorId: row.ownerActorId, url: row.url, events: row.events, active: row.active, description: row.description, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
function deliveryDto(row: Delivery) {
  return { id: row.id, webhookId: row.webhookId, eventType: row.eventType, status: row.status, httpStatus: row.httpStatus, retryCount: row.retryCount, eventId: row.eventId, replayOf: row.replayOf, nextRetryAt: row.nextRetryAt, deliveredAt: row.deliveredAt, errorCode: row.errorMessage, createdAt: row.createdAt };
}
function manage(authority: ResourceAuthority, row: { projectId?: string | null }) {
  requireScope(authority, row, "resource.read");
  requireScope(authority, row, "webhook.manage");
  if (!row.projectId && (authority.actor.type !== "human" || authority.actor.instanceRole !== "admin")) throw new AuthorizationError();
}
function ceiling(row: { projectId?: string | null }): AuthorizationGrant[] {
  return row.projectId
    ? [{ scope: "project", projectId: row.projectId, permissions: ["resource.read", "webhook.manage"] }]
    : [{ scope: "global", permissions: ["resource.read", "webhook.manage"] }];
}
function binding(context: VerifiedRequestContext, row: { projectId?: string | null }) {
  return { bindingId: randomUUID(), ownerActorId: context.actor.id, credentialKind: context.credential.kind, credentialId: context.credential.id, authorityCeiling: ceiling(row) };
}
function validateUrl(url: string) {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new ValidationError("Webhook URL must use HTTP or HTTPS without embedded credentials");
}
async function liveBinding(db: Database, row: Webhook) {
  if (!row.ownerActorId || !row.credentialId || !row.credentialKind || !row.bindingId) throw new AuthorizationError();
  const authority = await getBoundCredentialAuthority(db, { actorId: row.ownerActorId, credentialId: row.credentialId, credentialKind: row.credentialKind });
  const parsed = credentialGrantsSchema.safeParse(row.authorityCeiling);
  if (!parsed.success) throw new AuthorizationError();
  authority.grants = intersectGrants(authority.grants, parsed.data);
  manage(authority, row);
  return authority;
}
async function payloadFor(db: Database, row: Webhook, event: RealtimeEvent) {
  if (!row.active || !eventMap[event.type] || !row.events.includes(eventMap[event.type]!)) return null;
  const authority = await liveBinding(db, row);
  // The stored ceiling contains only the configured project or global scope, never private spaces.
  const data = await authorizedRealtimeEvent(db, authority, event);
  if (!data || (data.projectId ?? null) !== row.projectId) return null;
  return { event: eventMap[event.type]!, timestamp: event.serverTime ?? new Date().toISOString(), data };
}

/** All management requires a verified context; no legacy namespace can authorize requests. */
export function createWebhookService(context: VerifiedRequestContext) {
  async function operation<T>(db: Database, work: (tx: Database, authority: ResourceAuthority) => Promise<T>) {
    return db.transaction(async tx => {
      await lockIdentityLifecycle(tx);
      return work(tx as unknown as Database, await resourceAuthority(tx, context));
    });
  }
  async function get(tx: Database, authority: ResourceAuthority, id: string) {
    if (!stableActorReferenceSchema.safeParse({ id, type: "human" }).success) throw new ValidationError("Invalid webhook ID");
    const row = await tx.query.webhooks.findFirst({ where: eq(webhooks.id, id) });
    if (!row || !canAccessResource(authority, row) || !canAccessResource(authority, row, "webhook.manage") || (!row.projectId && (authority.actor.type !== "human" || authority.actor.instanceRole !== "admin"))) throw new NotFoundError("Webhook not found");
    return row;
  }
  return {
    async createWebhook(db: Database, input: CreateWebhookInput, _actor?: unknown) {
      return operation(db, async (tx, authority) => {
        manage(authority, input);
        if (input.projectId) await requireResource(tx, authority, "project", input.projectId, "webhook.manage");
        validateUrl(input.url);
        const secret = input.secret ?? randomBytes(32).toString("hex");
        const [row] = await tx.insert(webhooks).values({ ...input, projectId: input.projectId ?? null, secret, ...binding(context, input) }).returning();
        await auditIdentity(tx, "webhook.created", authority.actor.id, authority.actor.id, row!.id);
        return { ...dto(row!), secret };
      });
    },
    async getWebhook(db: Database, id: string) {
      return operation(db, async (tx, authority) => dto(await get(tx, authority, id)));
    },
    async listWebhooks(db: Database, filters?: { projectId?: string; active?: boolean }) {
      return operation(db, async (tx, authority) => {
        if (filters?.projectId) await requireResource(tx, authority, "project", filters.projectId, "webhook.manage");
        const projects = authority.grants.flatMap(g => g.scope === "project" && g.permissions.includes("webhook.manage") && g.permissions.includes("resource.read") ? [g.projectId] : []);
        const scopes: SQL[] = [];
        if (projects.length) scopes.push(inArray(webhooks.projectId, projects));
        if (authority.actor.type === "human" && authority.actor.instanceRole === "admin" && canAccessResource(authority, {}, "webhook.manage") && canAccessResource(authority, {})) scopes.push(isNull(webhooks.projectId));
        if (!scopes.length) return [];
        const rows = await tx.select().from(webhooks).where(and(or(...scopes), filters?.projectId ? eq(webhooks.projectId, filters.projectId) : undefined, filters?.active === undefined ? undefined : eq(webhooks.active, filters.active))).orderBy(desc(webhooks.createdAt));
        return rows.map(dto);
      });
    },
    async updateWebhook(db: Database, id: string, input: UpdateWebhookInput, _actor?: unknown) {
      return operation(db, async (tx, authority) => {
        const row = await get(tx, authority, id);
        validateUrl(input.url ?? row.url);
        const { rotateSecret, ...fields } = input;
        const secret = rotateSecret ? randomBytes(32).toString("hex") : row.secret;
        const [updated] = await tx.update(webhooks).set({ ...fields, secret, ...binding(context, row), updatedAt: new Date() }).where(eq(webhooks.id, id)).returning();
        await auditIdentity(tx, rotateSecret ? "webhook.secret_rotated" : "webhook.updated", authority.actor.id, authority.actor.id, id);
        return { ...dto(updated!), ...(rotateSecret ? { secret } : {}) };
      });
    },
    async deleteWebhook(db: Database, id: string, _actor?: unknown) {
      return operation(db, async (tx, authority) => {
        const row = await get(tx, authority, id);
        await tx.delete(webhooks).where(eq(webhooks.id, id));
        await auditIdentity(tx, "webhook.deleted", authority.actor.id, authority.actor.id, id);
        return dto(row);
      });
    },
    async listWebhookDeliveries(db: Database, id: string, filters?: { status?: string; limit?: number; offset?: number }) {
      return operation(db, async (tx, authority) => {
        const row = await get(tx, authority, id);
        if (!row.bindingId) return [];
        const limit = filters?.limit ?? 20, offset = filters?.offset ?? 0;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new ValidationError("Invalid delivery pagination");
        const attempts = await tx.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.webhookId, id), eq(webhookDeliveries.bindingId, row.bindingId), filters?.status ? eq(webhookDeliveries.status, filters.status as Delivery["status"]) : undefined)).orderBy(desc(webhookDeliveries.createdAt)).limit(limit).offset(offset);
        return attempts.map(deliveryDto);
      });
    },
    async getWebhookDeliveryAttempts(db: Database, id: string, deliveryId: string) {
      return operation(db, async (tx, authority) => {
        const hook = await get(tx, authority, id);
        const delivery = await tx.query.webhookDeliveries.findFirst({ where: and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, id), eq(webhookDeliveries.bindingId, hook.bindingId!)) });
        if (!delivery) throw new NotFoundError("Delivery not found");
        return tx.select().from(webhookDeliveryAttempts).where(eq(webhookDeliveryAttempts.deliveryId, deliveryId)).orderBy(desc(webhookDeliveryAttempts.attempt)).limit(100);
      });
    },
    async sendTestEvent(db: Database, id: string) {
      const row = await operation(db, (tx, authority) => get(tx, authority, id));
      const delivery = await enqueueDelivery(db, row, null, true);
      await runWebhookDeliveryOnce(db, delivery.id);
      return deliveryDto((await db.query.webhookDeliveries.findFirst({ where: eq(webhookDeliveries.id, delivery.id) }))!);
    },
    async retryWebhookDelivery(db: Database, id: string, deliveryId: string) {
      if (!stableActorReferenceSchema.safeParse({ id: deliveryId, type: "human" }).success) throw new ValidationError("Invalid delivery ID");
      const attempt = await operation(db, async (tx, authority) => {
        const row = await get(tx, authority, id);
        if (!row.bindingId) throw new NotFoundError("Delivery not found");
        const attempt = await tx.query.webhookDeliveries.findFirst({ where: and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, id), eq(webhookDeliveries.bindingId, row.bindingId)) });
        if (!attempt || !["failed", "success"].includes(attempt.status)) throw new NotFoundError("Delivery not found");
        return { row, attempt };
      });
      const payload = attempt.attempt.payload as { data: RealtimeEvent };
      await liveBinding(db, attempt.row);
      if (attempt.attempt.eventType !== "webhook.test" && !await payloadFor(db, attempt.row, payload.data)) throw new AuthorizationError();
      const replay = await enqueueDelivery(db, attempt.row, payload.data, attempt.attempt.eventType === "webhook.test", attempt.attempt);
      await runWebhookDeliveryOnce(db, replay.id);
      return deliveryDto((await db.query.webhookDeliveries.findFirst({ where: eq(webhookDeliveries.id, replay.id) }))!);
    },
  };
}

async function enqueueDelivery(db: Database, row: Webhook, event: RealtimeEvent | null, test = false, replay?: Delivery) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const current = await tx.query.webhooks.findFirst({ where: eq(webhooks.id, row.id) });
    if (!current || current.bindingId !== row.bindingId || !current.active) throw new AuthorizationError();
    await liveBinding(tx as unknown as Database, current);
    const id = replay?.eventId ?? event?.eventId ?? randomUUID();
    const payload = test ? { event: "webhook.test", timestamp: new Date().toISOString(), data: { webhookId: row.id, message: "This is a test event from Task Weaver" } }
      : event ? await payloadFor(tx as unknown as Database, current, event) : null;
    if (!payload) throw new AuthorizationError();
    const snapshot = replay?.payload as { timestamp?: string; actor?: unknown; causationId?: unknown; correlationId?: unknown } | undefined;
    const [delivery] = await tx.insert(webhookDeliveries).values({ webhookId: row.id, bindingId: row.bindingId, eventId: id,
      eventType: payload.event, payload: { version: 1, id, ...payload, timestamp: snapshot?.timestamp ?? payload.timestamp,
        ...(snapshot ? { actor: snapshot.actor ?? null, causationId: snapshot.causationId ?? null, correlationId: snapshot.correlationId ?? id } : {}) }, replayOf: replay?.id,
      retryCount: replay ? replay.retryCount + 1 : 0, status: "pending" }).onConflictDoNothing().returning();
    if (delivery) return delivery;
    const existing = await tx.query.webhookDeliveries.findFirst({ where: and(eq(webhookDeliveries.webhookId, row.id), eq(webhookDeliveries.bindingId, row.bindingId!), eq(webhookDeliveries.eventId, id), isNull(webhookDeliveries.replayOf)) });
    if (!existing) throw new NotFoundError("Delivery not found");
    return existing;
  });
}

/** Durable fanout is atomic with marking an event expanded; duplicate notifications cannot multiply deliveries. */
export async function expandWebhookEvent(db: Database, eventId?: string) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const [event] = await tx.select().from(webhookEvents).where(and(isNull(webhookEvents.expandedAt), eventId ? eq(webhookEvents.id, eventId) : undefined)).orderBy(asc(webhookEvents.occurredAt)).limit(1).for("update", { skipLocked: true });
    if (!event) return false;
    const source = event.event as RealtimeEvent;
    if (eventMap[source.type]) {
      const hooks = await tx.select().from(webhooks).where(and(eq(webhooks.active, true), lte(webhooks.createdAt, event.occurredAt)));
      for (const hook of hooks) {
        try {
          const payload = await payloadFor(tx as unknown as Database, hook, source);
          if (!payload) continue;
          await tx.insert(webhookDeliveries).values({ webhookId: hook.id, bindingId: hook.bindingId, eventId: event.id,
            eventType: payload.event, payload: { version: event.version, id: event.id, ...payload, actor: event.actorId ? { id: event.actorId, type: event.actorType } : null,
              causationId: event.causationId, correlationId: event.correlationId }, status: "pending" }).onConflictDoNothing();
        } catch (error) { if (!(error instanceof AuthenticationError || error instanceof AuthorizationError || error instanceof NotFoundError)) throw error; }
      }
    }
    await tx.update(webhookEvents).set({ expandedAt: new Date() }).where(eq(webhookEvents.id, event.id));
    return true;
  });
}

/** One leased attempt, with bounded retries and a stable delivery/event identity for receiver deduplication. */
export async function runWebhookDeliveryOnce(db: Database, deliveryId?: string) {
  const now = new Date(), leaseId = randomUUID();
  const delivery = await db.transaction(async tx => {
    const [row] = await tx.select().from(webhookDeliveries).where(and(isNotNull(webhookDeliveries.eventId),
      deliveryId ? eq(webhookDeliveries.id, deliveryId) : undefined,
      or(eq(webhookDeliveries.status, "pending"), and(eq(webhookDeliveries.status, "failed"), isNotNull(webhookDeliveries.nextRetryAt), lte(webhookDeliveries.nextRetryAt, now))),
      or(isNull(webhookDeliveries.leaseExpiresAt), lte(webhookDeliveries.leaseExpiresAt, now))))
      .orderBy(asc(webhookDeliveries.createdAt)).limit(1).for("update", { skipLocked: true });
    if (!row) return null;
    const [claimed] = await tx.update(webhookDeliveries).set({ leaseId, leaseExpiresAt: new Date(Date.now() + 30_000) }).where(eq(webhookDeliveries.id, row.id)).returning();
    return claimed!;
  });
  if (!delivery) return false;
  const fence = and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.leaseId, leaseId));
  const prior = await db.select().from(webhookDeliveryAttempts).where(eq(webhookDeliveryAttempts.deliveryId, delivery.id)).orderBy(desc(webhookDeliveryAttempts.attempt)).limit(1);
  const attempt = (prior[0]?.attempt ?? -1) + 1;
  await db.update(webhookDeliveryAttempts).set({ outcome: "unknown", errorCode: "WORKER_INTERRUPTED", endedAt: new Date() })
    .where(and(eq(webhookDeliveryAttempts.deliveryId, delivery.id), eq(webhookDeliveryAttempts.outcome, "pending")));
  const [receipt] = await db.insert(webhookDeliveryAttempts).values({ deliveryId: delivery.id, attempt, outcome: "pending" }).returning();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let status: number | null = null, errorCode: string | null = null, retryable = false;
  try {
    let responsePromise: Promise<Response> | undefined;
    await db.transaction(async tx => {
      await lockIdentityLifecycle(tx);
      const hook = await tx.query.webhooks.findFirst({ where: eq(webhooks.id, delivery.webhookId) });
      if (!hook || hook.bindingId !== delivery.bindingId || !hook.active) throw new AuthorizationError();
      await liveBinding(tx as unknown as Database, hook);
      const payload = delivery.payload as { data: RealtimeEvent };
      if (delivery.eventType !== "webhook.test" && !await payloadFor(tx as unknown as Database, hook, payload.data)) throw new AuthorizationError();
      const current = await tx.query.webhookDeliveries.findFirst({ where: fence });
      if (!current || !current.leaseExpiresAt || current.leaseExpiresAt <= new Date()) throw new AuthorizationError();
      const body = JSON.stringify(delivery.payload), timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac("sha256", hook.secret).update(body).digest("hex");
      const signed = createHmac("sha256", hook.secret).update(`${timestamp}.${body}`).digest("hex");
      responsePromise = fetch(hook.url, { method: "POST", redirect: "manual", signal: controller.signal, body, headers: {
        "Content-Type": "application/json", "X-TaskWeaver-Event": delivery.eventType, "X-TaskWeaver-Event-Id": delivery.eventId!,
        "X-TaskWeaver-Delivery": delivery.id, "X-TaskWeaver-Timestamp": timestamp,
        "X-TaskWeaver-Signature": `sha256=${signature}`, "X-TaskWeaver-Signature-V1": `t=${timestamp},v1=${signed}`,
      } });
      responsePromise.catch(() => {});
    });
    const response = await responsePromise!;
    status = response.status;
    if (!response.ok) { errorCode = `HTTP_${status}`; retryable = [408, 425, 429].includes(status) || status >= 500; }
    await response.body?.cancel();
  } catch (error) {
    controller.abort();
    const revoked = error instanceof AuthorizationError || error instanceof AuthenticationError || error instanceof NotFoundError;
    errorCode = revoked ? "AUTHORITY_REVOKED" : "TRANSPORT_FAILED"; retryable = !revoked;
  } finally { clearTimeout(timer); }
  const succeeded = errorCode === null;
  const retryCount = Math.max(delivery.retryCount, attempt);
  await db.transaction(async tx => {
    const held = await tx.query.webhookDeliveries.findFirst({ where: fence });
    if (!held) return;
    await tx.update(webhookDeliveryAttempts).set({ outcome: succeeded ? "success" : errorCode === "AUTHORITY_REVOKED" ? "revoked" : "failed",
      httpStatus: status, errorCode, endedAt: new Date() }).where(eq(webhookDeliveryAttempts.id, receipt!.id));
    await tx.update(webhookDeliveries).set({ status: succeeded ? "success" : "failed", httpStatus: status, errorMessage: errorCode,
      retryCount, nextRetryAt: !succeeded && retryable && attempt < 5 ? new Date(Date.now() + Math.min(3600_000, 1000 * 2 ** attempt)) : null,
      deliveredAt: succeeded ? new Date() : null, leaseId: null, leaseExpiresAt: null }).where(fence);
  });
  return true;
}

/** Compatibility notifications enqueue durable identity first; periodic workers recover without any notification. */
export async function deliverEvent(db: Database, event: RealtimeEvent) {
  if (!eventMap[event.type]) return;
  const id = event.eventId ?? randomUUID(), occurredAt = new Date(event.serverTime ?? Date.now());
  if (event.attributes?.durableOutbox !== true) await db.insert(webhookEvents).values({ id, eventType: event.type, projectId: "projectId" in event ? event.projectId : null,
    correlationId: id, event: { ...event, eventId: id, serverTime: occurredAt.toISOString() }, occurredAt }).onConflictDoNothing();
  await expandWebhookEvent(db, id);
  const deliveries = await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(eq(webhookDeliveries.eventId, id)).limit(100);
  for (const delivery of deliveries) await runWebhookDeliveryOnce(db, delivery.id);
}

/** Unbound compatibility exports stay closed. */
const denied = async (..._args: unknown[]): Promise<never> => { throw new AuthorizationError(); };
export const createWebhook = denied, getWebhook = denied, listWebhooks = denied, updateWebhook = denied, deleteWebhook = denied, listWebhookDeliveries = denied, sendTestEvent = denied;
