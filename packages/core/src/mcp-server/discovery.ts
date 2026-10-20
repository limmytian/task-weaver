import { and, asc, desc, eq, or, ne, not } from "drizzle-orm";
import { documents, skillPackages, skillPackageVersions, skillPackageFiles, type Database } from "@task-weaver/db";
import { NotFoundError, ValidationError, ConflictError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockIdentityLifecycle } from "../services/auth-security";
import { resourceAuthority, requireResource, personalResourceOwnerId } from "../services/resource-authorization";
import { requirePackage, packageResourcePredicate } from "../services/asset-authorization";
import { createResourceServices } from "../services/resource-services";
import type { SkillPackageStorageAdapter } from "../services/skill-package-storage";
import { McpToolFailure } from "./index";

const packageColumns = { id: skillPackages.id, name: skillPackages.name, description: skillPackages.description, summary: skillPackages.summary, projectId: skillPackages.projectId, status: skillPackages.status, entryPath: skillPackages.entryPath, tags: skillPackages.tags, updatedAt: skillPackages.updatedAt };
const versionColumns = { id: skillPackageVersions.id, version: skillPackageVersions.version, entryPath: skillPackageVersions.entryPath, fileCount: skillPackageVersions.fileCount, totalSizeBytes: skillPackageVersions.totalSizeBytes };
const fileColumns = { path: skillPackageFiles.path, kind: skillPackageFiles.kind, sizeBytes: skillPackageFiles.sizeBytes, sha256: skillPackageFiles.sha256, isReadableText: skillPackageFiles.isReadableText };

export async function readMcpPackage(db: Database, identity: VerifiedRequestContext, operation: "get" | "files" | "read", input: { packageId: string; version?: string; path?: string; limit?: number; offset?: number }, storage?: SkillPackageStorageAdapter) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const database = tx as unknown as Database;
    const authority = await resourceAuthority(tx, identity);
    await requirePackage(database, authority, input.packageId);
    const [pkg] = await tx.select(packageColumns).from(skillPackages).where(and(eq(skillPackages.id, input.packageId), eq(skillPackages.status, "active")));
    if (!pkg) throw new NotFoundError("Resource not found");
    const [version] = await tx.select(versionColumns).from(skillPackageVersions).where(and(eq(skillPackageVersions.packageId, pkg.id), eq(skillPackageVersions.status, "active"), input.version ? eq(skillPackageVersions.version, input.version) : undefined)).orderBy(desc(skillPackageVersions.createdAt), skillPackageVersions.id).limit(1);
    if (!version) throw new NotFoundError("Resource not found");
    if (operation === "get") return { ...pkg, version };
    if (operation === "files") {
      const limit = input.limit ?? 20, offset = input.offset ?? 0;
      const files = await tx.select(fileColumns).from(skillPackageFiles).where(eq(skillPackageFiles.packageVersionId, version.id)).orderBy(asc(skillPackageFiles.path)).limit(limit + 1).offset(offset);
      return { packageId: pkg.id, version: version.version, items: files.slice(0, limit), meta: { limit, offset, nextOffset: files.length > limit ? offset + limit : null } };
    }
    const [file] = await tx.select(fileColumns).from(skillPackageFiles).where(and(eq(skillPackageFiles.packageVersionId, version.id), eq(skillPackageFiles.path, input.path!))).limit(1);
    if (!file) throw new NotFoundError("Resource not found");
    if (!file.isReadableText) throw new ValidationError("File is not readable text");
    if (file.sizeBytes > 32768) throw new McpToolFailure("result_too_large", "Package text exceeds the 32768-byte read limit.");
    if (!storage) throw new ValidationError("Package storage is unavailable");
    const result = await createResourceServices(identity).skillPackageService.readPackageTextFile(database, { packageId: pkg.id, version: version.version, path: input.path! }, storage, 32768);
    return { packageId: pkg.id, version: version.version, file, content: result.content };
  });
}

export async function readMcpSkill(db: Database, identity: VerifiedRequestContext, id: string, expectedVersion?: number) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const authority = await resourceAuthority(tx, identity);
    await requireResource(tx as unknown as Database, authority, "document", id);
    const [record] = await tx.select({ content: documents.content, docType: documents.docType, version: documents.version }).from(documents).where(eq(documents.id, id));
    if (!record || record.docType !== "skill") throw new NotFoundError("Resource not found");
    if (expectedVersion !== undefined && expectedVersion !== record.version) throw new ConflictError("Skill changed; resolve its capability manifest again", record.version);
    // Package quarantine and version availability apply to direct document reads too.
    const unavailable = await tx.select({ id: skillPackageFiles.id }).from(skillPackageFiles)
      .innerJoin(skillPackageVersions, eq(skillPackageVersions.id, skillPackageFiles.packageVersionId))
      .innerJoin(skillPackages, eq(skillPackages.id, skillPackageVersions.packageId))
      .where(and(eq(skillPackageFiles.indexedDocumentId, id), or(ne(skillPackages.status, "active"), ne(skillPackageVersions.status, "active"), not(packageResourcePredicate(authority))))).limit(1);
    if (unavailable.length) throw new NotFoundError("Resource not found");
    if (Buffer.byteLength(record.content, "utf8") > 32768) throw new McpToolFailure("result_too_large", "Skill text exceeds the 32768-byte read limit.");
    return createResourceServices(identity).documentService.getDocument(tx as unknown as Database, id);
  });
}

export async function listMcpPackages(db: Database, identity: VerifiedRequestContext, input: { projectId?: string; includeGlobal: boolean; includePersonal: boolean; query?: string; limit: number; offset: number }) {
  const result = await createResourceServices(identity).skillPackageService.listPackages(db, { ...input, ...(input.includePersonal ? { personalOwnerId: personalResourceOwnerId(identity), personalOwnerType: "human" as const } : {}), allProjects: false, status: "active", limit: input.limit + 1 }, undefined, true);
  return { items: result.items.slice(0, input.limit).map(pkg => ({ id: pkg.id, name: pkg.name, summary: pkg.summary, projectId: pkg.projectId, status: pkg.status, entryPath: pkg.entryPath, updatedAt: pkg.updatedAt })), meta: { limit: input.limit, offset: input.offset, nextOffset: result.items.length > input.limit ? input.offset + input.limit : null } };
}
