import { mkdtemp, mkdir, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { type Database, skillPackageVersions, skillPackageFiles, skillPackageStorageObjects } from "@task-weaver/db";
import { ConflictError, ValidationError, pluginBackendResultSchema, skillPackagePathSchema, type PluginManifest, type VerifiedRequestContext } from "@task-weaver/contracts";
import { resolveMcpSkill } from "../mcp-server/skill-resolution";
import { resourceAuthority } from "./resource-authorization";
import { requirePackage } from "./asset-authorization";
import { capabilityDigest } from "./capability-digest";
import { configuredSkillRuntimes, executeIsolatedSkill } from "./skill-runtime";
import { verifyPluginManifest, type PluginTrustKey } from "./plugin-trust";
import { sha256Hex, type SkillPackageStorageAdapter } from "./skill-package-storage";
import { compilePluginFrontend } from "./plugin-frontend";
import type { PluginExecution } from "./plugin-broker";

export type PluginWorkerConfiguration = { profiles?: string; keys: Readonly<Record<string, PluginTrustKey>>; allowUnverified?: boolean; frontendAvailable?: boolean };
const inventorySchema = z.object({ files: z.array(z.object({ path: skillPackagePathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().min(0) })).max(256) });
let activeWorkers = 0;
let preparedWorkers = 0;

/** Prepare only pinned original bytes. The caller supplies operator configuration, never request fields. */
export async function preparePluginWorker(db: Database, identity: VerifiedRequestContext, manifest: PluginManifest, storage: SkillPackageStorageAdapter,
  configuration: () => PluginWorkerConfiguration, signal: AbortSignal): Promise<PluginExecution> {
  const expectedHash = capabilityDigest(manifest);
  const revalidate = async (connection: Database = db, checkSignal: AbortSignal = signal) => {
    checkSignal.throwIfAborted();
    const config = configuration();
    verifyPluginManifest(manifest, config.keys, config.allowUnverified);
    const profile = configuredSkillRuntimes(config.profiles).find(item => item.id === manifest.backend?.profileId);
    if (!profile || capabilityDigest(profile) !== manifest.backend?.profileHash) throw new ValidationError("The approved plugin runtime profile is unavailable or changed");
    await requirePackage(connection, await resourceAuthority(connection, identity), manifest.artifact.packageId);
    const resolved = await resolveMcpSkill(connection, identity, { packageId: manifest.artifact.packageId, version: manifest.artifact.version }, checkSignal);
    if (resolved.manifestHash !== manifest.artifact.manifestHash) throw new ConflictError("Plugin artifact changed or is no longer available", 0);
    // Initial plugin workers do not implicitly execute or materialize dependency graphs.
    if (resolved.nodes.length !== 1 || resolved.root.dependencies.length) throw new ValidationError("Plugin artifacts must be self-contained");
    return profile;
  };
  if (preparedWorkers >= 8) throw new ValidationError("Plugin preparation capacity is busy; retry explicitly later");
  preparedWorkers++;
  let released = false;
  const release = () => { if (!released) { released = true; preparedWorkers--; } };
  let directory: string;
  try {
    await revalidate();
    directory = await mkdtemp(join(tmpdir(), "tw-plugin-"));
  } catch (error) { release(); throw error; }
  const dispose = async () => {
    try { await rm(directory, { recursive: true, force: true }); }
    finally { release(); }
  };
  try {
    await chmod(directory, 0o755);
    const [version] = await db.select().from(skillPackageVersions).where(and(eq(skillPackageVersions.packageId, manifest.artifact.packageId), eq(skillPackageVersions.version, manifest.artifact.version), eq(skillPackageVersions.status, "active")));
    if (!version) throw new ValidationError("Plugin artifact is unavailable");
    const inventory = inventorySchema.parse(version.fileManifest).files;
    if (new Set(inventory.map(file => file.path)).size !== inventory.length) throw new ValidationError("Plugin artifact paths must be unique");
    const files = await db.select({ file: skillPackageFiles, object: skillPackageStorageObjects }).from(skillPackageFiles).innerJoin(skillPackageStorageObjects, eq(skillPackageStorageObjects.id, skillPackageFiles.storageObjectId)).where(eq(skillPackageFiles.packageVersionId, version.id)).limit(257);
    if (files.length !== inventory.length) throw new ValidationError("Plugin artifact inventory is incomplete");
    let total = 0;
    let frontendHtml: string | undefined;
    for (const { file, object } of files) {
      signal.throwIfAborted();
      const declared = inventory.find(item => item.path === file.path);
      if (!declared || declared.sha256 !== file.sha256 || declared.sizeBytes !== file.sizeBytes || object.packageVersionId !== version.id || object.storageBackend !== storage.backend || object.sha256 !== file.sha256 || object.sizeBytes !== file.sizeBytes) throw new ValidationError("Plugin artifact inventory integrity failed");
      const root = join(directory, "root"), target = resolve(root, file.path);
      if (!target.startsWith(root + sep) || file.path.split("/").length > 32) throw new ValidationError("Plugin artifact path escapes its workspace");
      const chunks: Buffer[] = []; let size = 0;
      const stored = await storage.getObject(object.objectKey);
      for await (const chunk of stored.body) {
        signal.throwIfAborted();
        const bytes = Buffer.from(chunk); size += bytes.length; total += bytes.length;
        if (size > file.sizeBytes || total > 8_388_608) throw new ValidationError("Plugin artifact exceeds its materialization budget");
        chunks.push(bytes);
      }
      const content = Buffer.concat(chunks);
      if (size !== file.sizeBytes || sha256Hex(content) !== file.sha256) throw new ValidationError("Plugin artifact content integrity failed");
      if (file.path === manifest.frontend?.entryPath) {
        if (content.byteLength > 131072) throw new ValidationError("Plugin frontend exceeds its artifact byte limit");
        try { frontendHtml = new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { throw new ValidationError("Plugin frontend must be valid UTF-8"); }
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, content, { mode: 0o444, flag: "wx" });
    }
    if (!inventory.some(file => file.path === manifest.backend?.entryPath)) throw new ValidationError("Plugin backend entry is missing from its artifact");
    if (manifest.frontend && frontendHtml === undefined) throw new ValidationError("Plugin frontend entry is missing from its artifact");
    const frontend = frontendHtml === undefined ? undefined : compilePluginFrontend(frontendHtml, manifest);
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ manifestHash: expectedHash }), { mode: 0o444 });
    await revalidate();
    return {
      dispose,
      frontend,
      revalidate: async (connection, checkSignal) => { await revalidate(connection, checkSignal); },
      execute: async (input, runningSignal) => {
        if (activeWorkers >= 4) throw new ValidationError("Plugin worker capacity is busy; retry explicitly later");
        activeWorkers++;
        try {
          const profile = await revalidate();
          const result = await executeIsolatedSkill(profile, directory, manifest.backend!.entryPath, input, runningSignal, 131072);
          await revalidate();
          if (result.status !== "succeeded") throw new ValidationError("Plugin backend failed or exceeded its runtime/output budget");
          let response: unknown;
          try { response = JSON.parse(result.stdout); } catch { throw new ValidationError("Plugin backend must return one bounded JSON response"); }
          return pluginBackendResultSchema.parse(response);
        } finally { activeWorkers--; }
      },
    };
  } catch (error) { await dispose(); throw error; }
}

/** Operator configuration only; never accept profiles, publisher keys or unsigned policy from clients. */
export function configuredPluginWorker(profiles?: string, publisherKeys?: string, allowUnverified = false): PluginWorkerConfiguration {
  if ((publisherKeys?.length ?? 0) > 131072) throw new ValidationError("Plugin publisher configuration exceeds its byte limit");
  let raw: unknown;
  try { raw = JSON.parse(publisherKeys ?? "{}"); } catch { throw new ValidationError("Plugin publisher configuration is invalid"); }
  const parsed = z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), z.object({ publisher: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(100), publicKey: z.string().min(1).max(4096) }).strict()).safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data).length > 32) throw new ValidationError("Plugin publisher configuration is invalid");
  return { profiles, keys: parsed.data, allowUnverified };
}
