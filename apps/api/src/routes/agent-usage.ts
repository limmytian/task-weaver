import { Hono } from "hono";
import { z } from "zod";
import {
  agentUsageQuerySchema,
  reportAgentUsageSchema,
  createResourceServices,
  NotFoundError,
  ValidationError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";
const routes = new Hono<Env>();
routes.onError((error, c) => {
  if (error instanceof NotFoundError)
    return c.json({ error: error.message }, 404);
  if (error instanceof ValidationError)
    return c.json({ error: error.message }, 400);
  throw error;
});
routes.post("/runs", async (c) => {
  const parsed = reportAgentUsageSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success)
    return c.json(
      { error: "Validation error", details: parsed.error.flatten() },
      400,
    );
  return c.json(
    await createResourceServices(c.get("identity")).agentUsageService.reportDaemonUsage(
      c.get("db"),
      parsed.data,
      c.get("actor"),
    ),
  );
});
routes.get("/runs", async (c) => {
  const parsed = agentUsageQuerySchema.safeParse(c.req.query());
  if (!parsed.success)
    return c.json(
      { error: "Validation error", details: parsed.error.flatten() },
      400,
    );
  return c.json(await createResourceServices(c.get("identity")).agentUsageService.listUsage(c.get("db"), parsed.data));
});
routes.get("/summary", async (c) => {
  const parsed = agentUsageQuerySchema.safeParse(c.req.query());
  if (!parsed.success)
    return c.json(
      { error: "Validation error", details: parsed.error.flatten() },
      400,
    );
  return c.json(
    await createResourceServices(c.get("identity")).agentUsageService.summarizeUsage(c.get("db"), parsed.data),
  );
});
routes.get("/runs/:id", async (c) => {
  const parsed = z
    .object({ projectId: z.string().uuid() })
    .strict()
    .safeParse(c.req.query());
  if (!parsed.success)
    return c.json(
      { error: "Validation error", details: parsed.error.flatten() },
      400,
    );
  if (!z.string().uuid().safeParse(c.req.param("id")).success)
    return c.json({ error: "Invalid process ID" }, 400);
  return c.json(
    await createResourceServices(c.get("identity")).agentUsageService.getUsage(
      c.get("db"),
      parsed.data.projectId,
      c.req.param("id"),
    ),
  );
});
export default routes;
