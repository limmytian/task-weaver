import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "./projects";
import { actorTypeEnum } from "./enums";

export const pluginInstallations = pgTable("plugin_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  personalOwnerId: text("personal_owner_id"), personalOwnerType: actorTypeEnum("personal_owner_type"),
  createdBy: text("created_by").notNull(),
  pluginId: text("plugin_id").notNull(),
  revision: integer("revision").notNull().default(1),
  status: text("status", { enum: ["active", "disabled", "uninstalled"] }).notNull().default("disabled"),
  manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
  manifestHash: text("manifest_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("plugin_installations_project").on(table.projectId)]);

// A deleted value retains its version until explicit purge, preventing delete/recreate ABA.
export const pluginStorage = pgTable("plugin_storage", {
  installationId: uuid("installation_id").notNull().references(() => pluginInstallations.id, { onDelete: "cascade" }),
  key: text("key").notNull(), version: integer("version").notNull(),
  value: jsonb("value").$type<unknown>(),
  deleted: integer("deleted").notNull().default(0),
}, table => [primaryKey({ columns: [table.installationId, table.key] })]);

// Installation rows are tombstones on uninstall; receipts cannot resurrect purged data.
export const pluginInvocationReceipts = pgTable("plugin_invocation_receipts", {
  installationId: uuid("installation_id").notNull().references(() => pluginInstallations.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull(), key: uuid("key").notNull(),
  payloadHash: text("payload_hash").notNull(), revision: integer("revision").notNull(),
  result: jsonb("result").$type<unknown>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.installationId, table.actorId, table.key] })]);
