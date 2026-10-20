import { mkdir, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, dirname } from "node:path";
import { and, eq } from "drizzle-orm";
import { type Database, skillPackageFiles, skillPackageStorageObjects, skillPackageVersions } from "@task-weaver/db";
import { AuthorizationError, ConflictError, ValidationError, runSkillCapabilitySchema, type VerifiedRequestContext } from "@task-weaver/contracts";
import { resourceAuthority, requireScope, personalResourceOwnerId } from "../services/resource-authorization";
import { requirePackage } from "../services/asset-authorization";
import { mcpPolicy, mcpScopeKey } from "../services/mcp-security";
import { capabilityDigest } from "../services/capability-digest";
import { sha256Hex, type SkillPackageStorageAdapter } from "../services/skill-package-storage";
import { configuredSkillRuntimes, executeIsolatedSkill } from "../services/skill-runtime";
import { resolveMcpSkill } from "./skill-resolution";
import { readMcpSkill } from "./discovery";
import { DeferredMcpOperation } from "./security";

/** The temporary tree contains only authorized pinned bytes, never host credentials. */
export async function prepareSkillExecution(db: Database, liveDb: Database, identity: VerifiedRequestContext, raw: Record<string, unknown>, storage: SkillPackageStorageAdapter | undefined, config: string | undefined, signal: AbortSignal) {
  const input = runSkillCapabilitySchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(input.input)) > 16384) throw new ValidationError("Skill input exceeds the 16384-byte limit");
  if (!storage) throw new ValidationError("Skill package storage is unavailable");
  const authority = await resourceAuthority(db, identity);
  await requirePackage(db, authority, input.packageId);
  const scope = input.scope === "personal" ? { personalOwnerId: personalResourceOwnerId(identity), personalOwnerType: "human" as const }
    : input.scope === "global" ? {} : { projectId: input.projectId! };
  requireScope(authority, scope, "mcp.invoke");
  requireScope(authority, scope, "resource.write");
  const manifest = await resolveMcpSkill(db, identity, input, signal);
  if (manifest.manifestHash !== input.manifestHash) throw new ConflictError("Resolve the current skill manifest before execution", 0);
  if (manifest.root.executionMode !== "isolated" || !manifest.root.runtime) throw new ValidationError("This skill requires instructions or an explicit local bridge, not hosted execution");
  const profile = configuredSkillRuntimes(config).find(item => item.id === manifest.root.runtime!.profileId);
  if (!profile) throw new ValidationError("The declared runtime profile is not configured");
  if (profile.image !== input.runtimeImage || capabilityDigest(profile) !== input.runtimeProfileHash) throw new ConflictError("The trusted runtime profile changed; inspect it before confirming execution", 0);
  const directory = await mkdtemp(join(tmpdir(), "tw-skill-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await chmod(directory, 0o755);
    let bytes = 0, fileCount = 0;
    const paths: Record<string, string> = {};
    const write = async (base: string, path: string, body: Buffer) => {
      signal.throwIfAborted();
      const target = resolve(base, path);
      if (!target.startsWith(base + sep) || path.split(/[\\/]/).filter(Boolean).length > 32) throw new ValidationError("Skill file escapes its package directory or exceeds the path-depth limit");
      if (++fileCount > 256 || (bytes += body.length) > 8_388_608) throw new ValidationError("Skill materialization exceeds its file or byte budget");
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, body, { mode: 0o444, flag: "wx" });
    };
    let scriptFound = false;
    for (const node of manifest.nodes) {
      signal.throwIfAborted();
      if (node.reference.kind === "skill_package") {
        const relative = node.reference.id === input.packageId ? "root" : `packages/${node.reference.id}`;
        const base = join(directory, relative);
        paths[node.reference.id] = `/work/${relative}`;
        const [version] = await db.select({ id: skillPackageVersions.id }).from(skillPackageVersions).where(and(eq(skillPackageVersions.packageId, node.reference.id), eq(skillPackageVersions.version, node.version), eq(skillPackageVersions.status, "active")));
        if (!version) throw new ConflictError("Pinned skill package is no longer available", 0);
        const files = await db.select({ path: skillPackageFiles.path, sha256: skillPackageFiles.sha256, size: skillPackageFiles.sizeBytes, key: skillPackageStorageObjects.objectKey, backend: skillPackageStorageObjects.storageBackend }).from(skillPackageFiles).innerJoin(skillPackageStorageObjects, eq(skillPackageStorageObjects.id, skillPackageFiles.storageObjectId)).where(eq(skillPackageFiles.packageVersionId, version.id)).limit(257);
        for (const file of files) {
          if (file.backend !== storage.backend || file.size > 8_388_608 - bytes) throw new ValidationError("Pinned skill storage is unavailable or exceeds the byte budget");
          const object = await storage.getObject(file.key);
          const chunks: Buffer[] = []; let length = 0;
          for await (const chunk of object.body) {
            signal.throwIfAborted();
            const buffer = Buffer.from(chunk); length += buffer.length;
            if (length > 8_388_608 - bytes) throw new ValidationError("Skill storage exceeds its materialization budget");
            chunks.push(buffer);
          }
          const content = Buffer.concat(chunks);
          if (sha256Hex(content) !== file.sha256) throw new ConflictError("Pinned skill file failed its content hash", 0);
          await write(base, file.path, content);
          if (relative === "root" && file.path === manifest.root.runtime.scriptPath) scriptFound = true;
        }
      } else if (node.reference.kind === "skill") {
        const record = await readMcpSkill(db, identity, node.reference.id, Number(node.version));
        const relative = `skills/${node.reference.id}`;
        paths[node.reference.id] = `/work/${relative}`;
        await write(join(directory, relative), "SKILL.md", Buffer.from(record.content));
      }
    }
    if (!scriptFound) throw new ValidationError("The declared script is missing from the pinned package");
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ ...manifest, paths }), { mode: 0o444 });
    const recheck = async (full = false) => {
      const live = await resourceAuthority(liveDb, identity);
      await requirePackage(liveDb, live, input.packageId);
      requireScope(live, scope, "resource.write");
      requireScope(live, scope, "mcp.invoke");
      if ((await mcpPolicy(liveDb, mcpScopeKey(scope), "tw_skills_run")).mode === "deny") throw new AuthorizationError();
      if (full && (await resolveMcpSkill(liveDb, identity, input, signal)).manifestHash !== input.manifestHash) throw new ConflictError("Pinned skill dependencies changed during execution", 0);
    };
    return new DeferredMcpOperation(async () => {
      const revoked = new AbortController();
      const runningSignal = AbortSignal.any([signal, revoked.signal]);
      let checking = false;
      const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void recheck().catch(() => revoked.abort()).finally(() => { checking = false; });
      }, 1000);
      timer.unref();
      try {
        await recheck(true);
        const result = await executeIsolatedSkill(profile, directory, manifest.root.runtime!.scriptPath, input.input, runningSignal);
        await recheck(true);
        // Reserve room for both MCP text and structured envelopes, including escaped control characters.
        while (Buffer.byteLength(JSON.stringify(result)) > 65536) {
          const field = result.stdout.length >= result.stderr.length ? "stdout" : "stderr";
          result[field] = Array.from(result[field]).slice(0, Math.floor(result[field].length / 2)).join("");
          result.outputTruncated = true; result.status = "failed";
        }
        return { ...result, manifestHash: input.manifestHash, remoteToolsInvoked: false, outputIsUntrusted: true };
      } finally { clearInterval(timer); }
    }, dispose);
  } catch (error) { await dispose(); throw error; }
}
