import { and, eq, sql, type SQL } from "drizzle-orm";
import { type Database, documents, skillPackages, embeddingProfiles } from "@task-weaver/db";
import { AuthorizationError, NotFoundError, type AuthorizationPermission } from "@task-weaver/contracts";
import {
  canAccessResource, requireScope, labelledResourcePredicate, qualifiedScopeColumns, resourcePredicate, requireResource, type ResourceAuthority,
} from "./resource-authorization";

/** Package files and indexed documents cannot point across the package's scope/version. */
export function packageResourcePredicate(authority: ResourceAuthority, permission: AuthorizationPermission = "resource.read"): SQL {
  const documentPredicate = resourcePredicate(authority, qualifiedScopeColumns(documents), permission);
  const sameScope = sql`documents.project_id IS NOT DISTINCT FROM ${skillPackages.projectId}
    AND documents.personal_owner_id IS NOT DISTINCT FROM ${skillPackages.personalOwnerId}
    AND documents.personal_owner_type IS NOT DISTINCT FROM ${skillPackages.personalOwnerType}`;
  return and(resourcePredicate(authority, skillPackages, permission), sql`
    (${skillPackages.primaryDocumentId} IS NULL OR EXISTS (
      SELECT 1 FROM documents WHERE documents.id = ${skillPackages.primaryDocumentId}
      AND ${sameScope} AND ${documentPredicate}
    )) AND NOT EXISTS (
      SELECT 1 FROM skill_package_versions pv
      JOIN skill_package_files pf ON pf.package_version_id = pv.id
      LEFT JOIN skill_package_storage_objects so ON so.id = pf.storage_object_id
      WHERE pv.package_id = ${skillPackages.id} AND (
        (pf.indexed_document_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM documents WHERE documents.id = pf.indexed_document_id
          AND ${sameScope} AND ${documentPredicate}
        )) OR (so.id IS NOT NULL AND so.package_version_id <> pf.package_version_id)
      )
    )
  `)!;
}

export async function requirePackage(db: Database, authority: ResourceAuthority, id: string, permission: AuthorizationPermission = "resource.read") {
  const scope = await requireResource(db, authority, "package", id, permission);
  const [row] = await db.select({ id: skillPackages.id }).from(skillPackages)
    .where(and(eq(skillPackages.id, id), packageResourcePredicate(authority, permission)));
  if (!row) throw new NotFoundError("Resource not found");
  return scope;
}

export function requireProfileManagement(authority: ResourceAuthority, scope: { projectId?: string | null; personalOwnerId?: string | null; personalOwnerType?: "human" | "agent" | null }, provider = false) {
  requireScope(authority, scope, scope.projectId ? "project.manage" : scope.personalOwnerId ? "resource.write" : "global.manage");
  if (provider && !canManageProvider(authority, scope)) throw new AuthorizationError();
}

export function canManageProvider(authority: ResourceAuthority, scope: { projectId?: string | null; personalOwnerId?: string | null; personalOwnerType?: "human" | "agent" | null }) {
  return authority.actor.type === "human" && authority.actor.instanceRole === "admin"
    && authority.grants.some(g => g.scope === "instance" && g.permissions.includes("instance.manage"))
    && canAccessResource(authority, scope, scope.projectId ? "project.manage" : scope.personalOwnerId ? "resource.write" : "global.manage");
}

/** Quarantine profiles with cross-scope children rather than expose their counts or provider data. */
export function profileResourcePredicate(authority: ResourceAuthority): SQL {
  const docPredicate = resourcePredicate(authority, qualifiedScopeColumns(documents));
  const sameScope = sql`documents.project_id IS NOT DISTINCT FROM ${embeddingProfiles.projectId}
    AND documents.personal_owner_id IS NOT DISTINCT FROM ${embeddingProfiles.personalOwnerId}
    AND documents.personal_owner_type IS NOT DISTINCT FROM ${embeddingProfiles.personalOwnerType}`;
  return and(labelledResourcePredicate(authority, embeddingProfiles), sql`
    (${embeddingProfiles.activeGenerationId} IS NULL OR EXISTS (SELECT 1 FROM embedding_generations eg WHERE eg.id = ${embeddingProfiles.activeGenerationId} AND eg.profile_id = ${embeddingProfiles.id}))
    AND NOT EXISTS (SELECT 1 FROM embedding_jobs ej LEFT JOIN embedding_generations eg ON eg.id = ej.generation_id
      WHERE ej.profile_id = ${embeddingProfiles.id} AND (ej.generation_id IS NOT NULL AND (eg.id IS NULL OR eg.profile_id <> ej.profile_id)))
    AND NOT EXISTS (SELECT 1 FROM embedding_job_items ji JOIN embedding_jobs ej ON ej.id = ji.job_id JOIN documents ON documents.id = ji.document_id
      WHERE ej.profile_id = ${embeddingProfiles.id} AND NOT (${sameScope} AND ${docPredicate}))
    AND NOT EXISTS (SELECT 1 FROM document_embedding_states ds JOIN documents ON documents.id = ds.document_id
      WHERE ds.profile_id = ${embeddingProfiles.id} AND NOT (${sameScope} AND ${docPredicate}))
    AND NOT EXISTS (SELECT 1 FROM document_embeddings de JOIN embedding_generations eg ON eg.id = de.generation_id JOIN embedding_document_chunks ec ON ec.id = de.chunk_id JOIN documents ON documents.id = ec.document_id
      WHERE eg.profile_id = ${embeddingProfiles.id} AND (ec.generation_id <> de.generation_id OR NOT (${sameScope} AND ${docPredicate})))
  `)!;
}

export async function requireProfile(db: Database, authority: ResourceAuthority, id: string) {
  await requireResource(db, authority, "profile", id);
  const [profile] = await db.select().from(embeddingProfiles).where(and(eq(embeddingProfiles.id, id), profileResourcePredicate(authority)));
  if (!profile) throw new NotFoundError("Resource not found");
  return profile;
}
