import { Hono } from "hono";
import { z } from "zod";
import {
  agentUsageService,
  reportPiAgentUsageSchema,
  acquirePiAgentRunSchema,
  completePiAgentRunSchema,
  createPiAgentRunSchema,
  listPiAgentRunsSchema,
  listPiModelConfigsSchema,
  NotFoundError,
  piAgentService,
  resolvePiModelSchema,
  setDefaultPiModelSchema,
  upsertPiAgentPolicySchema,
  upsertPiModelConfigSchema,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const piAgentRoutes = new Hono<Env>();

piAgentRoutes.get("/configs", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const query = c.req.query();
  const parsed = listPiModelConfigsSchema.safeParse({
    ownerId: query.ownerId,
    ownerType: query.ownerType,
    includeDisabled: query.includeDisabled,
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await piAgentService.listModelConfigs(db, parsed.data, actor));
});

piAgentRoutes.post("/configs", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = upsertPiModelConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await piAgentService.upsertModelConfig(db, parsed.data, actor), 201);
});

piAgentRoutes.post("/configs/default", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = setDefaultPiModelSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await piAgentService.setDefaultModel(db, parsed.data, actor));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

piAgentRoutes.post("/resolve-model", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json().catch(() => ({}));
  const parsed = resolvePiModelSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await piAgentService.resolveModel(db, parsed.data, actor));
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

piAgentRoutes.get("/policy", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const query = c.req.query();
  return c.json(await piAgentService.getPolicy(db, {
    ownerId: query.ownerId,
    ownerType: query.ownerType as "human" | "agent" | undefined,
  }, actor));
});

piAgentRoutes.put("/policy", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = upsertPiAgentPolicySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await piAgentService.upsertPolicy(db, parsed.data, actor));
});

piAgentRoutes.get("/runs", async (c) => {
  const db = c.get("db");
  const query = c.req.query();
  const parsed = listPiAgentRunsSchema.safeParse({
    taskId: query.taskId,
    scheduleRunId: query.scheduleRunId,
    assignedAgentId: query.assignedAgentId,
    status: query.status,
    limit: query.limit,
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await piAgentService.listRuns(db, parsed.data));
});

piAgentRoutes.get("/runs/:id", async (c) => {
  const db = c.get("db");
  try {
    return c.json(await piAgentService.getRun(db, c.req.param("id")));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

piAgentRoutes.post("/runs", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = createPiAgentRunSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await piAgentService.createRun(db, parsed.data, actor), 201);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

piAgentRoutes.post("/runs/acquire", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = acquirePiAgentRunSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await piAgentService.acquireRun(db, parsed.data, actor));
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

piAgentRoutes.post("/runs/:id/complete", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = completePiAgentRunSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await piAgentService.completeRun(db, c.req.param("id"), parsed.data, actor));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

piAgentRoutes.post("/runs/:id/usage", async (c) => {
  if (!c.req.header("Authorization")?.startsWith("Bearer ") || !c.get("actor").id.startsWith("apikey:")) return c.json({ error: "Authenticated API key required" }, 401);
  const parsed = reportPiAgentUsageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await agentUsageService.reportPiUsage(c.get("db"), c.req.param("id"), parsed.data, c.get("actor")));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

piAgentRoutes.post("/runs/:id/usage/:processId/finish", async (c) => {
  if (!c.req.header("Authorization")?.startsWith("Bearer ") || !c.get("actor").id.startsWith("apikey:")) return c.json({ error: "Authenticated API key required" }, 401);
  const parsed = z.object({ outcome: z.enum(["succeeded", "failed", "cancelled"]), endedAt: z.string().datetime() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await agentUsageService.finishPiUsage(c.get("db"), c.req.param("id"), c.req.param("processId"), parsed.data, c.get("actor")));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

export default piAgentRoutes;
