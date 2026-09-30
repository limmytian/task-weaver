import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  type Database,
  activityLog,
  documents,
  skillPackageFiles,
  skillPackages,
  skillPackageStorageObjects,
  skillPackageVersions,
} from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import type {
  DownloadSkillPackageInput,
  ListSkillPackagesInput,
  ReadSkillPackageFileInput,
  ReindexSkillPackageInput,
  RegisterSkillPackageFileInput,
  RegisterSkillPackageInput,
  UpdateSkillPackageMetadataInput,
  UpdateSkillPackageVersionStatusInput,
  VerifySkillPackageStorageInput,
} from "@task-weaver/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@task-weaver/contracts";
import type { SkillPackageStorageAdapter } from "./skill-package-storage";
import { sha256Hex } from "./skill-package-storage";
import { createDocument, deleteDocument, updateDocument } from "./documents";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".html",
  ".sh",
  ".py",
  ".rb",
  ".go",
  ".rs",
]);

export async function registerPackage(
  db: Database,
  input: RegisterSkillPackageInput,
  actor: Actor,
  storage: SkillPackageStorageAdapter,
) {
  if (input.storageBackend !== storage.backend) {
    throw new ValidationError(`Storage backend "${input.storageBackend}" is not available`);
  }

  const normalizedFiles = normalizeRegisteredFiles(input.files);
  const existingPackage = await findPackageByNameAndScope(db, input);
  const now = new Date();

  const pkg = existingPackage
    ? await updateExistingPackage(db, existingPackage.id, input, now)
    : await createNewPackage(db, input, actor);

  const existingVersion = await db.query.skillPackageVersions.findFirst({
    where: and(
      eq(skillPackageVersions.packageId, pkg.id),
      eq(skillPackageVersions.version, input.version),
    ),
  });

  const version = existingVersion
    ? await replaceExistingVersion(db, existingVersion.id, input, actor, storage, normalizedFiles)
    : await createPackageVersion(db, pkg.id, input, actor, normalizedFiles);

  if (!existingVersion) {
    await storeFiles(db, pkg.id, version.id, input, actor, storage, normalizedFiles);
  }

  const files = await db.query.skillPackageFiles.findMany({
    where: eq(skillPackageFiles.packageVersionId, version.id),
    orderBy: (file, { asc }) => [asc(file.path)],
  });

  const entryFile = files.find((file) => file.path === input.entryPath);
  if (entryFile?.indexedDocumentId && pkg.primaryDocumentId !== entryFile.indexedDocumentId) {
    await db
      .update(skillPackages)
      .set({ primaryDocumentId: entryFile.indexedDocumentId, updatedAt: new Date() })
      .where(eq(skillPackages.id, pkg.id));
  }

  await db.insert(activityLog).values({
    entityType: "skill_package",
    entityId: pkg.id,
    action: existingPackage ? "updated" : "created",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      versionId: version.id,
      version: version.version,
      fileCount: normalizedFiles.length,
    },
  });

  return getPackage(db, pkg.id);
}

export async function listPackages(db: Database, input: ListSkillPackagesInput) {
  const conditions = [buildPackageVisibilityCondition(input)];
  if (input.status) {
    conditions.push(eq(skillPackages.status, input.status));
  }
  if (input.tag) {
    conditions.push(sql`${input.tag} = ANY(${skillPackages.tags})`);
  }

  const items = await db.query.skillPackages.findMany({
    where: and(...conditions),
    with: {
      versions: {
        orderBy: (version, { desc }) => [desc(version.createdAt)],
        limit: 1,
      },
    },
    orderBy: (pkg, { desc }) => [desc(pkg.updatedAt)],
    limit: input.limit,
    offset: input.offset,
  });

  return { items };
}

export async function getPackage(db: Database, packageId: string) {
  const pkg = await db.query.skillPackages.findFirst({
    where: eq(skillPackages.id, packageId),
    with: {
      versions: {
        orderBy: (version, { desc }) => [desc(version.createdAt)],
        with: {
          files: {
            orderBy: (file, { asc }) => [asc(file.path)],
          },
        },
      },
      primaryDocument: true,
    },
  });
  if (!pkg) throw new NotFoundError("Skill package not found");
  return pkg;
}

