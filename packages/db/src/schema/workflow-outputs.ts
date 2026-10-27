import { bigint, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actorTypeEnum } from "./enums";
import { requirements, executionSlices } from "./requirements";
import { tasks } from "./tasks";
import { documentFileVersions } from "./documents";
import { requirementRepositories } from "./repositories";

export const workflowOutputs = pgTable("workflow_outputs", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: uuid("requirement_id").references(() => requirements.id, { onDelete: "cascade" }).notNull(),
  planRevision: integer("plan_revision").default(0).notNull(),
  workflowRevision: integer("workflow_revision").default(1).notNull(),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  executionSliceId: uuid("execution_slice_id").references(() => executionSlices.id, { onDelete: "set null" }),
  requirementRepositoryId: uuid("requirement_repository_id").references(() => requirementRepositories.id, { onDelete: "set null" }),
  type: text("type", { enum: ["comment", "attachment", "url", "local", "git_branch", "git_pr"] }).notNull(),
  referenceId: uuid("reference_id"),
  attachmentFileVersionId: uuid("attachment_file_version_id").references(() => documentFileVersions.id, { onDelete: "restrict" }),
  url: text("url"),
  nodeId: text("node_id"),
  relativePath: text("relative_path"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  sha256: text("sha256"),
  nodePublicKey: text("node_public_key"),
  headCommit: text("head_commit"),
  summary: text("summary"),
  availability: text("availability", { enum: ["available", "missing", "changed", "retired"] }).default("available").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  retainUntil: timestamp("retain_until", { withTimezone: true }),
  createdBy: text("created_by").notNull(),
  createdByType: actorTypeEnum("created_by_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_workflow_outputs_requirement").on(table.requirementId, table.createdAt),
  index("idx_workflow_outputs_node").on(table.nodeId),
]);

export const workflowInputs = pgTable("workflow_inputs", {
  id: uuid("id").primaryKey().defaultRandom(),
  outputId: uuid("output_id").references(() => workflowOutputs.id, { onDelete: "restrict" }).notNull(),
  requirementId: uuid("requirement_id").references(() => requirements.id, { onDelete: "cascade" }).notNull(),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  executionSliceId: uuid("execution_slice_id").references(() => executionSlices.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("idx_workflow_inputs_requirement").on(table.requirementId), index("idx_workflow_inputs_output").on(table.outputId)]);
