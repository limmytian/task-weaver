import { Hono } from "hono";
import {
  assistantService,
  buildAssistantContextSchema,
  executeAssistantActionSchema,
  listAssistantConversationsSchema,
  NotFoundError,
  renameAssistantConversationSchema,
  sendAssistantMessageSchema,
  updateAssistantActionStatusSchema,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const assistantRoutes = new Hono<Env>();

assistantRoutes.get("/conversations", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const query = c.req.query();
  const parsed = listAssistantConversationsSchema.safeParse({
    projectId: query.projectId,
    requirementId: query.requirementId,
    taskId: query.taskId,
    scheduleId: query.scheduleId,
    contextKind: query.contextKind,
    limit: query.limit,
    offset: query.offset,
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await assistantService.listConversations(db, parsed.data, actor));
});

assistantRoutes.get("/conversations/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  try {
    return c.json(await assistantService.getConversation(db, c.req.param("id"), actor));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

assistantRoutes.patch("/conversations/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = renameAssistantConversationSchema.safeParse({
    id: c.req.param("id"),
    title: body.title,
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await assistantService.renameConversation(db, parsed.data, actor));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

assistantRoutes.delete("/conversations/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  try {
    await assistantService.deleteConversation(db, c.req.param("id"), actor);
    return c.json({ success: true });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

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