export async function listPackageFiles(db: Database, input: Omit<ReadSkillPackageFileInput, "path">) {
  const version = await resolvePackageVersion(db, input.packageId, input.version);
  const files = await db.query.skillPackageFiles.findMany({
    where: eq(skillPackageFiles.packageVersionId, version.id),
    orderBy: (file, { asc }) => [asc(file.path)],
  });
  return { packageVersion: version, items: files };
}

export async function readPackageTextFile(
  db: Database,
  input: ReadSkillPackageFileInput,
  storage: SkillPackageStorageAdapter,
) {
  const version = await resolvePackageVersion(db, input.packageId, input.version);
  const file = await db.query.skillPackageFiles.findFirst({
    where: and(
      eq(skillPackageFiles.packageVersionId, version.id),
      eq(skillPackageFiles.path, input.path),
    ),
    with: {
      storageObject: true,
      indexedDocument: true,
    },
  });
  if (!file) throw new NotFoundError("Skill package file not found");
  if (!file.isReadableText) throw new ConflictError("Skill package file is not readable text", 0);

  if (file.indexedDocument) {
    return {
      packageVersion: version,
      file,
      content: file.indexedDocument.content,
      source: "document" as const,
    };
  }

  if (!file.storageObject) throw new NotFoundError("Skill package file storage object not found");
  if (file.storageObject.storageBackend !== storage.backend) {
    throw new ConflictError(`Storage backend "${file.storageObject.storageBackend}" is not available`, 0);
  }

  const stored = await storage.getObject(file.storageObject.objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stored.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return {
    packageVersion: version,
    file,
    content: Buffer.concat(chunks).toString("utf8"),
    source: "storage" as const,
  };
}

export async function downloadPackage(
  db: Database,
  input: DownloadSkillPackageInput,
  storage: SkillPackageStorageAdapter,
) {
  const version = await resolvePackageVersion(db, input.packageId, input.version);
  const files = await db.query.skillPackageFiles.findMany({
    where: eq(skillPackageFiles.packageVersionId, version.id),
    with: {
      storageObject: true,
    },
    orderBy: (file, { asc }) => [asc(file.path)],
  });

  const payloadFiles = [];
  for (const file of files) {
    if (!file.storageObject) throw new NotFoundError(`Storage object not found for ${file.path}`);
    if (file.storageObject.storageBackend !== storage.backend) {
      throw new ConflictError(`Storage backend "${file.storageObject.storageBackend}" is not available`, 0);
    }
    const stored = await storage.getObject(file.storageObject.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stored.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks);
    const sha256 = sha256Hex(content);
    if (sha256 !== file.sha256) {
      throw new ConflictError(`Stored content hash mismatch for ${file.path}`, 0);
    }
    payloadFiles.push({
      id: file.id,
      path: file.path,
      kind: file.kind,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      sha256,
      isReadableText: file.isReadableText,
      isExecutable: file.isExecutable,
      contentBase64: content.toString("base64"),
    });
  }

  return {
    packageId: version.packageId,
    packageVersionId: version.id,
    version: version.version,
    entryPath: version.entryPath,
    manifest: version.manifest,
    fileManifest: version.fileManifest,
    files: payloadFiles,
  };
}

export async function verifyPackageStorage(
  db: Database,
  input: VerifySkillPackageStorageInput,
  storage: SkillPackageStorageAdapter,
) {
  const version = await resolvePackageVersion(db, input.packageId, input.version);
  const files = await db.query.skillPackageFiles.findMany({
    where: eq(skillPackageFiles.packageVersionId, version.id),
    with: {
      storageObject: true,
    },
    orderBy: (file, { asc }) => [asc(file.path)],
  });

  const items = [];
  let ok = 0;

  for (const file of files) {
    const base = {
      id: file.id,
      path: file.path,
      expectedSha256: file.sha256,
      expectedSizeBytes: file.sizeBytes,
      storageObjectId: file.storageObjectId,
    };

    if (!file.storageObject) {
      items.push({ ...base, status: "missing_storage_object" });
      continue;
    }
    if (file.storageObject.storageBackend !== storage.backend) {
      items.push({
        ...base,
        status: "unavailable_backend",
        storageBackend: file.storageObject.storageBackend,
      });
      continue;
    }

    try {
      const content = await readStoredObjectBuffer(storage, file.storageObject.objectKey);
      const actualSha256 = sha256Hex(content);
      const hashMatches = actualSha256 === file.sha256 && actualSha256 === file.storageObject.sha256;
      const sizeMatches = content.byteLength === file.sizeBytes && content.byteLength === file.storageObject.sizeBytes;
      const status = hashMatches && sizeMatches
        ? "ok"
        : hashMatches
          ? "size_mismatch"
          : "hash_mismatch";
      if (status === "ok") ok += 1;
      items.push({
        ...base,
        status,
        actualSha256,
        actualSizeBytes: content.byteLength,
      });
    } catch (error) {
      items.push({
        ...base,
        status: "storage_error",
        message: error instanceof Error ? error.message : "Unknown storage error",
      });
    }
  }

  return {
    packageId: version.packageId,
    packageVersionId: version.id,
    version: version.version,
    checked: files.length,
    ok,
    failed: files.length - ok,
    items,
  };
}

export async function reindexPackageTextFiles(
  db: Database,
  input: ReindexSkillPackageInput,
  actor: Actor,
  storage: SkillPackageStorageAdapter,
) {
  const version = await resolvePackageVersion(db, input.packageId, input.version);
  const pkg = await db.query.skillPackages.findFirst({
    where: eq(skillPackages.id, version.packageId),
  });
  if (!pkg) throw new NotFoundError("Skill package not found");

  const files = await db.query.skillPackageFiles.findMany({
    where: eq(skillPackageFiles.packageVersionId, version.id),
    with: {
      storageObject: true,
    },
    orderBy: (file, { asc }) => [asc(file.path)],
  });

  const pathFilter = input.paths ? new Set(input.paths) : null;
  const seenPaths = new Set<string>();
  const reindexed = [];
  const skipped = [];

  const documentInput: SkillPackageDocumentInput = {
    name: pkg.name,
    entryPath: version.entryPath,
    summary: pkg.summary,
    keywords: pkg.keywords,
    tags: pkg.tags,
    projectId: pkg.projectId,
    personalOwnerId: pkg.personalOwnerId,
    personalOwnerType: pkg.personalOwnerType,
  };

  for (const file of files) {
    if (pathFilter && !pathFilter.has(file.path)) continue;
    seenPaths.add(file.path);

    if (!file.isReadableText) {
      skipped.push({ id: file.id, path: file.path, reason: "not_readable_text" });
      continue;
    }
    if (!file.storageObject) {
      skipped.push({ id: file.id, path: file.path, reason: "missing_storage_object" });
      continue;
    }
    if (file.storageObject.storageBackend !== storage.backend) {
      skipped.push({
        id: file.id,
        path: file.path,
        reason: "unavailable_backend",
        storageBackend: file.storageObject.storageBackend,
      });
      continue;
    }

    const content = await readStoredObjectBuffer(storage, file.storageObject.objectKey);
    const sha256 = sha256Hex(content);
    if (sha256 !== file.sha256) {
      skipped.push({ id: file.id, path: file.path, reason: "hash_mismatch" });
      continue;
    }

    const indexedDocumentId = await upsertIndexedDocument(
      db,
      documentInput,
      actor,
      {
        path: file.path,
        content,
        sha256,
        contentType: file.contentType ?? inferContentType(file.path, true),
        kind: file.kind,
        isReadableText: true,
        isExecutable: file.isExecutable,
        metadata: file.metadata,
      },
      version.packageId,
      version.id,
    );

    if (file.indexedDocumentId !== indexedDocumentId) {
      await db
        .update(skillPackageFiles)
        .set({ indexedDocumentId })
        .where(eq(skillPackageFiles.id, file.id));
    }
    if (file.path === version.entryPath && pkg.primaryDocumentId !== indexedDocumentId) {
      await db
        .update(skillPackages)
        .set({ primaryDocumentId: indexedDocumentId, updatedAt: new Date() })
        .where(eq(skillPackages.id, pkg.id));
    }

    reindexed.push({ id: file.id, path: file.path, indexedDocumentId });
  }

  if (pathFilter) {
    for (const path of pathFilter) {
      if (!seenPaths.has(path)) skipped.push({ path, reason: "not_found" });
    }
  }

  await db.insert(activityLog).values({
    entityType: "skill_package",
    entityId: version.packageId,
    action: "reindexed",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      version: version.version,
      reindexed: reindexed.length,
      skipped: skipped.length,
    },
  });

  return {
    packageId: version.packageId,
    packageVersionId: version.id,
    version: version.version,
    reindexed,
    skipped,
  };
}

