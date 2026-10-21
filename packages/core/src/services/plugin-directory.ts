import { z } from "zod";
import { pluginInstallations, type Database } from "@task-weaver/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import { pluginDirectoryEntrySchema, pluginDirectoryReferenceSchema, pluginListQuerySchema, ValidationError, NotFoundError, ConflictError, type PluginManifest, type VerifiedRequestContext } from "@task-weaver/contracts";
import { capabilityDigest } from "./capability-digest";
import { resourceAuthority, canAccessResource, personalResourceOwnerId } from "./resource-authorization";
import { requirePackage } from "./asset-authorization";
import { verifyPluginManifest } from "./plugin-trust";
import { configuredSkillRuntimes, listSkillRuntimes } from "./skill-runtime";
import { preparePluginWorker, type PluginWorkerConfiguration } from "./plugin-worker";
import type { SkillPackageStorageAdapter } from "./skill-package-storage";
import { resolvePluginSkills } from "./plugin-skills";
import { inspectPluginTools } from "./plugin-tools";

type Entry = z.infer<typeof pluginDirectoryEntrySchema>;
export const pluginDirectoryReviewHash = (entry: Omit<Entry, "reviewHash">) => capabilityDigest(entry);

/** The operator curates a bounded catalog; request data cannot select a catalog source. */
export function configuredPluginDirectory(raw?: string): Entry[] {
  if (!raw) return [];
  if (Buffer.byteLength(raw) > 524288) throw new ValidationError("Plugin directory configuration exceeds its byte limit");
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new ValidationError("Plugin directory configuration is invalid"); }
  const entries = z.array(pluginDirectoryEntrySchema).max(20).parse(input);
  if (new Set(entries.map(entry => entry.id)).size !== entries.length || entries.some(({ reviewHash, ...entry }) => reviewHash !== pluginDirectoryReviewHash(entry))) throw new ValidationError("Plugin directory review integrity failed");
  return entries;
}
export function verifyPluginDirectorySelection(raw: string | undefined, reference: z.infer<typeof pluginDirectoryReferenceSchema> | undefined, manifest: PluginManifest) {
  if (!reference) return;
  const entry = configuredPluginDirectory(raw).find(entry => entry.id === reference.entryId);
  if (!entry || entry.reviewHash !== reference.reviewHash || capabilityDigest(entry.manifest) !== capabilityDigest(manifest)) throw new ConflictError("Plugin directory review changed; inspect the current entry before installing", 0);
}

