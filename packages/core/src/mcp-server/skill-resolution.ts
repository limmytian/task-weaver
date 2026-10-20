import { and, desc, eq } from "drizzle-orm";
import { skillPackages, skillPackageVersions, mcpServers, type Database } from "@task-weaver/db";
import { NotFoundError, ValidationError, CAPABILITY_LIMITS, skillCapabilityDeclarationSchema, type VerifiedRequestContext, type CapabilityScope, type CapabilityManifest } from "@task-weaver/contracts";
import { requirePackage } from "../services/asset-authorization";
import { resourceAuthority } from "../services/resource-authorization";
import { createResourceServices } from "../services/resource-services";
import { capabilityDigest } from "../services/capability-digest";
import { readMcpSkill } from "./discovery";
import { resolveCapabilityGraph } from "./capability-graph";
import { McpToolFailure } from "./index";

function scopeOf(value: { projectId?: string | null; personalOwnerId?: string | null }): CapabilityScope {
  return value.projectId ? { kind: "project", projectId: value.projectId } : value.personalOwnerId ? { kind: "personal" } : { kind: "global" };
}

export async function resolveMcpSkill(db: Database, identity: VerifiedRequestContext, input: { packageId: string; version?: string }, signal: AbortSignal) {
  const authority = await resourceAuthority(db, identity);
  const result = await resolveCapabilityGraph({ kind: "skill_package", id: input.packageId }, input.version, async (reference, version): Promise<CapabilityManifest> => {
    signal.throwIfAborted();
    if (reference.kind === "skill_package") {
      await requirePackage(db, authority, reference.id);
      const [pkg] = await db.select({ id: skillPackages.id, projectId: skillPackages.projectId, personalOwnerId: skillPackages.personalOwnerId }).from(skillPackages).where(and(eq(skillPackages.id, reference.id), eq(skillPackages.status, "active")));
      const [record] = await db.select({ version: skillPackageVersions.version, manifest: skillPackageVersions.manifest, fileManifest: skillPackageVersions.fileManifest, entryPath: skillPackageVersions.entryPath }).from(skillPackageVersions).where(and(eq(skillPackageVersions.packageId, reference.id), eq(skillPackageVersions.status, "active"), version ? eq(skillPackageVersions.version, version) : undefined)).orderBy(desc(skillPackageVersions.createdAt), skillPackageVersions.id).limit(1);
      if (!pkg || !record) throw new NotFoundError("Resource not found");
      const declaration = skillCapabilityDeclarationSchema.parse(record.manifest.capabilities ?? {});
      return { schemaVersion: 1, reference, scope: scopeOf(pkg), version: record.version, sha256: capabilityDigest({ entryPath: record.entryPath, declaration, files: record.fileManifest }), entryPath: record.entryPath, ...declaration };
    }
    if (reference.kind === "skill") {
      if (version !== undefined && !/^[1-9]\d*$/.test(version)) throw new ValidationError("Skill document dependencies require a positive integer revision");
      const skill = await readMcpSkill(db, identity, reference.id, version === undefined ? undefined : Number(version));
      return { schemaVersion: 1, reference, scope: scopeOf(skill), version: String(skill.version), sha256: capabilityDigest({ content: skill.content }), executionMode: "instructions", dependencies: [] };
    }
    if (reference.kind === "mcp_tool") {
      const tool = await createResourceServices(identity).mcpRegistryService.getToolDetail(db, reference.id);
      const [server] = await db.select({ projectId: mcpServers.projectId, personalOwnerId: mcpServers.personalOwnerId }).from(mcpServers).where(eq(mcpServers.id, tool.serverId));
      if (!server) throw new NotFoundError("Resource not found");
      const sha256 = capabilityDigest({ name: tool.name, inputSchema: tool.inputSchema, readOnly: tool.readOnly, targetProjectArgument: tool.targetProjectArgument });
      return { schemaVersion: 1, reference, scope: scopeOf(server), version: `schema-${sha256}`, sha256, executionMode: "remote", dependencies: [] };
    }
    throw new NotFoundError("Capability is not available for skill resolution");
  });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 65536) throw new McpToolFailure("result_too_large", "Resolved capability manifest exceeds the 65536-byte limit.");
  return { ...result, maxNodes: CAPABILITY_LIMITS.manifestEntries, instructionsOnly: result.nodes.every(node => node.executionMode === "instructions"), executionAuthorized: false };
}
