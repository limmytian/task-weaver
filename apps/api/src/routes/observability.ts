import { Hono } from "hono";
import {
  daemonHistoryQuerySchema,
  daemonObservabilityQuerySchema,
  createResourceServices,
  daemonMetricsQuerySchema,


} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const observabilityRouter = new Hono<Env>();

// GET /overview - one as-of snapshot for the operator Control Center.
observabilityRouter.get("/overview", async (c) => {
  const parsed = daemonObservabilityQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await createResourceServices(c.get("identity")).daemonObservabilityService.getDaemonObservabilityOverview(c.get("db"), parsed.data));
});

observabilityRouter.get("/history", async (c) => {
  const parsed = daemonHistoryQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await createResourceServices(c.get("identity")).daemonProgressService.listCorrelatedHistory(c.get("db"), parsed.data));
});

observabilityRouter.get("/metrics", async (c) => {
  const parsed = daemonMetricsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await createResourceServices(c.get("identity")).daemonMetricsService.getDaemonMetricsReport(c.get("db"), parsed.data));
});

observabilityRouter.get("/logs", async (c) => {
  const parsed = daemonHistoryQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  const maxChars = Number(c.req.query("maxChars") ?? 4_000);
  return c.json(await createResourceServices(c.get("identity")).daemonProgressService.listBoundedLogTail(c.get("db"), { ...parsed.data, maxChars }));
});

export default observabilityRouter;
