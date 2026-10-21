import type { Database } from "@task-weaver/db";
import { AuthorizationError, ConflictError, ValidationError, type PluginManifest, type VerifiedRequestContext } from "@task-weaver/contracts";
import { readMcpSkill } from "../mcp-server/discovery";
import { capabilityDigest } from "./capability-digest";
import type { ResourceScope } from "./resource-authorization";

export type PluginSkillSnapshot = {
  name: string; documentId: string; version: number; contentHash: string;
  content: string; untrusted: true;
};

/** Read-only inputs reuse the common skill facade; bindings never grant authority. */
export async function resolvePluginSkills(db: Database, identity: VerifiedRequestContext, manifest: PluginManifest, scope: ResourceScope): Promise<PluginSkillSnapshot[]> {
  const snapshots: PluginSkillSnapshot[] = [];
  for (const binding of manifest.skillBindings ?? []) {
    const skill = await readMcpSkill(db, identity, binding.documentId, binding.version);
    // A plugin must not copy a wider caller's private context into a shared namespace.
    if (skill.projectId ? skill.projectId !== scope.projectId
      : skill.personalOwnerId ? skill.personalOwnerId !== scope.personalOwnerId || skill.personalOwnerType !== scope.personalOwnerType
      : false) throw new AuthorizationError();
    if (capabilityDigest({ content: skill.content }) !== binding.contentHash) throw new ConflictError("Pinned plugin skill content changed", skill.version);
    snapshots.push({ ...binding, content: skill.content, untrusted: true });
    if (Buffer.byteLength(JSON.stringify(snapshots)) > 32768) throw new ValidationError("Plugin skill snapshots exceed the 32768-byte aggregate budget");
  }
  return snapshots;
}
