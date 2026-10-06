import { Hono } from "hono";
import { createResourceServices, activityQuerySchema, activityLogService } from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const activity = new Hono<Env>();

// GET / - List activity log entries
activity.get("/", async (c) => {
  const db = c.get("db");
  const parsed = activityQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid activity query" }, 400);
  const input = parsed.data;
  const results = await createResourceServices(c.get("identity")).activityLogService.listActivityLog(db, input);
  return c.json(results);
});

// GET /export - Export activity log (CSV or JSON, no pagination limit)
activity.get("/export", async (c) => {
  const db = c.get("db");
  const query = c.req.query();
  const parsed = activityQuerySchema.safeParse(query);
  if (!parsed.success) return c.json({ error: "Invalid activity query" }, 400);
  const input = parsed.data;

  const rows = await createResourceServices(c.get("identity")).activityLogService.exportActivityLog(db, input);
  const format = query.format ?? "csv";

  if (format === "json") {
    return c.json(rows);
  }

  const csv = activityLogService.activityLogToCsv(rows as any);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="activity-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});

export default activity;
