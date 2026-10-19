import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

export const mcpInvocationAudits = pgTable("mcp_invocation_audits", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").notNull(),
  credentialId: uuid("credential_id").notNull(),
  scopeKey: text("scope_key").notNull(),
  serverId: text("server_id").notNull(),
  toolId: text("tool_id").notNull(),
  outcome: text("outcome").notNull(),
  errorCode: text("error_code"),
  durationMs: integer("duration_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [index("mcp_invocation_audits_scope_time").on(table.scopeKey, table.createdAt)]);

export const mcpInvocationPolicies = pgTable("mcp_invocation_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  scopeKey: text("scope_key").notNull(),
  toolId: text("tool_id").notNull(),
  mode: text("mode", { enum: ["allow", "approval", "deny"] }).notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [uniqueIndex("mcp_invocation_policies_scope_tool").on(table.scopeKey, table.toolId)]);

/** Only digests and binding metadata are retained; execution arguments never persist here. */
export const mcpInvocationApprovals = pgTable("mcp_invocation_approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").notNull(),
  credentialId: uuid("credential_id").notNull(),
  scopeKey: text("scope_key").notNull(),
  toolId: text("tool_id").notNull(),
  operationHash: text("operation_hash").notNull(),
  authorityHash: text("authority_hash").notNull(),
  policyVersions: jsonb("policy_versions").$type<string[]>().notNull(),
  approvedBy: uuid("approved_by"),
  approvedCredentialId: uuid("approved_credential_id"),
  approvedCredentialKind: text("approved_credential_kind"),
  usedAt: timestamp("used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [index("mcp_invocation_approvals_expiry").on(table.expiresAt)]);
