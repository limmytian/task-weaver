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
type UsageModelSnapshot = {
  version: 1; capturedAt: string; configurationId: string; configurationUpdatedAt: string;
  displayName: string | null; provider: string; configuredModel: string;
  generation: { temperature?: number; maxTokens?: number };
};
import { projects } from "./projects";
import { requirements } from "./requirements";
import { tasks } from "./tasks";
import { daemons } from "./daemons";
import { tiAgentRuns } from "./ti-agent";

/** Legacy rows represent processes; Chat rows represent individual real invocations. */
export const agentUsageRuns = pgTable(
  "agent_usage_runs",
  {
    processId: uuid("process_id").primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" }),
    requirementId: uuid("requirement_id")
      .references(() => requirements.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    daemonId: uuid("daemon_id").references(() => daemons.id, {
      onDelete: "set null",
    }),
    tiRunId: uuid("ti_run_id").references(() => tiAgentRuns.id, {
      onDelete: "set null",
    }),
    personalOwnerId: text("personal_owner_id"),
    personalOwnerType: text("personal_owner_type", { enum: ["human", "agent"] }),
    conversationId: uuid("conversation_id"),
    messageId: uuid("message_id"),
    operationIds: jsonb("operation_ids").$type<string[]>(),
    modelSnapshot: jsonb("model_snapshot").$type<UsageModelSnapshot>(),
    attempt: integer("attempt"),
    leaseRunId: uuid("lease_run_id"),
    leaseGeneration: integer("lease_generation"),
    workerIndex: text("worker_index"),
    source: text("source", {
      enum: ["codex_jsonl", "daemon_unknown", "ti_runtime", "ti_chat", "ti_operation"],
    }).notNull(),
    agent: text("agent").notNull(),
    phase: text("phase", { enum: ["execution", "review", "rework", "integration"] }).notNull(),
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
    index("idx_agent_usage_ti_attempt").on(t.tiRunId, t.attempt),
  ],
);
