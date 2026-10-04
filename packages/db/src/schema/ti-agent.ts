import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { actorTypeEnum } from "./enums";
import { scheduleRuns } from "./schedules";
import { tasks } from "./tasks";

export const tiAgentModelConfigs = pgTable(
  "ti_agent_model_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    ownerType: actorTypeEnum("owner_type").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    baseUrl: text("base_url"),
    label: text("label"),
    apiKeyRef: text("api_key_ref"),
    credentialStatus: text("credential_status", {
      enum: ["unknown", "valid", "invalid", "missing"],
    }).default("unknown").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    isDefaultChat: boolean("is_default_chat").default(false).notNull(),
    isDefaultAgent: boolean("is_default_agent").default(false).notNull(),
    capabilities: text("capabilities").array(),
    costMetadata: jsonb("cost_metadata").$type<Record<string, unknown>>(),
    availabilityCheckedAt: timestamp("availability_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_ti_model_configs_owner_provider_model").on(
      table.ownerId,
      table.ownerType,
      table.provider,
      table.model,
    ),
    index("idx_ti_model_configs_owner").on(table.ownerId, table.ownerType),
    index("idx_ti_model_configs_enabled").on(table.enabled),
  ],
);

export const tiAgentRuns = pgTable(
  "ti_agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    scheduleRunId: uuid("schedule_run_id").references(() => scheduleRuns.id, {
      onDelete: "set null",
    }),
    assignedAgentId: text("assigned_agent_id").default("task-weaver:ti-agent").notNull(),
    assignedAgentType: actorTypeEnum("assigned_agent_type").default("agent").notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "in_review", "cancelled"],
    }).default("queued").notNull(),
    leaseOwnerId: text("lease_owner_id"),
    leaseOwnerType: actorTypeEnum("lease_owner_type"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    requestedProvider: text("requested_provider"),
    requestedModel: text("requested_model"),
    actualProvider: text("actual_provider"),
    actualModel: text("actual_model"),
    fallbackReason: text("fallback_reason"),
    sandboxSessionId: text("sandbox_session_id"),
    workspacePolicy: text("workspace_policy", {
      enum: ["ephemeral", "persistent_purged_on_finish"],
    }).default("ephemeral").notNull(),
    eventLog: jsonb("event_log").$type<unknown[]>(),
    outputSummary: text("output_summary"),
    errorMessage: text("error_message"),
    tokenUsageId: uuid("token_usage_id"),
    retryCount: integer("retry_count").default(0).notNull(),
    maxRetries: integer("max_retries").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    costMetadata: jsonb("cost_metadata").$type<Record<string, unknown>>(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_ti_agent_runs_task").on(table.taskId),
    index("idx_ti_agent_runs_schedule_run").on(table.scheduleRunId),
    index("idx_ti_agent_runs_assigned").on(table.assignedAgentId, table.assignedAgentType),
    index("idx_ti_agent_runs_status").on(table.status),
    index("idx_ti_agent_runs_lease").on(table.leaseExpiresAt),
    index("idx_ti_agent_runs_retry").on(table.status, table.nextAttemptAt),
  ],
);

export const tiAgentPolicies = pgTable(
  "ti_agent_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    ownerType: actorTypeEnum("owner_type").notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    executionMode: text("execution_mode", {
      enum: ["disabled", "dry_run", "live"],
    }).default("disabled").notNull(),
    maxConcurrentRuns: integer("max_concurrent_runs").default(1).notNull(),
    dailyRunLimit: integer("daily_run_limit").default(25).notNull(),
    monthlyRunLimit: integer("monthly_run_limit").default(500).notNull(),
    runTimeoutSeconds: integer("run_timeout_seconds").default(600).notNull(),
    defaultMaxRetries: integer("default_max_retries").default(0).notNull(),
    sandboxTemplate: text("sandbox_template"),
    allowNetwork: boolean("allow_network").default(false).notNull(),
    allowedTools: text("allowed_tools").array(),
    deniedTools: text("denied_tools").array(),
    assistantAutoEnabled: boolean("assistant_auto_enabled").default(false).notNull(),
    assistantAutoMode: text("assistant_auto_mode", {
      enum: ["disabled", "dry_run", "live"],
    }).default("disabled").notNull(),
    assistantActionAllowlist: text("assistant_action_allowlist").array(),
    assistantDailyActionLimit: integer("assistant_daily_action_limit").default(10).notNull(),
    assistantRunTimeoutSeconds: integer("assistant_run_timeout_seconds").default(300).notNull(),
    assistantDefaultMaxRetries: integer("assistant_default_max_retries").default(0).notNull(),
    assistantUncertainToReview: boolean("assistant_uncertain_to_review").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_ti_agent_policies_owner").on(table.ownerId, table.ownerType),
    index("idx_ti_agent_policies_enabled").on(table.enabled),
  ],
);
