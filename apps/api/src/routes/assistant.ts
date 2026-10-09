import { Hono } from "hono";
import {
  createAssistantService,
  updateAssistantPolicySchema,
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
assistantRoutes.get("/policy", async c => c.json(await createAssistantService(c.get("identity")).getPolicy(c.get("db"))));
assistantRoutes.patch("/policy", async c => {
  const input = updateAssistantPolicySchema.safeParse(await c.req.json());
  if (!input.success) return c.json({ error: "Invalid assistant policy" }, 400);
  return c.json(await createAssistantService(c.get("identity")).updatePolicy(c.get("db"), input.data));
});

assistantRoutes.get("/conversations", async (c) => {
  const db = c.get("db");
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
  return c.json(await createAssistantService(c.get("identity")).listConversations(db, parsed.data));
});

assistantRoutes.get("/conversations/:id", async (c) => {
  const db = c.get("db");
  try {
    return c.json(await createAssistantService(c.get("identity")).getConversation(db, c.req.param("id")));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

assistantRoutes.patch("/conversations/:id", async (c) => {
  const db = c.get("db");
  const body = await c.req.json();
  const parsed = renameAssistantConversationSchema.safeParse({
    id: c.req.param("id"),
    title: body.title,
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await createAssistantService(c.get("identity")).renameConversation(db, parsed.data));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

assistantRoutes.delete("/conversations/:id", async (c) => {
  const db = c.get("db");
  try {
    await createAssistantService(c.get("identity")).deleteConversation(db, c.req.param("id"));
    return c.json({ success: true });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

assistantRoutes.post("/context", async (c) => {
  const db = c.get("db");
  const body = await c.req.json();
  const parsed = buildAssistantContextSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await createAssistantService(c.get("identity")).buildAssistantContext(db, parsed.data));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

assistantRoutes.post("/chat", async (c) => {
  const db = c.get("db");
  const body = await c.req.json();
  const parsed = sendAssistantMessageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await createAssistantService(c.get("identity")).sendReadOnlyMessage(db, parsed.data), 201);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

assistantRoutes.post("/actions/:id/execute", async (c) => {
  const db = c.get("db");
  const parsed = executeAssistantActionSchema.safeParse({ id: c.req.param("id") });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await createAssistantService(c.get("identity")).executeApprovedAction(db, parsed.data.id));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

assistantRoutes.patch("/actions/:id/status", async (c) => {
  const db = c.get("db");
  const body = await c.req.json();
  const parsed = updateAssistantActionStatusSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await createAssistantService(c.get("identity")).updateActionStatus(db, c.req.param("id"), parsed.data));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

export default assistantRoutes;
