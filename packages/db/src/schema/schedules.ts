import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  actorTypeEnum,
  scheduleKindEnum,
  scheduleRecurrenceSyntaxEnum,
  scheduleRunStatusEnum,
  scheduleStatusEnum,
  scheduleTargetScopeEnum,
  scheduleCatchUpPolicyEnum,
  taskPriorityEnum,
} from "./enums";
import { projects } from "./projects";
import { requirements } from "./requirements";
import { tasks } from "./tasks";

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    requirementId: uuid("requirement_id").references(() => requirements.id, {
      onDelete: "set null",
    }),
    targetScope: scheduleTargetScopeEnum("target_scope").default("project").notNull(),
    kind: scheduleKindEnum("kind").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: scheduleStatusEnum("status").default("active").notNull(),
    timezone: text("timezone").default("UTC").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    recurrenceSyntax: scheduleRecurrenceSyntaxEnum("recurrence_syntax"),
    recurrenceRule: text("recurrence_rule"),
    catchUpPolicy: scheduleCatchUpPolicyEnum("catch_up_policy").default("latest").notNull(),
    expiryWindowMinutes: integer("expiry_window_minutes"),
    maxCatchUpRuns: integer("max_catch_up_runs"),
    taskTitle: text("task_title").notNull(),
    taskDescription: text("task_description"),
    taskPriority: taskPriorityEnum("task_priority").default("medium").notNull(),
    autoRun: boolean("auto_run").default(false).notNull(),
    assignedExecutor: text("assigned_executor"),
    assignedExecutorType: actorTypeEnum("assigned_executor_type"),
    requestedPiProvider: text("requested_pi_provider"),
    requestedPiModel: text("requested_pi_model"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_schedules_project").on(table.projectId),
    index("idx_schedules_requirement").on(table.requirementId),
    index("idx_schedules_status_next_run").on(table.status, table.nextRunAt),
    index("idx_schedules_target_scope").on(table.targetScope),
  ],
);

export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduleId: uuid("schedule_id")
      .references(() => schedules.id, { onDelete: "cascade" })
      .notNull(),
    plannedFor: timestamp("planned_for", { withTimezone: true }).notNull(),
    status: scheduleRunStatusEnum("status").default("pending").notNull(),
    generatedTaskId: uuid("generated_task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    skippedReason: text("skipped_reason"),
    errorMessage: text("error_message"),
    requestedPiProvider: text("requested_pi_provider"),
    requestedPiModel: text("requested_pi_model"),
    actualPiProvider: text("actual_pi_provider"),
    actualPiModel: text("actual_pi_model"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_schedule_runs_schedule_planned_for").on(
      table.scheduleId,
      table.plannedFor,
    ),
    uniqueIndex("idx_schedule_runs_generated_task").on(table.generatedTaskId),
    index("idx_schedule_runs_schedule").on(table.scheduleId),
    index("idx_schedule_runs_status").on(table.status),
    index("idx_schedule_runs_planned_for").on(table.plannedFor),
  ],
);
