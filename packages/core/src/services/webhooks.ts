import { eq, and, desc } from "drizzle-orm";
import { type Database, webhooks, webhookDeliveries } from "@task-weaver/db";
import { createHmac, randomBytes } from "crypto";
import { NotFoundError } from "@task-weaver/contracts";
import type { CreateWebhookInput, RealtimeEvent, UpdateWebhookInput } from "@task-weaver/contracts";

type Actor = { id: string; type: "human" | "agent" };

function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Map a RealtimeEvent type to a webhook event string.
 */
function mapEventType(type: RealtimeEvent["type"]): string | null {
  const map: Record<string, string> = {
    task_created: "task.created",
    task_updated: "task.updated",
    task_status_changed: "task.status_changed",
    task_commented: "task.commented",
    task_deleted: "task.deleted",
    requirement_created: "requirement.created",
    requirement_updated: "requirement.updated",
    requirement_deleted: "requirement.deleted",
    document_created: "document.created",
    document_updated: "document.updated",
    document_deleted: "document.deleted",
    document_linked: "document.linked",
    document_unlinked: "document.linked",
    document_task_linked: "document.linked",
    document_task_unlinked: "document.linked",
  };
  return map[type] ?? null;
}

/**
 * Extract the projectId from a realtime event (if present).
 */
function getProjectId(event: RealtimeEvent): string | null {
  if ("projectId" in event && event.projectId) {
    return event.projectId;
  }
  return null;
}

export async function createWebhook(
  db: Database,
  input: CreateWebhookInput,
  _actor: Actor,
) {
  const secret = input.secret ?? generateSecret();
  const [webhook] = await db
    .insert(webhooks)
    .values({
      projectId: input.projectId ?? null,
      url: input.url,
      events: input.events,
      secret,
      active: input.active ?? true,
      description: input.description ?? null,
    })
    .returning();

  return { ...webhook!, secret };
}

export async function getWebhook(db: Database, id: string) {
  const [webhook] = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.id, id))
    .limit(1);
  if (!webhook) throw new NotFoundError("Webhook not found");
  return webhook;
}

export async function listWebhooks(
  db: Database,
  filters?: { projectId?: string; active?: boolean },
) {
  const conditions = [];
  if (filters?.projectId) {
    conditions.push(eq(webhooks.projectId, filters.projectId));
  }
  if (filters?.active !== undefined) {
    conditions.push(eq(webhooks.active, filters.active));
  }

  const query = db
    .select({
      id: webhooks.id,
      projectId: webhooks.projectId,
      url: webhooks.url,
      events: webhooks.events,
      active: webhooks.active,
      description: webhooks.description,
      createdAt: webhooks.createdAt,
      updatedAt: webhooks.updatedAt,
    })
    .from(webhooks)
    .orderBy(desc(webhooks.createdAt));

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
}

export async function updateWebhook(
  db: Database,
  id: string,
  input: UpdateWebhookInput,
  _actor: Actor,
) {
  const [existing] = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.id, id))
    .limit(1);
  if (!existing) throw new NotFoundError("Webhook not found");

  const [updated] = await db
    .update(webhooks)
    .set({
      ...(input.url !== undefined && { url: input.url }),
      ...(input.events !== undefined && { events: input.events }),
      ...(input.active !== undefined && { active: input.active }),
      ...(input.description !== undefined && { description: input.description }),
      updatedAt: new Date(),
    })
    .where(eq(webhooks.id, id))
    .returning();

  return updated!;
}

export async function deleteWebhook(db: Database, id: string, _actor: Actor) {
  const [deleted] = await db
    .delete(webhooks)
    .where(eq(webhooks.id, id))
    .returning();
  if (!deleted) throw new NotFoundError("Webhook not found");
  return deleted;
}

