import { Hono } from "hono";
import {
  assistantService,
  buildAssistantContextSchema,
  executeAssistantActionSchema,
  NotFoundError,
  sendAssistantMessageSchema,
  updateAssistantActionStatusSchema,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const assistantRoutes = new Hono<Env>();

assistantRoutes.post("/context", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = buildAssistantContextSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await assistantService.buildAssistantContext(db, parsed.data, actor));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

assistantRoutes.post("/chat", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = sendAssistantMessageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await assistantService.sendReadOnlyMessage(db, parsed.data, actor), 201);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

assistantRoutes.post("/actions/:id/execute", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const parsed = executeAssistantActionSchema.safeParse({ id: c.req.param("id") });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await assistantService.executeApprovedAction(db, parsed.data.id, actor));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

assistantRoutes.patch("/actions/:id/status", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = updateAssistantActionStatusSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await assistantService.updateActionStatus(db, c.req.param("id"), parsed.data, actor));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

export default assistantRoutes;
