import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";
import { requirements } from "./requirements";
import { tasks } from "./tasks";
import { daemons } from "./daemons";
import { piAgentRuns } from "./pi-agent";

/** One row per process, never one row per model call or usage event. */
export const agentUsageRuns = pgTable(
  "agent_usage_runs",
  {
    processId: uuid("process_id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requirementId: uuid("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    daemonId: uuid("daemon_id").references(() => daemons.id, {
      onDelete: "set null",
    }),
    piRunId: uuid("pi_run_id").references(() => piAgentRuns.id, {
      onDelete: "set null",
    }),
    attempt: integer("attempt"),
    source: text("source", {
      enum: ["codex_jsonl", "daemon_unknown", "ti_runtime"],
    }).notNull(),
    agent: text("agent").notNull(),
    phase: text("phase", { enum: ["execution", "review", "rework"] }).notNull(),
    outcome: text("outcome", {
      enum: ["running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    summary: jsonb("summary")
      .$type<{
        inputTokens: number | null;
        outputTokens: number | null;
        cacheReadTokens: number | null;
        cacheWriteTokens: number | null;
        cacheSemantics: "included" | "additional" | "unknown";
        provider: string;
        model: string;
        completeness: "complete" | "partial" | "unknown";
      }>()
      .notNull(),
    reportedBy: text("reported_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("idx_agent_usage_project_time").on(t.projectId, t.startedAt),
    index("idx_agent_usage_requirement").on(t.requirementId),
    index("idx_agent_usage_task").on(t.taskId),
    index("idx_agent_usage_pi_attempt").on(t.piRunId, t.attempt),
  ],
);
