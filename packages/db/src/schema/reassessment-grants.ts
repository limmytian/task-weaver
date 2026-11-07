import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "./projects";
import { requirements } from "./requirements";
import { authActors } from "./auth";

export const reassessmentGrants = pgTable("reassessment_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  requirementId: uuid("requirement_id").references(() => requirements.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => authActors.id, { onDelete: "restrict" }),
  createdBy: uuid("created_by").notNull().references(() => authActors.id, { onDelete: "restrict" }),
  operations: text("operations").array().$type<('revalidate_evidence' | 'assess_interrupted_execution')[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: uuid("revoked_by").references(() => authActors.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("reassessment_grants_scope_idx").on(t.projectId, t.agentId),
  check("reassessment_grants_operations_check", sql`cardinality(${t.operations}) > 0 AND ${t.operations} <@ ARRAY['revalidate_evidence', 'assess_interrupted_execution']::text[] AND array_position(${t.operations}, NULL) IS NULL`),
  check("reassessment_grants_revocation_check", sql`(${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL)`)]);
