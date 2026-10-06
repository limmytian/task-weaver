import { Hono } from "hono";
import { z } from "zod";
import {
  agentUsageService,
  reportTiAgentUsageSchema,
  acquireTiAgentRunSchema,
  completeTiAgentRunSchema,
  createTiAgentRunSchema,
  listTiAgentRunsSchema,
  listTiModelConfigsSchema,
  NotFoundError,
  createResourceServices,
  resolveTiModelSchema,
  setDefaultTiModelSchema,
  upsertTiAgentPolicySchema,
  upsertTiModelConfigSchema,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const tiRoutes = new Hono<Env>();

tiRoutes.get("/configs", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const query = c.req.query();
  const parsed = listTiModelConfigsSchema.safeParse({
    ownerId: query.ownerId,
    ownerType: query.ownerType,
    includeDisabled: query.includeDisabled,
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await createResourceServices(c.get("identity")).tiAgentService.listModelConfigs(db, parsed.data, actor));
});

tiRoutes.post("/configs", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = upsertTiModelConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await createResourceServices(c.get("identity")).tiAgentService.upsertModelConfig(db, parsed.data, actor), 201);
});

tiRoutes.post("/configs/default", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = setDefaultTiModelSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await createResourceServices(c.get("identity")).tiAgentService.setDefaultModel(db, parsed.data, actor));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

tiRoutes.post("/resolve-model", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json().catch(() => ({}));
  const parsed = resolveTiModelSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await createResourceServices(c.get("identity")).tiAgentService.resolveModel(db, parsed.data, actor));
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

tiRoutes.get("/policy", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const query = c.req.query();
  return c.json(await createResourceServices(c.get("identity")).tiAgentService.getPolicy(db, {
    ownerId: query.ownerId,
    ownerType: query.ownerType as "human" | "agent" | undefined,
  }, actor));
});

tiRoutes.put("/policy", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = upsertTiAgentPolicySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await createResourceServices(c.get("identity")).tiAgentService.upsertPolicy(db, parsed.data, actor));
});

tiRoutes.get("/runs", async (c) => {
  const db = c.get("db");
  const query = c.req.query();
  const parsed = listTiAgentRunsSchema.safeParse({
    taskId: query.taskId,
    scheduleRunId: query.scheduleRunId,
    assignedAgentId: query.assignedAgentId,
    status: query.status,
    limit: query.limit,
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await createResourceServices(c.get("identity")).tiAgentService.listRuns(db, parsed.data));
});

tiRoutes.get("/runs/:id", async (c) => {
  const db = c.get("db");
  try {
    return c.json(await createResourceServices(c.get("identity")).tiAgentService.getRun(db, c.req.param("id")));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

tiRoutes.post("/runs", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = createTiAgentRunSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await createResourceServices(c.get("identity")).tiAgentService.createRun(db, parsed.data, actor), 201);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

tiRoutes.post("/runs/acquire", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = acquireTiAgentRunSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await createResourceServices(c.get("identity")).tiAgentService.acquireRun(db, parsed.data, actor));
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

tiRoutes.post("/runs/:id/complete", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = completeTiAgentRunSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await createResourceServices(c.get("identity")).tiAgentService.completeRun(db, c.req.param("id"), parsed.data, actor));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

tiRoutes.post("/runs/:id/usage", async (c) => {
  if (!c.req.header("Authorization")?.startsWith("Bearer ") || !c.get("actor").id.startsWith("apikey:")) return c.json({ error: "Authenticated API key required" }, 401);
  const parsed = reportTiAgentUsageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await agentUsageService.reportTiUsage(c.get("db"), c.req.param("id"), parsed.data, c.get("actor")));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

tiRoutes.post("/runs/:id/usage/:processId/finish", async (c) => {
  if (!c.req.header("Authorization")?.startsWith("Bearer ") || !c.get("actor").id.startsWith("apikey:")) return c.json({ error: "Authenticated API key required" }, 401);
  const parsed = z.object({ outcome: z.enum(["succeeded", "failed", "cancelled"]), endedAt: z.string().datetime() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  try {
    return c.json(await agentUsageService.finishTiUsage(c.get("db"), c.req.param("id"), c.req.param("processId"), parsed.data, c.get("actor")));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

export default tiRoutes;
