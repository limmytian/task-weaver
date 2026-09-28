import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  actorTypeEnum,
  skillPackageFileKindEnum,
  skillPackageSourceTypeEnum,
  skillPackageStatusEnum,
  skillPackageStorageObjectKindEnum,
  skillPackageVersionStatusEnum,
} from "./enums";
import { documents } from "./documents";
import { projects } from "./projects";

export type SkillPackageManifest = Record<string, unknown>;
export type SkillPackageFileMetadata = Record<string, unknown>;
export type SkillPackageStorageMetadata = Record<string, unknown>;

export const skillPackages = pgTable(
  "skill_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    personalOwnerId: text("personal_owner_id"),
    personalOwnerType: actorTypeEnum("personal_owner_type"),
    status: skillPackageStatusEnum("status").default("active").notNull(),
    sourceType: skillPackageSourceTypeEnum("source_type").default("upload").notNull(),
    entryPath: text("entry_path").default("SKILL.md").notNull(),
    manifest: jsonb("manifest").$type<SkillPackageManifest>().default({}).notNull(),
    summary: text("summary"),
    keywords: text("keywords").array(),
    tags: text("tags").array(),
    primaryDocumentId: uuid("primary_document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_skill_packages_project").on(table.projectId),
    index("idx_skill_packages_personal_owner").on(table.personalOwnerId, table.personalOwnerType),
    index("idx_skill_packages_status").on(table.status),
    index("idx_skill_packages_primary_document").on(table.primaryDocumentId),
  ],
);

export const skillPackageVersions = pgTable(
  "skill_package_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id")
      .references(() => skillPackages.id, { onDelete: "cascade" })
      .notNull(),
    version: text("version").notNull(),
    status: skillPackageVersionStatusEnum("status").default("active").notNull(),
    sourceType: skillPackageSourceTypeEnum("source_type").default("upload").notNull(),
    entryPath: text("entry_path").default("SKILL.md").notNull(),
    manifest: jsonb("manifest").$type<SkillPackageManifest>().default({}).notNull(),
    fileManifest: jsonb("file_manifest").$type<SkillPackageManifest>().default({}).notNull(),
    storageBackend: text("storage_backend").default("local").notNull(),
    storageKeyPrefix: text("storage_key_prefix"),
    fileCount: integer("file_count").default(0).notNull(),
    totalSizeBytes: bigint("total_size_bytes", { mode: "number" }).default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_skill_package_versions_package_version").on(table.packageId, table.version),
    index("idx_skill_package_versions_package").on(table.packageId),
    index("idx_skill_package_versions_status").on(table.status),
  ],
);

export const skillPackageStorageObjects = pgTable(
  "skill_package_storage_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageVersionId: uuid("package_version_id")
      .references(() => skillPackageVersions.id, { onDelete: "cascade" })
      .notNull(),
    kind: skillPackageStorageObjectKindEnum("kind").default("file").notNull(),
    storageBackend: text("storage_backend").default("local").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentType: text("content_type"),
    metadata: jsonb("metadata").$type<SkillPackageStorageMetadata>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_skill_package_storage_object_key").on(table.storageBackend, table.objectKey),
    index("idx_skill_package_storage_objects_version").on(table.packageVersionId),
    index("idx_skill_package_storage_objects_sha").on(table.sha256),
  ],
);

export const skillPackageFiles = pgTable(
  "skill_package_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageVersionId: uuid("package_version_id")
      .references(() => skillPackageVersions.id, { onDelete: "cascade" })
      .notNull(),
    storageObjectId: uuid("storage_object_id").references(() => skillPackageStorageObjects.id, {
      onDelete: "set null",
    }),
    path: text("path").notNull(),
    kind: skillPackageFileKindEnum("kind").notNull(),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    isReadableText: boolean("is_readable_text").default(false).notNull(),
    isExecutable: boolean("is_executable").default(false).notNull(),
    indexedDocumentId: uuid("indexed_document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata").$type<SkillPackageFileMetadata>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_skill_package_files_version_path").on(table.packageVersionId, table.path),
    index("idx_skill_package_files_version").on(table.packageVersionId),
    index("idx_skill_package_files_storage_object").on(table.storageObjectId),
    index("idx_skill_package_files_indexed_document").on(table.indexedDocumentId),
    index("idx_skill_package_files_sha").on(table.sha256),
  ],
);
