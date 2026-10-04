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
import { actorTypeEnum, taskPriorityEnum, taskScopeEnum, taskStatusEnum } from "./enums";
import { projects } from "./projects";
import { executionSlices, requirements } from "./requirements";

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: taskScopeEnum("scope").default("project").notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" }),
    requirementId: uuid("requirement_id")
      .references(() => requirements.id, { onDelete: "cascade" }),
    personalOwnerId: text("personal_owner_id"),
    personalOwnerType: actorTypeEnum("personal_owner_type"),
    executionSliceId: uuid("execution_slice_id")
      .references(() => executionSlices.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatusEnum("status").default("todo").notNull(),
    priority: taskPriorityEnum("priority").default("medium").notNull(),
    assignee: text("assignee"),
    assigneeType: actorTypeEnum("assignee_type"),
    requestedProvider: text("requested_provider"),
    requestedModel: text("requested_model"),
    tags: text("tags").array(),
    branchName: text("branch_name"),
    expectedAt: timestamp("expected_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    version: integer("version").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_tasks_project").on(table.projectId),
    index("idx_tasks_scope").on(table.scope),
    index("idx_tasks_personal_owner").on(table.personalOwnerId, table.personalOwnerType),
    index("idx_tasks_status").on(table.status),
    index("idx_tasks_assignee").on(table.assignee),
    index("idx_tasks_requirement").on(table.requirementId),
    index("idx_tasks_execution_slice").on(table.executionSliceId),
  ],
);

export const taskClaims = pgTable(
  "task_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    claimedBy: text("claimed_by").notNull(),
    claimedByType: actorTypeEnum("claimed_by_type").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_claims_task_unique").on(table.taskId),
    index("idx_claims_claimed_by").on(table.claimedBy),
    index("idx_claims_expires").on(table.expiresAt),
  ],
);

export const taskStatusLog = pgTable(
  "task_status_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    fromStatus: taskStatusEnum("from_status"),
    toStatus: taskStatusEnum("to_status").notNull(),
    changedBy: text("changed_by").notNull(),
    changedByType: actorTypeEnum("changed_by_type").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_status_log_task").on(table.taskId)],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    dependsOnTaskId: uuid("depends_on_task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    type: text("type", { enum: ["blocks", "related"] })
      .default("blocks")
      .notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_deps_task").on(table.taskId),
    index("idx_deps_depends_on").on(table.dependsOnTaskId),
  ],
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    content: text("content").notNull(),
    authorId: text("author_id").notNull(),
    authorType: actorTypeEnum("author_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_comments_task").on(table.taskId)],
);

export const taskNotes = pgTable(
  "task_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    content: text("content").notNull(),
    authorId: text("author_id").notNull(),
    authorType: actorTypeEnum("author_type").notNull(),
    pinned: boolean("pinned").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_notes_task").on(table.taskId)],
);
