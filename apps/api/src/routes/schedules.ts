import { Hono } from "hono";
import {
  NotFoundError,
  ValidationError,
  acquireDueSchedulesSchema,
  createScheduleSchema,
  listSchedulesSchema,
  createResourceServices,
  updateScheduleSchema,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const scheduleRoutes = new Hono<Env>();

scheduleRoutes.get("/projects/:projectId/schedules", async (c) => {
  const db = c.get("db");
  const projectId = c.req.param("projectId");
  const query = c.req.query();
  const parsed = listSchedulesSchema.safeParse({
    projectId,
    status: query.status,
    targetScope: query.targetScope,
    includeArchived: query.includeArchived,
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await createResourceServices(c.get("identity")).scheduleService.listSchedules(db, parsed.data));
});

scheduleRoutes.post("/projects/:projectId/schedules", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");
  const body = await c.req.json();
  const parsed = createScheduleSchema.safeParse({ ...body, projectId, targetScope: body.targetScope ?? "project" });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await createResourceServices(c.get("identity")).scheduleService.createSchedule(db, parsed.data, actor), 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

scheduleRoutes.post("/schedules/acquire-due", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json().catch(() => ({}));
  const parsed = acquireDueSchedulesSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json({ items: await createResourceServices(c.get("identity")).scheduleService.acquireDueSchedules(db, parsed.data, actor) });
});

scheduleRoutes.get("/schedules/:id", async (c) => {
  const db = c.get("db");
  try {
    return c.json(await createResourceServices(c.get("identity")).scheduleService.getSchedule(db, c.req.param("id")));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

scheduleRoutes.patch("/schedules/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();
  const parsed = updateScheduleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await createResourceServices(c.get("identity")).scheduleService.updateSchedule(db, c.req.param("id"), parsed.data, actor));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

scheduleRoutes.delete("/schedules/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  try {
    return c.json(await createResourceServices(c.get("identity")).scheduleService.archiveSchedule(db, c.req.param("id"), actor));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

scheduleRoutes.post("/schedules/:id/run-now", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  try {
    return c.json(await createResourceServices(c.get("identity")).scheduleService.runScheduleNow(db, c.req.param("id"), actor), 201);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

scheduleRoutes.get("/schedules/:id/runs", async (c) => {
  const db = c.get("db");
  try {
    return c.json(await createResourceServices(c.get("identity")).scheduleService.listScheduleRuns(db, c.req.param("id")));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

export default scheduleRoutes;
