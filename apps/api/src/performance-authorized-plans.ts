import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Database } from "@task-weaver/db";
import { summarizePerformancePlan } from "./performance-query-plans";

/** Structural labels only; query text and bindings never enter a receipt or retained plan. */
export function performancePlanShape(text: string): string | undefined {
  if (/for\s+(update|share|no key update|key share)/i.test(text)) return;
  if (/jsonb_agg\(/.test(text)) return "healthTasks";
  if (/group by "requirements"\."id"/.test(text)) return "healthCoverage";
  if (/^select count\(\*\).*from "activity_log"/s.test(text)) return "healthActivity";
  for (const table of ["tasks", "requirements"]) {
    if (text.startsWith(`select count(*)::int from "${table}"`)) return `${table}Count`;
    if (text.includes(`order by "${table}"."updated_at"`) && / limit /.test(text)) return `${table}Page`;
  }
}

/** Local-only adapter: execute EXPLAIN on the actual builder in its original authorized transaction. */
export function authorizedPerformancePlans(db: Database) {
  const plans: Array<{ shape: string; plan: ReturnType<typeof summarizePerformancePlan> }> = [];
  let enabled = false;
  // Drizzle's select and relational builders have different private types; preserve their methods at runtime.
  function builder(target: any, connection: Database): any {
    return new Proxy(target, { get(object, property) {
      if (property === "then") return (resolve: any, reject: any) => (async () => {
        if (enabled) {
          const shape = performancePlanShape(object.toSQL().sql);
          if (shape) {
            assert.ok(plans.length < 64, "Authorized plan count ceiling reached");
            // EXPLAIN requires syntax outside Drizzle's select API; parameterized AST stays local to execution.
            const result = await connection.execute<{ "QUERY PLAN": unknown }>(sql`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${object.getSQL()}`);
            plans.push({ shape, plan: summarizePerformancePlan(result[0]?.["QUERY PLAN"]) });
          }
        }
        return await object;
      })().then(resolve, reject);
      const value = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      return (...args: any[]) => {
        const next = value.apply(object, args);
        return next && typeof next === "object" && (typeof next.from === "function" || typeof next.then === "function" && typeof next.getSQL === "function")
          ? builder(next, connection) : next;
      };
    } });
  }
  function connection(target: Database): Database {
    return new Proxy(target, { get(object, property) {
      if (property === "$client") return object.$client;
      if (property === "transaction") return (work: (tx: Database) => Promise<unknown>, ...args: any[]) =>
        (object.transaction as any)((tx: Database) => work(connection(tx)), ...args);
      if (property === "select") return (...args: any[]) => builder((object.select as any)(...args), object);
      if (property === "query") return new Proxy(object.query, { get(tables: any, table) {
        return new Proxy(tables[table], { get(query, method) {
          const value = query[method];
          return typeof value === "function" ? (...args: any[]) => builder(value.apply(query, args), object) : value;
        } });
      } });
      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    } });
  }
  return { db: connection(db), async capture<T>(work: () => Promise<T>) {
    assert.ok(!enabled, "Overlapping plan captures are unsupported"); plans.length = 0; enabled = true;
    try { const value = await work(); return { value, plans: [...plans] }; }
    finally { enabled = false; plans.length = 0; }
  } };
}
