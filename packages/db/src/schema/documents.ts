import { boolean, index, integer, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
// `version` column enables optimistic concurrency control for multi-agent editing
import { actorTypeEnum } from "./enums";
import { projects } from "./projects";
import { requirements } from "./requirements";
import { tasks } from "./tasks";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    personalOwnerId: text("personal_owner_id"),
    personalOwnerType: actorTypeEnum("personal_owner_type"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    tags: text("tags").array(),
    summary: text("summary"),
    keywords: text("keywords").array(),
    docType: text("doc_type", {
      enum: ["requirement", "design", "meeting", "guide", "reference", "skill", "other"],
    }).default("other").notNull(),
    language: text("language").default("en").notNull(),
    readingTimeMin: integer("reading_time_min"),
    generatedBy: text("generated_by"),
    generationPrompt: text("generation_prompt"),
    confidence: real("confidence"),
    needsReview: boolean("needs_review").default(false).notNull(),
    version: integer("version").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // search_vector and embedding columns are managed via raw SQL migration
    // since tsvector and vector types require extensions
  },
  (table) => [
    index("idx_docs_project").on(table.projectId),
    index("idx_docs_personal_owner").on(table.personalOwnerId, table.personalOwnerType),
    index("idx_docs_doc_type").on(table.docType),
  ],
);

export const documentLinks = pgTable(
  "document_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceDocId: uuid("source_doc_id")
      .references(() => documents.id, { onDelete: "cascade" })
      .notNull(),
    targetDocId: uuid("target_doc_id")
      .references(() => documents.id, { onDelete: "cascade" })
      .notNull(),
    linkType: text("link_type", { enum: ["reference", "related", "parent"] })
      .default("reference")
      .notNull(),
    context: text("context"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_doc_links_source").on(table.sourceDocId),
    index("idx_doc_links_target").on(table.targetDocId),
  ],
);

export const documentTaskLinks = pgTable(
  "document_task_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .references(() => documents.id, { onDelete: "cascade" })
      .notNull(),
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    linkType: text("link_type", { enum: ["references", "documents", "output"] })
      .default("references")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_doc_task_doc").on(table.documentId),
    index("idx_doc_task_task").on(table.taskId),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .references(() => documents.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    summary: text("summary"),
    keywords: text("keywords").array(),
    docType: text("doc_type").notNull(),
    changeType: text("change_type", {
      enum: ["created", "updated", "reverted"],
    }).notNull(),
    changedBy: text("changed_by").notNull(),
    changedByType: text("changed_by_type", {
      enum: ["human", "agent"],
    }).notNull(),
    changeDescription: text("change_description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_doc_versions_doc").on(table.documentId),
    index("idx_doc_versions_time").on(table.createdAt),
    uniqueIndex("idx_doc_versions_unique").on(table.documentId, table.version),
  ],
);

export const documentRequirementLinks = pgTable(
  "document_requirement_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .references(() => documents.id, { onDelete: "cascade" })
      .notNull(),
    requirementId: uuid("requirement_id")
      .references(() => requirements.id, { onDelete: "cascade" })
      .notNull(),
    linkType: text("link_type", {
      enum: ["references", "documents", "output"],
    })
      .default("references")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_doc_req_doc").on(table.documentId),
    index("idx_doc_req_req").on(table.requirementId),
  ],
);
