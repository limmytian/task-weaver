import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { actorTypeEnum, daemonRoleEnum } from "./enums";
import { executionSlices, requirements } from "./requirements";
import { tasks } from "./tasks";

export const daemons = pgTable(
  "daemons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    role: daemonRoleEnum("role").default("executor").notNull(),
    actorId: text("actor_id"),
    actorType: actorTypeEnum("actor_type"),
    host: text("host"),
    processStartedAt: timestamp("process_started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    workerCapacity: integer("worker_capacity").default(1).notNull(),
    status: text("status").default("idle").notNull(), // "idle" | "busy" | "offline"
    controlState: text("control_state", {
      enum: ["running", "paused", "draining", "drained"],
    }).default("running").notNull(),
    controlReason: text("control_reason"),
    controlRequestedAt: timestamp("control_requested_at", { withTimezone: true }),
    controlRequestedBy: text("control_requested_by"),
    controlRequestedByType: actorTypeEnum("control_requested_by_type"),
    capabilities: text("capabilities").array(), // e.g. ["claude", "agy", "aider"]
    activeTaskIds: uuid("active_task_ids").array().default([]).notNull(),
    activeWorkerStates: jsonb("active_worker_states").default([]).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_daemons_status").on(table.status),
    index("idx_daemons_role").on(table.role),
    index("idx_daemons_actor").on(table.actorId),
    index("idx_daemons_last_heartbeat").on(table.lastHeartbeatAt),
  ],
);

export const daemonWorkerProgress = pgTable(
  "daemon_worker_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    daemonId: uuid("daemon_id")
      .references(() => daemons.id, { onDelete: "cascade" })
      .notNull(),
    runId: uuid("run_id").notNull(),
    workerIndex: integer("worker_index").notNull(),
    role: daemonRoleEnum("role").notNull(),
    requirementId: uuid("requirement_id")
      .references(() => requirements.id, { onDelete: "cascade" })
      .notNull(),
    executionSliceId: uuid("execution_slice_id")
      .references(() => executionSlices.id, { onDelete: "set null" }),
    currentTaskId: uuid("current_task_id")
      .references(() => tasks.id, { onDelete: "set null" }),
    phase: text("phase").notNull(),
    message: text("message"),
    workspaceState: text("workspace_state").default("unknown").notNull(),
    recoveryDisposition: text("recovery_disposition").default("none").notNull(),
    retryCount: integer("retry_count").default(0).notNull(),
    lastCompletedTaskId: uuid("last_completed_task_id")
      .references(() => tasks.id, { onDelete: "set null" }),
    pendingDiffSummary: text("pending_diff_summary"),
    sliceSummary: text("slice_summary"),
    handoffSummary: text("handoff_summary"),
    leaseGeneration: integer("lease_generation").notNull(),
    version: integer("version").default(1).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_daemon_worker_progress_worker_unique").on(table.daemonId, table.workerIndex),
    index("idx_daemon_worker_progress_requirement").on(table.requirementId, table.updatedAt),
    index("idx_daemon_worker_progress_run").on(table.runId, table.version),
  ],
);

export const daemonWorkerProgressHistory = pgTable(
  "daemon_worker_progress_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    daemonId: uuid("daemon_id").notNull(),
    runId: uuid("run_id").notNull(),
    workerIndex: integer("worker_index").notNull(),
    role: daemonRoleEnum("role").notNull(),
    requirementId: uuid("requirement_id").notNull(),
    executionSliceId: uuid("execution_slice_id"),
    currentTaskId: uuid("current_task_id"),
    phase: text("phase").notNull(),
    message: text("message"),
    workspaceState: text("workspace_state").default("unknown").notNull(),
    recoveryDisposition: text("recovery_disposition").default("none").notNull(),
    retryCount: integer("retry_count").default(0).notNull(),
    lastCompletedTaskId: uuid("last_completed_task_id"),
    pendingDiffSummary: text("pending_diff_summary"),
    sliceSummary: text("slice_summary"),
    handoffSummary: text("handoff_summary"),
    source: text("source").notNull(),
    leaseGeneration: integer("lease_generation").notNull(),
    version: integer("version").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_daemon_worker_progress_history_run").on(table.runId, table.version),
    index("idx_daemon_worker_progress_history_requirement").on(table.requirementId, table.occurredAt),
    index("idx_daemon_worker_progress_history_task").on(table.currentTaskId, table.occurredAt),
  ],
);
