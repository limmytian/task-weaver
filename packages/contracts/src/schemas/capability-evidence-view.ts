import { z } from 'zod';
import { capabilityKindSchema } from './capabilities';
export const capabilityEvidenceQuerySchema = z.object({ projectId: z.string().uuid(), days: z.coerce.number<number>().int().min(1).max(7).default(7), limit: z.coerce.number<number>().int().min(1).max(20).default(20), offset: z.coerce.number<number>().int().min(0).max(10000).default(0) }).strict();
const action = z.enum(['read', 'inspect', 'resolve', 'invoke', 'save']);
const outcome = z.enum(['observed', 'error', 'unknown']);
export const capabilityEvidenceViewSchema = z.object({
  schemaVersion: z.literal(1), projectId: z.string().uuid(), since: z.string().datetime(), observedAt: z.string().datetime(),
  grouping: z.literal('unique_visible_references'), totalVisibleReferences: z.number().int().nonnegative(), reportedProgressReferences: z.number().int().nonnegative(),
  coverage: z.object({ complete: z.literal(false), discovery: z.literal('unknown'), taskUsefulness: z.literal('not_measured'), modelCost: z.null(), contextTokens: z.null() }),
  summary: z.array(z.object({ action, outcome, references: z.number().int().nonnegative() })),
  items: z.array(z.object({ id: z.string().uuid(), kind: capabilityKindSchema, assetId: z.string().uuid(), action, outcome,
    runId: z.string().uuid().nullable(), attribution: z.enum(['run', 'credential']), recordedAt: z.string().datetime(),
    assetVersion: z.string().max(100).nullable(), assetHashKind: z.enum(['content', 'file', 'manifest_graph', 'tool_schema']).nullable(), assetSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    sourceFreshness: z.enum(['current', 'changed', 'not_applicable']).nullable(), durationMs: z.number().int().nonnegative().nullable(),
  })).max(20),
});
export type CapabilityEvidenceView = z.infer<typeof capabilityEvidenceViewSchema>;
