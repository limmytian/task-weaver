import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projects } from "./projects";
import { apiKeys } from "./api-keys";

/** Retained for the credential lifetime so delayed retries cannot duplicate writes. */
export const mcpPlanReceipts = pgTable("mcp_plan_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  credentialId: uuid("credential_id").notNull().references(() => apiKeys.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  idempotencyKey: uuid("idempotency_key").notNull(),
  planHash: text("plan_hash").notNull(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [uniqueIndex("mcp_plan_receipts_credential_project_key").on(table.credentialId, table.projectId, table.idempotencyKey)]);
