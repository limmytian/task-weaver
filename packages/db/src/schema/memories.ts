import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { actorTypeEnum } from "./enums";
import { projects } from "./projects";

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Optional project scope — null means global / cross-project
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    personalOwnerId: text("personal_owner_id"),
    personalOwnerType: actorTypeEnum("personal_owner_type"),
    // Memory type: user | feedback | project | reference | other
    memoryType: text("memory_type", {
      enum: ["user", "feedback", "project", "reference", "other"],
    }).notNull().default("other"),
    // Short title for quick scanning
    title: text("title").notNull(),
    // Full memory content (Markdown)
    content: text("content").notNull(),
    version: integer("version").default(1).notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>(),
    // Structured metadata (flexible key-value)
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    // Tags for filtering
    tags: text("tags").array(),
    // Optional link to a specific entity
    entityType: text("entity_type", {
      enum: ["project", "requirement", "task", "document"],
    }),
    entityId: uuid("entity_id"),
    // Actor who recorded this memory
    createdBy: text("created_by").notNull(),
    createdByType: text("created_by_type", {
      enum: ["human", "agent"],
    }).notNull(),
    // Optional expiry — null means permanent
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // search_vector managed via raw SQL migration
  },
  (table) => [
    index("idx_memories_project").on(table.projectId),
    index("idx_memories_personal_owner").on(table.personalOwnerId, table.personalOwnerType),
    index("idx_memories_type").on(table.memoryType),
    index("idx_memories_actor").on(table.createdBy),
    index("idx_memories_entity").on(table.entityType, table.entityId),
    index("idx_memories_created").on(table.createdAt),
  ],
);

// Receipts outlive a forgotten memory so an ambiguous save cannot resurrect it.
export const memoryReceipts = pgTable("memory_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: text("actor_id").notNull(),
  actorType: text("actor_type").notNull(),
  scopeKey: text("scope_key").notNull(),
  key: uuid("key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  memoryId: uuid("memory_id").references(() => memories.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [uniqueIndex("memory_receipts_identity").on(table.actorId, table.actorType, table.scopeKey, table.key)]);
