import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { type Database, tasks } from "@task-weaver/db";
import type { z } from "zod";
import { boardColumnsSchema, boardColumnSchema } from "@task-weaver/contracts";

type Filters = z.infer<typeof boardColumnsSchema>;
function boardWhere(projectId: string, input: Filters, authorized?: SQL) {
  const cutoff = new Date(Date.now() - input.completedWithinDays * 86_400_000);
  return and(eq(tasks.scope, "project"), eq(tasks.projectId, projectId), authorized,
    input.requirementId ? eq(tasks.requirementId, input.requirementId) : undefined,
    !input.includeTerminal ? sql`${tasks.status} NOT IN ('done','cancelled')`
      : input.completedWithinDays > 0 ? sql`(${tasks.status} NOT IN ('done','cancelled') OR COALESCE(${tasks.completedAt},${tasks.updatedAt}) >= ${cutoff.toISOString()})` : undefined);
}
function groupColumn(group: Filters["groupBy"]) {
  return group === "status" ? tasks.status : group === "priority" ? tasks.priority : tasks.assignee;
}

/** Counts cover the complete live authorized filter, independently of loaded cursor pages. */
export async function getKanbanBoardColumns(db: Database, projectId: string, input: Filters, authorized?: SQL) {
  const column = groupColumn(input.groupBy);
  const rows = await db.select({ value: sql<string | null>`${column}`, total: sql<number>`count(*)::int` })
    .from(tasks).where(boardWhere(projectId, input, authorized)).groupBy(column);
  return { total: rows.reduce((sum, row) => sum + row.total, 0), columns: rows };
}

/** Each column advances by an immutable creation-time/id key;no offset gaps after status changes. */
export async function getKanbanBoardColumn(db: Database, projectId: string, input: z.infer<typeof boardColumnSchema>, authorized?: SQL) {
  const column = groupColumn(input.groupBy);
  const where = and(boardWhere(projectId, input, authorized), input.value === null ? isNull(column) : sql`${column} = ${input.value}`);
  const cursor = input.cursor;
  const rows = await db.query.tasks.findMany({
    where: and(where, cursor ? sql`(${tasks.createdAt},${tasks.id}) > (${cursor.createdAt}::timestamptz,${cursor.id}::uuid)` : undefined),
    columns: { id: true, scope: true, projectId: true, requirementId: true, title: true, status: true,
      priority: true, assignee: true, tags: true, expectedAt: true, createdAt: true },
    extras: { cursorCreatedAt: sql<string>`to_char(${tasks.createdAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("cursor_created_at"), description: sql<string | null>`left(${tasks.description},320)`.as("description_preview") },
    with: { requirement: { columns: { id: true, projectId: true, title: true, status: true } },
      repositories: { with: { repository: true } } },
    orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    limit: input.pageSize + 1,
  });
  const hasMore = rows.length > input.pageSize;
  const items = rows.slice(0, input.pageSize);
  const last = items.at(-1);
  return { items: items.map(({ cursorCreatedAt: _cursorCreatedAt, ...row }) => ({ ...row, requirementTitle: row.requirement?.title ?? "", requirementStatus: row.requirement?.status ?? null })),
    nextCursor: hasMore && last ? { createdAt: last.cursorCreatedAt, id: last.id } : null };
}