export function createPluginDirectory(db: Database, identity: VerifiedRequestContext, configuration: () => PluginWorkerConfiguration, storage: SkillPackageStorageAdapter) {
  const visible = async () => {
    const entries = configuredPluginDirectory(configuration().directory), authority = await resourceAuthority(db, identity);
    const result: Entry[] = [];
    for (const entry of entries) {
      try { await requirePackage(db, authority, entry.manifest.artifact.packageId); result.push(entry); }
      catch (error) { if (!(error instanceof NotFoundError) && !(error instanceof Error && "code" in error && error.code === "permission_denied")) throw error; }
    }
    return result;
  };
  const summary = (entry: Entry) => {
    let publisherTrust: "verified" | "unverified" | "rejected";
    try { publisherTrust = verifyPluginManifest(entry.manifest, configuration().keys, configuration().allowUnverified).trust; } catch { publisherTrust = "rejected"; }
    return { id: entry.id, pluginId: entry.manifest.pluginId, displayName: entry.manifest.displayName, description: entry.manifest.description, version: entry.manifest.version, maintainer: entry.maintainer, sourceUrl: entry.sourceUrl, sourceRevision: entry.sourceRevision, reviewedAt: entry.reviewedAt, reviewHash: entry.reviewHash, manifestHash: capabilityDigest(entry.manifest), artifactHash: entry.manifest.artifact.manifestHash, publisherTrust, hostProtocol: entry.manifest.schemaVersion, requestedPermissions: entry.manifest.permissions, availability: { state: "not_checked", message: "Inspect this entry for current caller and host readiness. Installation still requires confirmation and preflight." } };
  };
  return {
    list: async (raw: unknown) => {
      const query = pluginListQuerySchema.parse(raw), entries = await visible();
      const items = []; let bytes = 0;
      for (const entry of entries.slice(query.offset, query.offset + query.limit)) {
        const item = summary(entry), size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > 15000) break;
        bytes += size; items.push(item);
      }
      return { items, offset: query.offset, limit: query.limit, hasMore: query.offset + items.length < entries.length, configured: Boolean(configuration().directory) };
    },
    inspect: async (id: string, raw: unknown, signal: AbortSignal) => {
      const query = pluginListQuerySchema.parse(raw), entry = (await visible()).find(entry => entry.id === id);
      if (!entry) throw new NotFoundError("Resource not found");
      const scope = query.scope === "project" ? { projectId: query.projectId } : query.scope === "personal" ? { personalOwnerId: personalResourceOwnerId(identity), personalOwnerType: "human" as const } : {};
      const authority = await resourceAuthority(db, identity);
      const requiredGrants = ["resource.read", "resource.write", "mcp.manage", "mcp.invoke"] as const;
      let ready = false;
      let stage = "grants";
      const failures: Record<string, string> = {
        grants: "Your current space permissions do not allow installation. Request the listed caller grants.",
        installed: "This plugin is already installed in this space. Select its installation below to review upgrades or recovery.",
        publisher: "The publisher is not currently trusted by this instance.",
        frontend: "The dedicated plugin page host is unavailable.",
        runtime: "The pinned runtime profile, image or interpreter is unavailable on the host.",
        artifact: "The pinned artifact is unavailable or failed its integrity check.",
        dependencies: "A required skill, tool or artifact is unavailable in this space.",
        directory: "This directory review changed. Inspect the current entry again.",
      };
      try {
        if (!requiredGrants.every(permission => canAccessResource(authority, scope, permission))) throw new Error("Missing grants");
        stage = "installed";
        const scopePredicate = scope.projectId ? eq(pluginInstallations.projectId, scope.projectId) : scope.personalOwnerId ? and(isNull(pluginInstallations.projectId), eq(pluginInstallations.personalOwnerId, scope.personalOwnerId)) : and(isNull(pluginInstallations.projectId), isNull(pluginInstallations.personalOwnerId));
        const [installed] = await db.select({ id: pluginInstallations.id }).from(pluginInstallations).where(and(scopePredicate, eq(pluginInstallations.pluginId, entry.manifest.pluginId), ne(pluginInstallations.status, "uninstalled"))).limit(1);
        if (installed) throw new Error("Already installed");
        stage = "publisher";
        const config = configuration();
        verifyPluginManifest(entry.manifest, config.keys, config.allowUnverified);
        stage = "frontend";
        if (entry.manifest.frontend && !config.frontendAvailable) throw new Error("Artifact host unavailable");
        stage = "runtime";
        const profile = configuredSkillRuntimes(config.profiles).find(profile => profile.id === entry.manifest.backend?.profileId);
        if (!profile || capabilityDigest(profile) !== entry.manifest.backend?.profileHash) throw new Error("Runtime unavailable");
        const runtimes = await listSkillRuntimes(JSON.stringify([profile]));
        if (!runtimes.items.some(runtime => runtime.availability.state === "available")) throw new Error("Runtime unavailable");
        stage = "artifact";
        const worker = await preparePluginWorker(db, identity, entry.manifest, storage, configuration, signal);
        try {
          stage = "dependencies";
          await resolvePluginSkills(db, identity, entry.manifest, scope);
          await inspectPluginTools(db, identity, entry.manifest, scope);
          await worker.revalidate();
        } finally { await worker.dispose(); }
        stage = "grants";
        const liveAuthority = await resourceAuthority(db, identity);
        if (!requiredGrants.every(permission => canAccessResource(liveAuthority, scope, permission))) throw new Error("Caller authority changed");
        stage = "directory";
        verifyPluginDirectorySelection(configuration().directory, { entryId: entry.id, reviewHash: entry.reviewHash }, entry.manifest);
        ready = true;
      } catch { signal.throwIfAborted(); }
      signal.throwIfAborted();
      return { ...summary(entry), manifest: entry.manifest, requiredGrants, checkedAt: new Date().toISOString(), availability: { state: ready ? "review_required" : "unavailable", reason: ready ? "confirmation_required" : stage, message: ready ? "Current artifact, publisher, runtime and dependency checks passed. Review and confirm installation; backend preflight has not run." : failures[stage] ?? "The entry is unavailable." } };
    },
  };
}
