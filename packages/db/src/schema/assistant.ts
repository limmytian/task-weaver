import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { activityLog } from "./activity";
import { actorTypeEnum } from "./enums";
import { tiAgentRuns } from "./ti-agent";
import { projects } from "./projects";
import { requirements } from "./requirements";
import { schedules } from "./schedules";
import { tasks } from "./tasks";

export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    requirementId: uuid("requirement_id").references(() => requirements.id, {
      onDelete: "set null",
    }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    scheduleId: uuid("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
    title: text("title"),
    contextKind: text("context_kind", {
      enum: ["global", "project", "requirement", "task", "schedule"],
    }).default("global").notNull(),
    createdBy: text("created_by").notNull(),
    createdByType: actorTypeEnum("created_by_type").notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_assistant_conversations_project").on(table.projectId),
    index("idx_assistant_conversations_requirement").on(table.requirementId),
    index("idx_assistant_conversations_task").on(table.taskId),
    index("idx_assistant_conversations_schedule").on(table.scheduleId),
    index("idx_assistant_conversations_actor").on(table.createdBy, table.createdByType),
    index("idx_assistant_conversations_last_message").on(table.lastMessageAt),
  ],
);

export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .references(() => assistantConversations.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role", {
      enum: ["user", "assistant", "system", "tool"],
    }).notNull(),
    content: text("content").notNull(),
    contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>(),
    tiAgentRunId: uuid("ti_agent_run_id").references(() => tiAgentRuns.id, {
      onDelete: "set null",
    }),
    provider: text("provider"),
    model: text("model"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdBy: text("created_by").notNull(),
    createdByType: actorTypeEnum("created_by_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_assistant_messages_conversation").on(table.conversationId),
    index("idx_assistant_messages_ti_run").on(table.tiAgentRunId),
    index("idx_assistant_messages_created").on(table.createdAt),
  ],
);

export const assistantActions = pgTable(
  "assistant_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .references(() => assistantConversations.id, { onDelete: "cascade" })
      .notNull(),
    messageId: uuid("message_id").references(() => assistantMessages.id, {
      onDelete: "set null",
    }),
    actionType: text("action_type", {
      enum: [
        "create_task",
        "update_task",
        "create_schedule",
        "pause_schedule",
        "queue_ti_run",
        "add_comment",
        "add_note",
        "draft_document",
      ],
    }).notNull(),
    status: text("status", {
      enum: ["proposed", "approved", "rejected", "executing", "succeeded", "failed", "cancelled"],
    }).default("proposed").notNull(),
    targetType: text("target_type", {
      enum: ["project", "requirement", "task", "schedule", "document", "ti_agent_run"],
    }),
    targetId: uuid("target_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    preview: text("preview"),
    approvalActorId: text("approval_actor_id"),
    approvalActorType: actorTypeEnum("approval_actor_type"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    executionResult: jsonb("execution_result").$type<Record<string, unknown>>(),
    activityLogId: uuid("activity_log_id").references(() => activityLog.id, {
      onDelete: "set null",
    }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_assistant_actions_conversation").on(table.conversationId),
    index("idx_assistant_actions_message").on(table.messageId),
    index("idx_assistant_actions_status").on(table.status),
    index("idx_assistant_actions_target").on(table.targetType, table.targetId),
  ],
);