export async function updatePackageMetadata(
  db: Database,
  input: UpdateSkillPackageMetadataInput,
  actor: Actor,
) {
  await getPackage(db, input.packageId);
  const { packageId, ...updates } = input;
  const [updated] = await db
    .update(skillPackages)
    .set({
      ...updates,
      updatedAt: new Date(),
      archivedAt: updates.status === "archived" || updates.status === "deleted" ? new Date() : undefined,
    })
    .where(eq(skillPackages.id, packageId))
    .returning();

  await db.insert(activityLog).values({
    entityType: "skill_package",
    entityId: packageId,
    action: "updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: updates,
  });

  return updated!;
}

export async function updatePackageVersionStatus(
  db: Database,
  input: UpdateSkillPackageVersionStatusInput,
  actor: Actor,
) {
  const version = await resolvePackageVersion(db, input.packageId, input.version);
  const [updated] = await db
    .update(skillPackageVersions)
    .set({ status: input.status, updatedAt: new Date() })
    .where(eq(skillPackageVersions.id, version.id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "skill_package",
    entityId: input.packageId,
    action: "version_status_updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      version: input.version,
      status: input.status,
    },
  });

  return updated!;
}

export async function getPackageMetadataForDocuments(db: Database, documentIds: string[]) {
  if (documentIds.length === 0) return new Map<string, unknown>();

  const files = await db.query.skillPackageFiles.findMany({
    where: inArray(skillPackageFiles.indexedDocumentId, documentIds),
    with: {
      packageVersion: {
        with: {
          package: true,
        },
      },
    },
  });

  return new Map(files.flatMap((file) => {
    if (!file.indexedDocumentId) return [];
    return [[file.indexedDocumentId, {
      packageId: file.packageVersion.package.id,
      packageName: file.packageVersion.package.name,
      packageVersionId: file.packageVersion.id,
      version: file.packageVersion.version,
      path: file.path,
      kind: file.kind,
      isEntry: file.path === file.packageVersion.entryPath,
      fileId: file.id,
      active: file.packageVersion.package.status === "active"
        && file.packageVersion.status === "active",
    }]];
  }));
}

