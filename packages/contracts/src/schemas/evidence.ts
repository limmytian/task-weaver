import { z } from "zod";

/** Upper bounds for the first version of the evidence protocol. */
export const evidenceLimits = {
  previewBytes: 256 * 1024,
  mediaPreviewBytes: 10 * 1024 * 1024,
  verifiedArtifactBytes: 100 * 1024 * 1024,
  diffBytes: 1024 * 1024,
  diffFiles: 200,
  tableRows: 100,
  tableColumns: 50,
  nodeConcurrency: 2,
  chunkBytes: 64 * 1024,
  requestDurationMs: 30_000,
} as const;

export const evidenceAvailabilitySchema = z.enum(["available", "offline", "missing", "changed", "retired", "unsupported", "too_large"]);
const id = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const base = {
  outputId: id,
  projectId: id,
  requirementId: id,
  availability: evidenceAvailabilitySchema,
};
/** Public descriptors contain identities, never node paths or arbitrary URLs. */
export const evidenceDescriptorSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("unsupported"), availability: z.enum(["unsupported", "retired"]) }).strict(),
  z.object({ ...base, kind: z.literal("local"), nodeId: z.string().min(1).max(255), sizeBytes: z.number().int().nonnegative().safe(), sha256, originalFilename: z.string().max(255).optional(), mimeType: z.string().max(255).optional() }).strict(),
  z.object({ ...base, kind: z.literal("attachment"), documentId: id, fileVersionId: id, fileVersion: z.number().int().positive(), mimeType: z.string().max(255), originalFilename: z.string().max(255), sizeBytes: z.number().int().nonnegative().safe(), sha256 }).strict(),
  z.object({ ...base, kind: z.literal("git"), requirementRepositoryId: id, headCommit: oid }).strict(),
]);
/** Browser requests identify only a registered output; no path or remote is accepted. */
export const evidenceReadRequestSchema = z.object({ outputId: id, purpose: z.enum(["preview", "download", "promotion"]) }).strict();
/** Short-lived producer demand, bound to a single authenticated daemon and immutable manifest. */
export const evidenceNodeDemandSchema = z.object({
  requestId: id, outputId: id, projectId: id, requirementId: id, daemonId: id,
  nodeId: z.string().min(1).max(255), nonce: z.string().regex(/^[a-f0-9]{64}$/),
  purpose: z.enum(["preview", "download", "promotion"]),
  sizeBytes: z.number().int().nonnegative().max(evidenceLimits.verifiedArtifactBytes), sha256,
  expiresAt: z.string().datetime(),
}).strict();
/** One ordered bounded transport frame. Authorization and exact sequence are server state. */
export const evidenceNodeChunkSchema = z.object({
  requestId: id, daemonId: id, outputId: id, nonce: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().nonnegative(),
  contentBase64: z.string().max(Math.ceil(evidenceLimits.chunkBytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export const evidenceNodeResultSchema = z.object({
  requestId: id, daemonId: id, outputId: id, nonce: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().nonnegative(), final: z.boolean(),
  state: evidenceAvailabilitySchema,
  verifiedSizeBytes: z.number().int().nonnegative().max(evidenceLimits.verifiedArtifactBytes).optional(),
  verifiedSha256: sha256.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.state === "available" && value.final && (value.verifiedSizeBytes === undefined || !value.verifiedSha256)) {
    ctx.addIssue({ code: "custom", message: "A final available response requires a full size and checksum" });
  }
});
export type EvidenceDescriptor = z.infer<typeof evidenceDescriptorSchema>;
export type EvidenceNodeDemand = z.infer<typeof evidenceNodeDemandSchema>;
export type EvidenceNodeResult = z.infer<typeof evidenceNodeResultSchema>;

/** Signed registration bytes bind one immutable local manifest to a node key. */
export function evidenceRegistrationPayload(input: { requirementId: string; nodeId: string; relativePath: string; sizeBytes: number; sha256: string }): string {
  return JSON.stringify(['task-weaver:evidence-registration:v1', input.requirementId, input.nodeId, input.relativePath, input.sizeBytes, input.sha256]);
}

export function evidenceDemandPayload(raw: EvidenceNodeDemand): string {
  const demand = evidenceNodeDemandSchema.parse(raw);
  return JSON.stringify(['task-weaver:evidence-read:v1', demand.requestId, demand.outputId, demand.projectId, demand.requirementId, demand.daemonId, demand.nodeId, demand.nonce, demand.purpose, demand.sizeBytes, demand.sha256, demand.expiresAt]);
}
