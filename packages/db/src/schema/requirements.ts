import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import {
  actorTypeEnum,
  executionSliceStatusEnum,
  modelTierEnum,
  requirementPriorityEnum,
  requirementStatusEnum,
} from "./enums";
import { projects } from "./projects";

export const requirements = pgTable(
  "requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: requirementStatusEnum("status").default("draft").notNull(),
    priority: requirementPriorityEnum("priority").default("medium").notNull(),
    modelTier: modelTierEnum("model_tier").default("standard").notNull(),
    tags: text("tags").array(),
    branchName: text("branch_name"),
    leaseGeneration: integer("lease_generation").default(0).notNull(),
    expectedAt: timestamp("expected_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_requirements_project").on(table.projectId),
    index("idx_requirements_status").on(table.status),
  ],
);

export const executionSlices = pgTable(
  "execution_slices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requirementId: uuid("requirement_id")
      .references(() => requirements.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    description: text("description"),
    orderIndex: integer("order_index").default(0).notNull(),
    allowParallel: boolean("allow_parallel").default(false).notNull(),
    modelTier: modelTierEnum("model_tier").default("standard").notNull(),
    status: executionSliceStatusEnum("status").default("todo").notNull(),
    resultSummary: text("result_summary"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_execution_slices_requirement").on(table.requirementId),
    index("idx_execution_slices_status").on(table.status),
    uniqueIndex("idx_execution_slices_requirement_order").on(table.requirementId, table.orderIndex),
  ],
);

export const requirementClaims = pgTable(
  "requirement_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requirementId: uuid("requirement_id")
      .references(() => requirements.id, { onDelete: "cascade" })
      .notNull(),
    claimedBy: text("claimed_by").notNull(),
    claimedByType: actorTypeEnum("claimed_by_type").notNull(),
    daemonId: uuid("daemon_id"),
    workerIndex: text("worker_index"),
    generation: integer("generation").default(1).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_requirement_claims_requirement_unique").on(table.requirementId),
    index("idx_requirement_claims_claimed_by").on(table.claimedBy),
    index("idx_requirement_claims_expires").on(table.expiresAt),
    index("idx_requirement_claims_daemon").on(table.daemonId),
  ],
);

export const requirementDependencies = pgTable(
  "requirement_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requirementId: uuid("requirement_id")
      .references(() => requirements.id, { onDelete: "cascade" })
      .notNull(),
    dependsOnRequirementId: uuid("depends_on_requirement_id")
      .references(() => requirements.id, { onDelete: "cascade" })
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
    uniqueIndex("idx_requirement_deps_unique").on(
      table.requirementId,
      table.dependsOnRequirementId,
      table.type,
    ),
    index("idx_requirement_deps_requirement").on(table.requirementId),
    index("idx_requirement_deps_depends_on").on(table.dependsOnRequirementId),
  ],
);