async function createNewPackage(
  db: Database,
  input: RegisterSkillPackageInput,
  actor: Actor,
) {
  const [created] = await db
    .insert(skillPackages)
    .values({
      name: input.name,
      description: input.description,
      projectId: input.projectId ?? null,
      personalOwnerId: input.personalOwnerId ?? null,
      personalOwnerType: input.personalOwnerType ?? null,
      status: "active",
      sourceType: input.sourceType,
      entryPath: input.entryPath,
      manifest: input.manifest,
      summary: input.summary,
      keywords: input.keywords,
      tags: input.tags,
      createdBy: actor.id,
    })
    .returning();
  return created!;
}

async function updateExistingPackage(
  db: Database,
  packageId: string,
  input: RegisterSkillPackageInput,
  updatedAt: Date,
) {
  const [updated] = await db
    .update(skillPackages)
    .set({
      description: input.description ?? null,
      sourceType: input.sourceType,
      entryPath: input.entryPath,
      manifest: input.manifest,
      summary: input.summary ?? null,
      keywords: input.keywords,
      tags: input.tags,
      updatedAt,
    })
    .where(eq(skillPackages.id, packageId))
    .returning();
  return updated!;
}

async function createPackageVersion(
  db: Database,
  packageId: string,
  input: RegisterSkillPackageInput,
  actor: Actor,
  files: NormalizedRegisteredFile[],
) {
  const [created] = await db
    .insert(skillPackageVersions)
    .values({
      packageId,
      version: input.version,
      status: "active",
      sourceType: input.sourceType,
      entryPath: input.entryPath,
      manifest: input.manifest,
      fileManifest: buildFileManifest(files),
      storageBackend: input.storageBackend,
      storageKeyPrefix: input.storageKeyPrefix,
      fileCount: files.length,
      totalSizeBytes: files.reduce((sum, file) => sum + file.content.byteLength, 0),
      createdBy: actor.id,
    })
    .returning();
  return created!;
}

