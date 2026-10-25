import { z } from 'zod';

export const recoveryActionBlockSchema = z.enum(['human_required', 'write_permission_required', 'management_permission_required', 'evidence_current', 'requirement_closed', 'no_control', 'already_decided', 'replacement_owns_lane']);
const action = z.object({ allowed: z.boolean(), blockedReason: recoveryActionBlockSchema.nullable() });
export const executionRecoveryViewSchema = z.object({
  observedAt: z.string().datetime(),
  planRevision: z.number().int().nonnegative(),
  evidenceNeedsReview: z.boolean(),
  lane: z.object({ state: z.enum(['held', 'not_held']), runId: z.string().uuid().nullable(), expiresAt: z.string().datetime().nullable(), executionAuthority: z.literal('not_established'), fleetCapacity: z.null(), daemonHealth: z.literal('not_observed') }),
  retry: z.object({ used: z.number().int().nonnegative(), remaining: z.number().int().nonnegative(), maximum: z.number().int().nonnegative(), automaticRetrySafe: z.boolean() }),
  controls: z.array(z.object({
    id: z.string().uuid(), runId: z.string().uuid(), daemonId: z.string().uuid(), revision: z.number().int().nonnegative(),
    phase: z.enum(['pending', 'received', 'stopping', 'stopped', 'reconciling', 'resumed', 'blocked', 'manual']),
    reason: z.string(), deadline: z.string().datetime(), deadlinePassed: z.boolean(),
    nodeId: z.string().nullable(), preservedState: z.string().nullable(),
    stopObservation: z.enum(['reported_in_current_phase', 'not_established']),
    observations: z.array(z.object({ kind: z.enum(['created', 'latest_phase']), at: z.string().datetime() })),
    updatedAt: z.string().datetime(),
  })).max(10),
  actions: z.object({ revalidate: action, recover: action.extend({ controlId: z.string().uuid().nullable(), expectedControlUpdatedAt: z.string().datetime().nullable() }) }),
});
export type ExecutionRecoveryView = z.infer<typeof executionRecoveryViewSchema>;
