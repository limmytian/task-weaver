import { Hono } from "hono";
import { activityLogService } from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const activity = new Hono<Env>();

type ActivityEntityType = "project" | "task" | "document" | "requirement" | "repository" | "daemon" | "schedule" | "ti_agent_model_config" | "ti_agent_policy" | "ti_agent_run";

function parseQueryInput(query: Record<string, string>): activityLogService.ListActivityLogInput {
  return {
    projectId: query.projectId,
    entityType: query.entityType as ActivityEntityType | undefined,
    entityId: query.entityId,
    actorId: query.actorId,
    actorType: query.actorType as "human" | "agent" | undefined,
    action: query.action,
    since: query.since,
    until: query.until,
    limit: query.limit ? parseInt(query.limit, 10) : 50,
    offset: query.offset ? parseInt(query.offset, 10) : 0,
  };
}

// GET / - List activity log entries
activity.get("/", async (c) => {
  const db = c.get("db");
  const input = parseQueryInput(c.req.query());
  const results = await activityLogService.listActivityLog(db, input);
  return c.json(results);
});

// GET /export - Export activity log (CSV or JSON, no pagination limit)
activity.get("/export", async (c) => {
  const db = c.get("db");
  const query = c.req.query();
  const input = {
    projectId: query.projectId,
    entityType: query.entityType as ActivityEntityType | undefined,
    entityId: query.entityId,
    actorId: query.actorId,
    actorType: query.actorType as "human" | "agent" | undefined,
    action: query.action,
    since: query.since,
    until: query.until,
  };

  const rows = await activityLogService.exportActivityLog(db, input);
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
