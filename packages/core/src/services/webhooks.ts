import { eq, and, or, desc, inArray, isNull, type SQL } from "drizzle-orm";
import { type Database, webhooks, webhookDeliveries } from "@task-weaver/db";
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
  return { id: row.id, webhookId: row.webhookId, eventType: row.eventType, status: row.status, httpStatus: row.httpStatus, retryCount: row.retryCount, createdAt: row.createdAt };
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
  return { event: eventMap[event.type]!, timestamp: new Date().toISOString(), data };
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
    async sendTestEvent(db: Database, id: string) {
      const row = await operation(db, (tx, authority) => get(tx, authority, id));
      return dispatch(db, row.id, row.bindingId, null, true);
    },
    async retryWebhookDelivery(db: Database, id: string, deliveryId: string) {
      if (!stableActorReferenceSchema.safeParse({ id: deliveryId, type: "human" }).success) throw new ValidationError("Invalid delivery ID");
      const attempt = await operation(db, async (tx, authority) => {
        const row = await get(tx, authority, id);
        if (!row.bindingId) throw new NotFoundError("Delivery not found");
        const attempt = await tx.query.webhookDeliveries.findFirst({ where: and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, id), eq(webhookDeliveries.bindingId, row.bindingId)) });
        if (!attempt || attempt.status !== "failed") throw new NotFoundError("Delivery not found");
        return { row, attempt };
      });
      const payload = attempt.attempt.payload as { data: RealtimeEvent };
      return dispatch(db, id, attempt.row.bindingId, payload.data, attempt.attempt.eventType === "webhook.test", attempt.attempt.retryCount + 1);
    },
  };
}

/** Recheck persisted owner, credential, ceiling, configuration generation and resources at dispatch. */
async function dispatch(db: Database, id: string, bindingId: string | null, event: RealtimeEvent | null, test = false, retryCount = 0) {
  let responsePromise: Promise<Response> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let delivery: Delivery | undefined;
  try {
    await db.transaction(async tx => {
      await lockIdentityLifecycle(tx);
      const txDb = tx as unknown as Database;
      const row = await tx.query.webhooks.findFirst({ where: eq(webhooks.id, id) });
      if (!row || row.bindingId !== bindingId || !row.active) throw new AuthorizationError();
      await liveBinding(txDb, row);
      const payload = test ? { event: "webhook.test", timestamp: new Date().toISOString(), data: { webhookId: id, message: "This is a test event from Task Weaver" } } : event ? await payloadFor(txDb, row, event) : null;
      if (!payload) throw new AuthorizationError();
      const body = JSON.stringify(payload);
      [delivery] = await tx.insert(webhookDeliveries).values({ webhookId: id, bindingId, eventType: payload.event, payload, status: "pending", retryCount }).returning();
      const signature = createHmac("sha256", row.secret).update(body).digest("hex");
      timer = setTimeout(() => controller.abort(), 10_000);
      // Start dispatch while authority is locked. Revocation cannot restore queued/retry eligibility.
      responsePromise = fetch(row.url, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", "X-TaskWeaver-Event": payload.event, "X-TaskWeaver-Signature": `sha256=${signature}`, "X-TaskWeaver-Delivery": delivery!.id }, body, signal: controller.signal });
      responsePromise.catch(() => {});
    });
    const response = await responsePromise!;
    const [updated] = await db.update(webhookDeliveries).set({ status: response.ok ? "success" : "failed", httpStatus: response.status, errorMessage: response.ok ? null : `HTTP ${response.status}` }).where(eq(webhookDeliveries.id, delivery!.id)).returning();
    await response.body?.cancel();
    return deliveryDto(updated!);
  } catch (error) {
    if (!delivery) throw error;
    controller.abort();
    const [updated] = await db.update(webhookDeliveries).set({ status: "failed", errorMessage: "Webhook delivery failed" }).where(eq(webhookDeliveries.id, delivery.id)).returning();
    if (!updated) throw new NotFoundError("Delivery not found");
    return deliveryDto(updated);
  } finally { clearTimeout(timer); }
}

/** Background fanout can use only persisted, revocable bindings established by verified management. */
export async function deliverEvent(db: Database, event: RealtimeEvent) {
  if (!eventMap[event.type]) return;
  const rows = await db.select({ id: webhooks.id, bindingId: webhooks.bindingId }).from(webhooks).where(eq(webhooks.active, true));
  // Sequential bounded dispatch avoids an unbounded burst of external requests and database locks.
  for (const row of rows) {
    try { await dispatch(db, row.id, row.bindingId, event); }
    catch (error) {
      if (!(error instanceof AuthenticationError || error instanceof AuthorizationError || error instanceof NotFoundError)) throw error;
    }
  }
}

/** Unbound compatibility exports stay closed. */
const denied = async (..._args: unknown[]): Promise<never> => { throw new AuthorizationError(); };
export const createWebhook = denied, getWebhook = denied, listWebhooks = denied, updateWebhook = denied, deleteWebhook = denied, listWebhookDeliveries = denied, sendTestEvent = denied;
