import assert from "node:assert/strict";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { tasks, requirements, type Database } from "@task-weaver/db";

const nodeTypes = new Set(["Limit", "Sort", "Incremental Sort", "Aggregate", "Seq Scan", "Index Scan",
  "Index Only Scan", "Bitmap Heap Scan", "Bitmap Index Scan", "BitmapAnd", "BitmapOr", "Result",
  "Nested Loop", "Hash Join", "Merge Join", "Hash", "Materialize", "Memoize", "Append", "Subquery Scan"]);
const numericFields = ["Actual Rows", "Actual Loops", "Plan Rows", "Rows Removed by Filter",
  "Rows Removed by Index Recheck", "Shared Hit Blocks", "Shared Read Blocks", "Temp Read Blocks",
  "Temp Written Blocks", "Sort Space Used", "Heap Fetches"] as const;

/** Copy only allowlisted numeric fields; plans can contain SQL literals, identities and expressions. */
export function summarizePerformancePlan(input: unknown) {
  assert.ok(Array.isArray(input) && input.length === 1, "Unexpected execution plan envelope");
  const entry = input[0] as Record<string, unknown>;
  const nodes: Array<{ type: string; depth: number; counters: Partial<Record<typeof numericFields[number], number>> }> = [];
  function visit(value: unknown, depth: number) {
    assert.ok(value && typeof value === "object" && depth <= 32 && nodes.length < 128, "Execution plan exceeds bounds");
    const node = value as Record<string, unknown>;
    const counters: Partial<Record<typeof numericFields[number], number>> = {};
    for (const field of numericFields) {
      if (node[field] === undefined) continue;
      assert.ok(typeof node[field] === "number" && Number.isFinite(node[field]) && node[field] >= 0, "Invalid plan counter");
      counters[field] = node[field];
    }
    nodes.push({ type: typeof node["Node Type"] === "string" && nodeTypes.has(node["Node Type"]) ? node["Node Type"] : "Other", depth, counters });
    if (node.Plans !== undefined) {
      assert.ok(Array.isArray(node.Plans), "Invalid plan children");
      for (const child of node.Plans) visit(child, depth + 1);
    }
  }
  visit(entry.Plan, 0);
  const duration = (field: string) => {
    const value = entry[field];
    assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0, "Invalid plan duration");
    return value;
  };
  return { planningMs: duration("Planning Time"), executionMs: duration("Execution Time"), nodes };
}

/** Representative leaf plans only, after HTTP measurements, on the already verified synthetic DB. */
export async function measurePerformanceQueryPlans(db: Database, projectId: string, taskCount: number, requirementCount: number) {
  const cutoff = new Date(Date.now() - 36500 * 86_400_000).toISOString();
  const taskWhere = and(eq(tasks.scope, "project"), eq(tasks.projectId, projectId),
    sql`(${tasks.status} NOT IN ('done', 'cancelled') OR COALESCE(${tasks.completedAt}, ${tasks.updatedAt}) >= ${cutoff})`);
  const requirementWhere = and(eq(requirements.projectId, projectId),
    sql`(${requirements.status} NOT IN ('done', 'cancelled', 'archived') OR ${requirements.updatedAt} >= ${cutoff})`);
  const probes: Array<{ shape: string; query: SQL }> = [];
  for (const [position, fraction] of [["first", 0], ["middle", .5], ["last", 1]] as const) {
    const offset = (count: number) => Math.floor((Math.ceil(count / 20) - 1) * fraction) * 20;
    probes.push({ shape: `taskSummaryLeaf.${position}`, query: db.select({
      id: tasks.id, scope: tasks.scope, projectId: tasks.projectId, requirementId: tasks.requirementId,
      executionSliceId: tasks.executionSliceId, title: tasks.title, status: tasks.status, priority: tasks.priority,
      assignee: tasks.assignee, assigneeType: tasks.assigneeType, branchName: tasks.branchName,
      expectedAt: tasks.expectedAt, completedAt: tasks.completedAt, createdAt: tasks.createdAt, updatedAt: tasks.updatedAt,
    }).from(tasks).where(taskWhere).orderBy(desc(tasks.updatedAt)).limit(20).offset(offset(taskCount)).getSQL() });
    probes.push({ shape: `requirementSummaryLeaf.${position}`, query: db.select({
      id: requirements.id, projectId: requirements.projectId, title: requirements.title, status: requirements.status,
      priority: requirements.priority, modelTier: requirements.modelTier, branchName: requirements.branchName,
      createdAt: requirements.createdAt, updatedAt: requirements.updatedAt,
    }).from(requirements).where(requirementWhere).orderBy(desc(requirements.updatedAt)).limit(20).offset(offset(requirementCount)).getSQL() });
  }
  probes.push({ shape: "taskCountLeaf", query: db.select({ count: sql`count(*)::int` }).from(tasks).where(taskWhere).getSQL() },
    { shape: "requirementCountLeaf", query: db.select({ count: sql`count(*)::int` }).from(requirements).where(requirementWhere).getSQL() });
  const results = [];
  for (const { shape, query } of probes) {
    // EXPLAIN requires SQL syntax outside Drizzle's select builder; all values remain parameterized.
    const rows = await db.execute<{ "QUERY PLAN": unknown }>(sql`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${query}`);
    results.push({ shape, ...summarizePerformancePlan(rows[0]?.["QUERY PLAN"]) });
  }
  return { scope: "Representative owner-project leaf SELECT/count shapes; excludes authorization predicates, relation pruning and protocol work",
    cache: "After measured mixed load; sequential single observations, not latency percentiles", results };
}