async function replaceExistingVersion(
  db: Database,
  versionId: string,
  input: RegisterSkillPackageInput,
  actor: Actor,
  storage: SkillPackageStorageAdapter,
  files: NormalizedRegisteredFile[],
) {
  const existingFiles = await db.query.skillPackageFiles.findMany({
    where: eq(skillPackageFiles.packageVersionId, versionId),
    with: {
      storageObject: true,
    },
  });

  for (const file of existingFiles) {
    if (file.indexedDocumentId) {
      await deleteDocument(db, file.indexedDocumentId, actor).catch(() => undefined);
    }
    if (file.storageObject?.storageBackend === storage.backend) {
      await storage.deleteObject(file.storageObject.objectKey).catch(() => undefined);
    }
  }

  await db.delete(skillPackageFiles).where(eq(skillPackageFiles.packageVersionId, versionId));
  await db.delete(skillPackageStorageObjects).where(eq(skillPackageStorageObjects.packageVersionId, versionId));

  const [updated] = await db
    .update(skillPackageVersions)
    .set({
      status: "active",
      sourceType: input.sourceType,
      entryPath: input.entryPath,
      manifest: input.manifest,
      fileManifest: buildFileManifest(files),
      storageBackend: input.storageBackend,
      storageKeyPrefix: input.storageKeyPrefix,
      fileCount: files.length,
      totalSizeBytes: files.reduce((sum, file) => sum + file.content.byteLength, 0),
      updatedAt: new Date(),
    })
    .where(eq(skillPackageVersions.id, versionId))
    .returning();

  const packageId = updated!.packageId;
  await storeFiles(db, packageId, versionId, input, actor, storage, files);
  return updated!;
}

async function storeFiles(
  db: Database,
  packageId: string,
  versionId: string,
  input: RegisterSkillPackageInput,
  actor: Actor,
  storage: SkillPackageStorageAdapter,
  files: NormalizedRegisteredFile[],
) {
  for (const file of files) {
    const objectKey = [input.storageKeyPrefix, "skill-packages", packageId, versionId, file.path]
      .filter(Boolean)
      .join("/");
    const stored = await storage.putObject({
      key: objectKey,
      body: file.content,
      sha256: file.sha256,
      contentType: file.contentType,
    });

    const [storageObject] = await db
      .insert(skillPackageStorageObjects)
      .values({
        packageVersionId: versionId,
        kind: "file",
        storageBackend: stored.backend,
        objectKey: stored.key,
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        contentType: file.contentType,
        metadata: {},
      })
      .returning();

    const indexedDocumentId = file.isReadableText
      ? await upsertIndexedDocument(db, input, actor, file, packageId, versionId)
      : null;

    await db.insert(skillPackageFiles).values({
      packageVersionId: versionId,
      storageObjectId: storageObject!.id,
      path: file.path,
      kind: file.kind,
      contentType: file.contentType,
      sizeBytes: file.content.byteLength,
      sha256: file.sha256,
      isReadableText: file.isReadableText,
      isExecutable: file.isExecutable,
      indexedDocumentId,
      metadata: file.metadata,
    });
  }
}

