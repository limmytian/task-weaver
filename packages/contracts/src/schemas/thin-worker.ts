import { z } from 'zod';
import { stagedPlanSchema } from './plans';

export const workerModeSchema = z.object({ projectId: z.string().uuid(), mode: z.enum(['legacy', 'thin']), inspection: z.string().trim().min(10).max(2000) }).strict();
export const workerAcquireSchema = z.object({ projectId: z.string().uuid(), workerId: z.string().uuid(), nodeId: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/), executor: z.literal('codex'), model: z.string().trim().min(1).max(200), durationSeconds: z.number().int().min(30).max(900).default(120) }).strict();
export const workerPresenceSchema = z.object({ projectId: z.string().uuid(), workerId: z.string().uuid(), nodeId: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/) }).strict();
export const workerFenceSchema = z.object({ attemptId: z.string().uuid(), workerId: z.string().uuid(), token: z.string().regex(/^twa_[0-9a-f]{64}$/) }).strict();
export const workerHeartbeatSchema = workerFenceSchema.extend({ durationSeconds: z.number().int().min(30).max(900).default(120) }).strict();
export const workerOutputSchema = workerFenceSchema.extend({ documentId: z.string().uuid(), summary: z.string().trim().min(1).max(1000) }).strict();
export const workerPlanSchema = workerFenceSchema.extend({ operationKey: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), plan: stagedPlanSchema }).strict();
export const workerAcceptanceDecisionSchema = z.object({ decision: z.enum(['accept', 'changes_requested']), summary: z.string().trim().min(1).max(2000) }).strict();
export const workerReleaseSchema = workerFenceSchema.extend({ resultKey: z.string().uuid(), reason: z.string().trim().min(1).max(4000) }).strict();
export const workerResolveSchema = z.object({ attemptId: z.string().uuid(), disposition: z.enum(['retry', 'review']), reason: z.string().trim().min(10).max(2000), retrySafe: z.boolean().default(false) }).strict().refine(value => value.disposition !== 'retry' || value.retrySafe, 'Explicit retry safety assessment is required');
export const workerResultSchema = workerFenceSchema.extend({ resultKey: z.string().uuid(), outcome: z.enum(['done', 'attention']), summary: z.string().trim().min(1).max(4000), outputId: z.string().uuid().optional(), acceptanceDecision: z.enum(['accept', 'changes_requested']).optional() }).strict().refine(value => value.outcome !== 'done' || value.outputId, 'A verified output is required').refine(value => value.acceptanceDecision !== 'changes_requested' || value.outcome === 'attention', 'Requested changes require review');
