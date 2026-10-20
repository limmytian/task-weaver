import { z } from "zod";
import { skillPackagePathSchema } from "./skill-packages";
import { mcpServerReadTools } from "./mcp-server";

export const CAPABILITY_LIMITS = Object.freeze({
  results: 20,
  dependencies: 32,
  manifestEntries: 100,
  bootstrapBytes: 4096,
  summaryBytes: 16384,
});

export const capabilityKindSchema = z.enum(["skill", "skill_package", "memory", "mcp_tool", "plugin"]);
export const capabilityReferenceSchema = z.object({
  kind: capabilityKindSchema,
  id: z.string().uuid(),
}).strict();

/** A stable reference is an address, never a grant or permission to execute. */
export function capabilityStableId(reference: z.infer<typeof capabilityReferenceSchema>): string {
  const parsed = capabilityReferenceSchema.parse(reference);
  return `tw:${parsed.kind}:${parsed.id.toLowerCase()}`;
}

export const capabilityScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("project"), projectId: z.string().uuid() }).strict(),
  // Personal owner identity is resolved from the credential, not supplied by a client.
  z.object({ kind: z.literal("personal") }).strict(),
]);

export const discoverCapabilitiesSchema = z.object({
  intent: z.string().trim().min(1).max(500),
  scope: capabilityScopeSchema,
  includeGlobal: z.boolean().default(true),
  kinds: z.array(capabilityKindSchema).min(1).max(5).default(["skill", "skill_package", "memory", "mcp_tool"]),
  limit: z.number().int().min(1).max(CAPABILITY_LIMITS.results).default(5),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.kinds).size !== value.kinds.length) {
    ctx.addIssue({ code: "custom", path: ["kinds"], message: "Capability kinds must be unique" });
  }
});

export const capabilityExecutionModeSchema = z.enum(["instructions", "remote", "isolated", "local_required"]);
const exactVersion = z.string().trim().min(1).max(100).refine(
  value => !/^(latest|next|stable|head|main|master)$/i.test(value) && !/[\s*^~<>=|]/.test(value),
  "Execution dependencies require an exact immutable version",
);
export const capabilityAvailabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), executionMode: capabilityExecutionModeSchema }).strict(),
  z.object({
    state: z.literal("unavailable"),
    reason: z.enum(["not_implemented", "not_configured", "dependency_missing", "local_bridge_required", "approval_required", "unhealthy", "unsupported_client"]),
    remediation: z.string().min(1).max(500),
  }).strict(),
]);

export const capabilityDependencySchema = z.object({
  reference: capabilityReferenceSchema,
  required: z.boolean().default(true),
  // Exact immutable versions replace floating ranges before execution.
  version: exactVersion.optional(),
}).strict();

export const capabilityManifestSchema = z.object({
  schemaVersion: z.literal(1),
  reference: capabilityReferenceSchema,
  scope: capabilityScopeSchema,
  version: exactVersion,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  executionMode: capabilityExecutionModeSchema,
  entryPath: skillPackagePathSchema.optional(),
  dependencies: z.array(capabilityDependencySchema).max(CAPABILITY_LIMITS.dependencies).default([]),
}).strict().superRefine((value, ctx) => {
  const references = new Set<string>();
  for (const [index, dependency] of value.dependencies.entries()) {
    const key = capabilityStableId(dependency.reference);
    if (key === capabilityStableId(value.reference) || references.has(key)) {
      ctx.addIssue({ code: "custom", path: ["dependencies", index], message: "Dependencies must be unique and cannot reference the capability itself" });
    }
    references.add(key);
    if (["skill_package", "plugin"].includes(dependency.reference.kind) && !dependency.version) {
      ctx.addIssue({ code: "custom", path: ["dependencies", index, "version"], message: "Package and plugin dependencies require an exact version" });
    }
  }
});

export type CapabilityReference = z.infer<typeof capabilityReferenceSchema>;
export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;
export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;
export type CapabilityAvailability = z.infer<typeof capabilityAvailabilitySchema>;
export type DiscoverCapabilitiesInput = z.infer<typeof discoverCapabilitiesSchema>;

export const capabilityBootstrapSchema = z.object({
  schemaVersion: z.literal(1),
  transport: z.literal("stdio or Streamable HTTP"),
  guidance: z.string().min(1).max(2000),
  tools: z.array(z.enum(mcpServerReadTools)).max(12),
  capabilities: z.object({
    skills: capabilityAvailabilitySchema,
    skillPackages: capabilityAvailabilitySchema,
    memories: capabilityAvailabilitySchema,
    externalTools: capabilityAvailabilitySchema,
    hostedExecution: capabilityAvailabilitySchema,
    plugins: capabilityAvailabilitySchema,
  }).strict(),
  loading: z.object({
    strategy: z.literal("on_demand"),
    maxSummaryResults: z.literal(CAPABILITY_LIMITS.results),
    maxSummaryBytes: z.literal(CAPABILITY_LIMITS.summaryBytes),
    maxDependencyNodes: z.literal(CAPABILITY_LIMITS.manifestEntries),
  }).strict(),
  authorization: z.literal("recheck_each_operation"),
}).strict();

export type CapabilityBootstrap = z.infer<typeof capabilityBootstrapSchema>;