async function upsertIndexedDocument(
  db: Database,
  input: SkillPackageDocumentInput,
  actor: Actor,
  file: NormalizedRegisteredFile,
  packageId: string,
  versionId: string,
) {
  const title = file.path === input.entryPath ? input.name : `${input.name}/${file.path}`;
  const content = file.content.toString("utf8");
  const summary = file.path === input.entryPath
    ? input.summary ?? undefined
    : `Text asset ${file.path} from skill package ${input.name}.`;
  const keywords = input.keywords ?? undefined;
  const tags = input.tags ?? undefined;

  const generationPrompt = `skill-package:${packageId}:${versionId}:${file.path}`;
  const legacyScope = input.projectId
    ? and(eq(documents.projectId, input.projectId), isNull(documents.personalOwnerId))!
    : input.personalOwnerId && input.personalOwnerType
      ? and(
        isNull(documents.projectId),
        eq(documents.personalOwnerId, input.personalOwnerId),
        eq(documents.personalOwnerType, input.personalOwnerType),
      )!
      : and(isNull(documents.projectId), isNull(documents.personalOwnerId))!;
  const existing = await db.query.documents.findFirst({
    where: or(
      and(
        eq(documents.docType, "skill"),
        eq(documents.title, title),
        eq(documents.generationPrompt, generationPrompt),
      ),
      // Migrate a legacy flat seed document into the package instead of
      // creating a duplicate global search result on the first startup sync.
      and(
        eq(documents.docType, "skill"),
        eq(documents.title, title),
        isNull(documents.generationPrompt),
        legacyScope,
      ),
    ),
  });

  if (existing) {
    const updated = await updateDocument(db, existing.id, {
      content,
      summary,
      keywords,
      tags,
      docType: "skill",
      projectId: input.projectId ?? null,
      personalOwnerId: input.personalOwnerId ?? null,
      personalOwnerType: input.personalOwnerType ?? null,
      generatedBy: actor.id,
      generationPrompt,
    }, actor);
    return updated.id;
  }

  const created = await createDocument(db, {
    title,
    content,
    summary,
    keywords,
    tags,
    docType: "skill",
    projectId: input.projectId ?? undefined,
    personalOwnerId: input.personalOwnerId ?? undefined,
    personalOwnerType: input.personalOwnerType ?? undefined,
    generatedBy: actor.id,
    generationPrompt,
  }, actor);
  return created.id;
}

async function resolvePackageVersion(db: Database, packageId: string, version?: string) {
  const pkg = await db.query.skillPackages.findFirst({
    where: eq(skillPackages.id, packageId),
  });
  if (!pkg) throw new NotFoundError("Skill package not found");

  const packageVersion = version
    ? await db.query.skillPackageVersions.findFirst({
      where: and(
        eq(skillPackageVersions.packageId, packageId),
        eq(skillPackageVersions.version, version),
      ),
    })
    : await db.query.skillPackageVersions.findFirst({
      where: eq(skillPackageVersions.packageId, packageId),
      orderBy: [desc(skillPackageVersions.createdAt)],
    });
  if (!packageVersion) throw new NotFoundError("Skill package version not found");
  return packageVersion;
}

async function findPackageByNameAndScope(
  db: Database,
  input: Pick<RegisterSkillPackageInput, "name" | "projectId" | "personalOwnerId" | "personalOwnerType">,
) {
  return db.query.skillPackages.findFirst({
    where: and(
      sql`lower(${skillPackages.name}) = lower(${input.name})`,
      buildExactPackageScopeCondition(input),
    ),
  });
}

function buildExactPackageScopeCondition(input: {
  projectId?: string;
  personalOwnerId?: string;
  personalOwnerType?: "human" | "agent";
}) {
  if (input.projectId) {
    return and(
      eq(skillPackages.projectId, input.projectId),
      isNull(skillPackages.personalOwnerId),
    )!;
  }

  if (input.personalOwnerId && input.personalOwnerType) {
    return and(
      isNull(skillPackages.projectId),
      eq(skillPackages.personalOwnerId, input.personalOwnerId),
      eq(skillPackages.personalOwnerType, input.personalOwnerType),
    )!;
  }

  return and(isNull(skillPackages.projectId), isNull(skillPackages.personalOwnerId))!;
}

