import {
  AuthorizationError, NotFoundError, ValidationError, ConflictError,
  CAPABILITY_LIMITS, capabilityStableId, capabilityManifestSchema,
  type CapabilityManifest, type CapabilityReference,
} from "@task-weaver/contracts";

export type CapabilityLoader = (reference: CapabilityReference, version?: string) => Promise<CapabilityManifest>;

/** No loader may grant access from a pin; resolve again under the current caller. */
export async function resolveCapabilityGraph(root: CapabilityReference, version: string | undefined, load: CapabilityLoader) {
  const resolved = new Map<string, CapabilityManifest>();
  const attempted = new Set<string>();
  const nodes: CapabilityManifest[] = [];
  const unavailable: Array<{ reference: CapabilityReference; required: false; reason: "unavailable" }> = [];
  async function visit(reference: CapabilityReference, requestedVersion: string | undefined, ancestors: Set<string>, required = true) {
    const key = capabilityStableId(reference);
    if (ancestors.has(key)) throw new ValidationError("Capability dependencies contain a cycle");
    const previous = resolved.get(key);
    if (previous) {
      if (requestedVersion && requestedVersion !== previous.version) throw new ConflictError("Capability dependencies require conflicting versions", 0);
      return;
    }
    if (ancestors.size >= 16 || !attempted.has(key) && attempted.size >= CAPABILITY_LIMITS.manifestEntries) throw new ValidationError("Capability dependency graph exceeds its node or depth limit");
    if (attempted.has(key)) {
      if (required) throw new NotFoundError("Required capability is unavailable");
      return;
    }
    attempted.add(key);
    let manifest: CapabilityManifest;
    try { manifest = capabilityManifestSchema.parse(await load(reference, requestedVersion)); }
    catch (error) {
      if (!required && (error instanceof NotFoundError || error instanceof AuthorizationError)) {
        unavailable.push({ reference, required: false, reason: "unavailable" }); return;
      }
      throw error;
    }
    if (capabilityStableId(manifest.reference) !== key || requestedVersion && requestedVersion !== manifest.version) throw new ConflictError("Resolved capability does not match its requested identity or version", 0);
    resolved.set(key, manifest);
    const path = new Set(ancestors).add(key);
    for (const dependency of manifest.dependencies) await visit(dependency.reference, dependency.version, path, dependency.required);
    nodes.push(manifest);
  }
  await visit(root, version, new Set());
  return { root: resolved.get(capabilityStableId(root))!, nodes, unavailable, authorization: "recheck_each_operation" as const };
}
