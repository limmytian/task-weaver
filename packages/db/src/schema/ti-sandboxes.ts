import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { actorTypeEnum } from "./enums";

/** Ownership tombstones survive deletion of conversations, runs and accounts until reclamation is confirmed. */
export const tiSandboxWorkspaces = pgTable("ti_sandbox_workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  ownerType: actorTypeEnum("owner_type").notNull(),
  projectId: uuid("project_id"),
  conversationId: uuid("conversation_id"),
  runId: uuid("run_id"),
  attempt: integer("attempt").notNull(),
  bindingId: text("binding_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  providerProjectId: text("provider_project_id").notNull(),
  sessionRequestId: uuid("session_request_id").notNull().defaultRandom(),
  sessionId: text("session_id"),
  state: text("state", { enum: ["provisioning", "active", "cleanup_pending", "deleted", "uncertain"] }).notNull().default("provisioning"),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  cleanupRequestedAt: timestamp("cleanup_requested_at", { withTimezone: true }),
  cleanupAttempts: integer("cleanup_attempts").notNull().default(0),
  nextCleanupAt: timestamp("next_cleanup_at", { withTimezone: true }),
  cleanupLeaseId: uuid("cleanup_lease_id"),
  cleanupLeaseExpiresAt: timestamp("cleanup_lease_expires_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("ti_sandbox_context", sql`(${table.conversationId} IS NOT NULL)::int + (${table.runId} IS NOT NULL)::int = 1 AND ${table.attempt} >= 1`),
  uniqueIndex("ti_sandbox_conversation_attempt").on(table.ownerId, table.ownerType, table.conversationId, table.attempt),
  uniqueIndex("ti_sandbox_run_attempt").on(table.runId, table.attempt),
  uniqueIndex("ti_sandbox_provider_session").on(table.bindingId, table.sessionId),
  index("ti_sandbox_cleanup_due").on(table.state, table.nextCleanupAt),
  index("ti_sandbox_owner").on(table.ownerId, table.ownerType, table.state),
]);

export const tiSandboxOperations = pgTable("ti_sandbox_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => tiSandboxWorkspaces.id),
  logicalKey: text("logical_key").notNull(),
  requestId: uuid("request_id").notNull().defaultRandom(),
  tool: text("tool", { enum: ["bash_exec", "file_ops"] }).notNull(),
  arguments: jsonb("arguments").$type<Record<string, unknown>>().notNull(),
  argumentHash: text("argument_hash").notNull(),
  jobId: text("job_id"),
  state: text("state", { enum: ["pending", "accepted", "terminal", "uncertain"] }).notNull().default("pending"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("ti_sandbox_operation_key").on(table.workspaceId, table.logicalKey),
  uniqueIndex("ti_sandbox_operation_request").on(table.requestId),
  uniqueIndex("ti_sandbox_operation_job").on(table.workspaceId, table.jobId),
]);
