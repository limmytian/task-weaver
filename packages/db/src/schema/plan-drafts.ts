import { index, uniqueIndex, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "./projects";
import { actorTypeEnum } from "./enums";

export const planDrafts = pgTable("plan_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull(),
  createdByType: actorTypeEnum("created_by_type").notNull(),
  source: text("source").notNull(),
  revision: integer("revision").notNull().default(1),
  state: text("state").notNull().default("draft"),
  validatedRevision: integer("validated_revision"),
  liveFingerprint: text("live_fingerprint"),
  operationKey: uuid("operation_key"),
  receipt: jsonb("receipt").$type<Record<string, unknown>>(),
  plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, table => [index("plan_drafts_project_updated").on(table.projectId, table.updatedAt), uniqueIndex("plan_drafts_project_operation").on(table.projectId, table.operationKey)]);
