import { and, eq, desc, sql, gte, lte, type SQL } from "drizzle-orm";
import { type Database, activityLog } from "@task-weaver/db";

export interface ListActivityLogInput {
  projectId?: string;
  entityType?: "project" | "task" | "document" | "requirement" | "repository" | "daemon" | "schedule" | "ti_agent_model_config" | "ti_agent_policy" | "ti_agent_run" | "assistant_conversation" | "assistant_message" | "assistant_action";
  entityId?: string;
  actorId?: string;
  actorType?: "human" | "agent";
  action?: string;
  since?: string; // ISO 8601
  until?: string; // ISO 8601
  limit?: number;
  offset?: number;
}

function buildConditions(input: ListActivityLogInput) {
  const conditions = [];

  if (input.projectId) {
    conditions.push(
      sql`(
        (${activityLog.entityType} = 'project' AND ${activityLog.entityId} = ${input.projectId})
        OR (${activityLog.entityType} = 'task' AND ${activityLog.entityId} IN (SELECT id FROM tasks WHERE project_id = ${input.projectId}))
        OR (${activityLog.entityType} = 'requirement' AND ${activityLog.entityId} IN (SELECT id FROM requirements WHERE project_id = ${input.projectId}))
        OR (${activityLog.entityType} = 'repository' AND ${activityLog.entityId} IN (
          SELECT DISTINCT rr.repository_id
          FROM requirement_repositories rr
          JOIN requirements r ON r.id = rr.requirement_id
          WHERE r.project_id = ${input.projectId}
        ))
        OR (${activityLog.entityType} = 'document' AND ${activityLog.entityId} IN (SELECT id FROM documents WHERE project_id = ${input.projectId}))
      )`,
    );
  }

  if (input.entityType) {
    conditions.push(eq(activityLog.entityType, input.entityType));
  }
  if (input.entityId) {
    conditions.push(eq(activityLog.entityId, input.entityId));
  }
  if (input.actorId) {
    conditions.push(eq(activityLog.actorId, input.actorId));
  }
  if (input.actorType) {
    conditions.push(eq(activityLog.actorType, input.actorType));
  }
  if (input.action) {
    conditions.push(eq(activityLog.action, input.action));
  }
  if (input.since) {
    conditions.push(gte(activityLog.createdAt, new Date(input.since)));
  }
  if (input.until) {
    conditions.push(lte(activityLog.createdAt, new Date(input.until)));
  }

  return conditions;
}

export async function listActivityLog(
  db: Database,
  input: ListActivityLogInput,
  visibility?: SQL,
) {
  const conditions = [...buildConditions(input), visibility];
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;

  return db
    .select()
    .from(activityLog)
    .where(and(...conditions))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function exportActivityLog(
  db: Database,
  input: Omit<ListActivityLogInput, "limit" | "offset">,
  visibility?: SQL,
) {
  const conditions = [...buildConditions(input), visibility];

  return db
    .select()
    .from(activityLog)
    .where(and(...conditions))
    .orderBy(desc(activityLog.createdAt));
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function activityLogToCsv(
  rows: { id: string; entityType: string; entityId: string; action: string; actorId: string; actorType: string; metadata: unknown; createdAt: Date }[],
): string {
  const header = "id,entity_type,entity_id,action,actor_id,actor_type,metadata,created_at";
  const lines = rows.map((r) => {
    const meta = r.metadata ? JSON.stringify(r.metadata) : "";
    return [
      r.id,
      r.entityType,
      r.entityId,
      r.action,
      r.actorId,
      r.actorType,
      escapeCsvField(meta),
      r.createdAt.toISOString(),
    ].join(",");
  });
  return [header, ...lines].join("\n");
}
