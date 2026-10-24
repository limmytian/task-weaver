import { z } from 'zod';

export const acknowledgeExecutionControlSchema = z.object({
  phase: z.enum(['received', 'stopping', 'stopped', 'reconciling', 'blocked', 'manual']),
  revision: z.number().int().nonnegative(),
  workspace: z.object({ path: z.string().max(4096).optional(), state: z.string().max(100).optional(), summary: z.string().max(4000).optional(), nodeId: z.string().max(255).optional() }).optional(),
});
export const executionAuthoritySchema = z.object({ requirementId: z.string().uuid(), runId: z.string().uuid(), leaseGeneration: z.number().int() });
export const executionSynchronizationSchema = executionAuthoritySchema.extend({
  repositoryId: z.string().uuid(), remoteTip: z.string().regex(/^[0-9a-f]{40,64}$/), localHead: z.string().regex(/^[0-9a-f]{40,64}$/), fetchedAt: z.coerce.date<Date>(),
});
export const executionRevalidationSchema = z.object({ reason: z.string().trim().min(1).max(4000), expectedPlanRevision: z.number().int().nonnegative() });
export const executionRecoveryDecisionSchema = executionRevalidationSchema.extend({ controlId: z.string().uuid() });

export const resumeExecutionControlSchema = z.object({ workerIndex: z.number().int().min(0).max(255).optional() });