export async function listWebhookDeliveries(
  db: Database,
  webhookId: string,
  filters?: { status?: string; limit?: number; offset?: number },
) {
  // Verify webhook exists
  const [wh] = await db
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(eq(webhooks.id, webhookId))
    .limit(1);
  if (!wh) throw new NotFoundError("Webhook not found");

  const conditions = [eq(webhookDeliveries.webhookId, webhookId)];
  if (filters?.status) {
    conditions.push(
      eq(webhookDeliveries.status, filters.status as "pending" | "success" | "failed"),
    );
  }

  const limit = filters?.limit ?? 20;
  const offset = filters?.offset ?? 0;

  return db
    .select()
    .from(webhookDeliveries)
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Deliver a realtime event to all matching webhooks.
 * Called internally when a realtime event is emitted.
 */
export async function deliverEvent(db: Database, event: RealtimeEvent) {
  const eventType = mapEventType(event.type);
  if (!eventType) return;

  const projectId = getProjectId(event);

  // Find all active webhooks that subscribe to this event type
  const allWebhooks = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.active, true));

  const matchingWebhooks = allWebhooks.filter((wh) => {
    // Check event type match
    const events = wh.events as string[];
    if (!events.includes(eventType)) return false;
    // Project-scoped webhook must match projectId
    if (wh.projectId && projectId && wh.projectId !== projectId) return false;
    // Project-scoped webhook doesn't match events without projectId
    if (wh.projectId && !projectId) return false;
    return true;
  });

  if (matchingWebhooks.length === 0) return;

  const payload = JSON.stringify({
    event: eventType,
    timestamp: new Date().toISOString(),
    data: event,
  });

  // Deliver to each matching webhook
  const deliveryPromises = matchingWebhooks.map(async (wh) => {
    const signature = signPayload(payload, wh.secret);

    // Create delivery record
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        webhookId: wh.id,
        eventType,
        payload: JSON.parse(payload),
        status: "pending",
        retryCount: 0,
      })
      .returning();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(wh.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-TaskWeaver-Event": eventType,
          "X-TaskWeaver-Signature": `sha256=${signature}`,
          "X-TaskWeaver-Delivery": delivery!.id,
        },
        body: payload,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const responseBody = await response.text().catch(() => "");

      await db
        .update(webhookDeliveries)
        .set({
          status: response.ok ? "success" : "failed",
          httpStatus: response.status,
          responseBody: responseBody.slice(0, 1000),
          errorMessage: response.ok ? null : `HTTP ${response.status}`,
        })
        .where(eq(webhookDeliveries.id, delivery!.id));
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Unknown error";
      await db
        .update(webhookDeliveries)
        .set({
          status: "failed",
          errorMessage: errorMsg.slice(0, 1000),
        })
        .where(eq(webhookDeliveries.id, delivery!.id));
    }
  });

  // Fire all deliveries concurrently, don't block the caller
  await Promise.allSettled(deliveryPromises);
}

/**
 * Send a test event to a webhook. Used for verification.
 */
export async function sendTestEvent(db: Database, webhookId: string) {
  const [wh] = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.id, webhookId))
    .limit(1);
  if (!wh) throw new NotFoundError("Webhook not found");

  const payload = JSON.stringify({
    event: "webhook.test",
    timestamp: new Date().toISOString(),
    data: { webhookId: wh.id, message: "This is a test event from Task Weaver" },
  });

  const signature = signPayload(payload, wh.secret);

  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      webhookId: wh.id,
      eventType: "webhook.test",
      payload: JSON.parse(payload),
      status: "pending",
      retryCount: 0,
    })
    .returning();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(wh.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TaskWeaver-Event": "webhook.test",
        "X-TaskWeaver-Signature": `sha256=${signature}`,
        "X-TaskWeaver-Delivery": delivery!.id,
      },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseBody = await response.text().catch(() => "");

    const [updated] = await db
      .update(webhookDeliveries)
      .set({
        status: response.ok ? "success" : "failed",
        httpStatus: response.status,
        responseBody: responseBody.slice(0, 1000),
        errorMessage: response.ok ? null : `HTTP ${response.status}`,
      })
      .where(eq(webhookDeliveries.id, delivery!.id))
      .returning();

    return updated!;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    const [updated] = await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        errorMessage: errorMsg.slice(0, 1000),
      })
      .where(eq(webhookDeliveries.id, delivery!.id))
      .returning();

    return updated!;
  }
}