function buildPackageVisibilityCondition(input: {
  projectId?: string;
  includeGlobal?: boolean;
  includePersonal?: boolean;
  allProjects?: boolean;
  personalOwnerId?: string;
  personalOwnerType?: "human" | "agent";
}) {
  const scopes = [];

  if (input.allProjects) {
    scopes.push(isNotNull(skillPackages.projectId));
    if (input.includeGlobal) {
      scopes.push(and(isNull(skillPackages.projectId), isNull(skillPackages.personalOwnerId))!);
    }
  } else if (input.projectId) {
    scopes.push(eq(skillPackages.projectId, input.projectId));
    if (input.includeGlobal) {
      scopes.push(and(isNull(skillPackages.projectId), isNull(skillPackages.personalOwnerId))!);
    }
  } else {
    scopes.push(and(isNull(skillPackages.projectId), isNull(skillPackages.personalOwnerId))!);
  }

  if (input.includePersonal && input.personalOwnerId && input.personalOwnerType) {
    scopes.push(
      and(
        isNull(skillPackages.projectId),
        eq(skillPackages.personalOwnerId, input.personalOwnerId),
        eq(skillPackages.personalOwnerType, input.personalOwnerType),
      )!,
    );
  }

  return or(...scopes)!;
}

function normalizeRegisteredFiles(files: RegisterSkillPackageFileInput[]): NormalizedRegisteredFile[] {
  const seen = new Set<string>();
  return files.map((file) => {
    if (seen.has(file.path)) {
      throw new ValidationError(`Duplicate package file path: ${file.path}`);
    }
    seen.add(file.path);

    const content = Buffer.from(file.contentBase64, "base64");
    const isReadableText = file.isReadableText ?? isProbablyReadableText(file.path, content, file.contentType);
    return {
      path: file.path,
      content,
      sha256: sha256Hex(content),
      contentType: file.contentType ?? inferContentType(file.path, isReadableText),
      kind: file.kind ?? inferFileKind(file.path, isReadableText),
      isReadableText,
      isExecutable: file.isExecutable ?? false,
      metadata: file.metadata,
    };
  });
}

function inferFileKind(path: string, isReadableText: boolean) {
  if (path === "SKILL.md") return "entry";
  if (isReadableText) return "text";
  return "binary";
}

function inferContentType(path: string, isReadableText: boolean) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  if (isReadableText) return "text/plain";
  return "application/octet-stream";
}

function isProbablyReadableText(path: string, content: Buffer, contentType?: string) {
  if (contentType?.startsWith("text/") || contentType === "application/json" || contentType === "application/yaml") {
    return true;
  }
  const lower = path.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const sample = content.subarray(0, 4096).toString("utf8");
  return !content.includes(0) && !sample.includes("\uFFFD");
}

function buildFileManifest(files: NormalizedRegisteredFile[]) {
  return {
    files: files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.content.byteLength,
      kind: file.kind,
      contentType: file.contentType,
      isReadableText: file.isReadableText,
      isExecutable: file.isExecutable,
    })),
  };
}

async function readStoredObjectBuffer(storage: SkillPackageStorageAdapter, objectKey: string) {
  const stored = await storage.getObject(objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stored.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

interface SkillPackageDocumentInput {
  name: string;
  entryPath: string;
  summary?: string | null;
  keywords?: string[] | null;
  tags?: string[] | null;
  projectId?: string | null;
  personalOwnerId?: string | null;
  personalOwnerType?: "human" | "agent" | null;
}

interface NormalizedRegisteredFile {
  path: string;
  content: Buffer;
  sha256: string;
  contentType: string;
  kind: "entry" | "text" | "asset" | "binary";
  isReadableText: boolean;
  isExecutable: boolean;
  metadata: Record<string, unknown>;
}
