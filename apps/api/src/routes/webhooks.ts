import { Hono } from "hono";
import { createWebhookService, NotFoundError } from "@task-weaver/core";
import {
  createWebhookSchema,
  updateWebhookSchema,
  listWebhooksSchema,
  listWebhookDeliveriesSchema,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const webhooksRouter = new Hono<Env>();

// POST / — Create webhook
webhooksRouter.post("/", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();

  const parsed = createWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation error", details: parsed.error.flatten() },
      400,
    );
  }

  const webhook = await createWebhookService(c.get("identity")).createWebhook(db, parsed.data, actor);
  return c.json(webhook, 201);
});

// GET / — List webhooks
webhooksRouter.get("/", async (c) => {
  const db = c.get("db");
  const query = c.req.query();

  const parsed = listWebhooksSchema.safeParse(query);
  if (!parsed.success) {
    return c.json(
      { error: "Validation error", details: parsed.error.flatten() },
      400,
    );
  }

  const list = await createWebhookService(c.get("identity")).listWebhooks(db, parsed.data);
  return c.json(list);
});

// GET /:id — Get webhook detail
webhooksRouter.get("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const webhook = await createWebhookService(c.get("identity")).getWebhook(db, id);
    return c.json(webhook);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// PATCH /:id — Update webhook
webhooksRouter.patch("/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = updateWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation error", details: parsed.error.flatten() },
      400,
    );
  }

  try {
    const webhook = await createWebhookService(c.get("identity")).updateWebhook(
      db,
      id,
      parsed.data,
      actor,
    );
    return c.json(webhook);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// DELETE /:id — Delete webhook
webhooksRouter.delete("/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");

  try {
    await createWebhookService(c.get("identity")).deleteWebhook(db, id, actor);
    return c.json({ deleted: true });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// GET /:id/deliveries — List delivery attempts
webhooksRouter.get("/:id/deliveries", async (c) => {
  const db = c.get("db");
  const webhookId = c.req.param("id");
  const query = c.req.query();

  const parsed = listWebhookDeliveriesSchema.safeParse(query);
  if (!parsed.success) {
    return c.json(
      { error: "Validation error", details: parsed.error.flatten() },
      400,
    );
  }

  try {
    const deliveries = await createWebhookService(c.get("identity")).listWebhookDeliveries(
      db,
      webhookId,
      parsed.data,
    );
    return c.json(deliveries);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// POST /:id/test — Send test event
webhooksRouter.post("/:id/test", async (c) => {
  const db = c.get("db");
  const webhookId = c.req.param("id");

  try {
    const delivery = await createWebhookService(c.get("identity")).sendTestEvent(db, webhookId);
    return c.json(delivery);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// POST /:id/deliveries/:deliveryId/retry — Retry under the current bound authority.
webhooksRouter.post("/:id/deliveries/:deliveryId/retry", async (c) => {
  return c.json(await createWebhookService(c.get("identity")).retryWebhookDelivery(c.get("db"), c.req.param("id"), c.req.param("deliveryId")));
});

export default webhooksRouter;
