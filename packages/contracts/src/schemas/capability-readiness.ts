import { z } from 'zod';
import { capabilityAvailabilitySchema, capabilityKindSchema } from './capabilities';
export const projectCapabilityReadinessQuerySchema = z.object({ projectId: z.string().uuid() });
export const projectCapabilityReadinessSchema = z.object({
  schemaVersion: z.literal(1), projectId: z.string().uuid(), observedAt: z.string().datetime(),
  scope: z.literal('selected_project_only'), readPermission: z.literal('granted'), invokePermission: z.enum(['granted', 'missing']),
  inventory: z.array(z.discriminatedUnion('access', [
    z.object({ kind: capabilityKindSchema, access: z.literal('granted'), registered: z.number().int().nonnegative(), contentCandidates: z.number().int().nonnegative(), inspectionRequired: z.literal(true) }),
    z.object({ kind: capabilityKindSchema, access: z.literal('missing'), registered: z.null(), contentCandidates: z.null(), inspectionRequired: z.literal(true) }),
  ])).length(4),
  hostedExecution: capabilityAvailabilitySchema.nullable(), runtimeSource: z.literal('api'), runtimeObservation: z.enum(['api_profile_state', 'not_observed_for_current_permissions']),
  checklist: z.array(z.string().max(500)).max(8),
});
export type ProjectCapabilityReadiness = z.infer<typeof projectCapabilityReadinessSchema>;
