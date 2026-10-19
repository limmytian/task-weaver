import { pgTable, uuid, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { apiKeys } from "./api-keys";
import { projects } from "./projects";

/** Provenance for the narrow exception to an ancestor credential ceiling. */
export const apiKeyProjectCreations = pgTable("api_key_project_creations", {
  keyId: uuid("key_id").notNull().references(() => apiKeys.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [primaryKey({ columns: [table.keyId, table.projectId] })]);
