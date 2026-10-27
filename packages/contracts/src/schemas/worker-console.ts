import { z } from 'zod';

export const consoleLimits = {
  ringBytes: 256 * 1024, frames: 1024, frameBytes: 4096, batchBytes: 32 * 1024,
  ringAgeMs: 60_000, snapshotMs: 15_000, followMs: 10_000, sessionMs: 15 * 60_000,
  sessions: 128, viewersPerRun: 4, peers: 8,
} as const;
export const consoleTargetSchema = z.object({
  requirementId: z.string().uuid(), taskId: z.string().uuid(), runId: z.string().uuid(), workerIndex: z.number().int().min(0),
  leaseGeneration: z.number().int().min(0),
}).strict();
export const consoleOpenSchema = consoleTargetSchema.extend({ follow: z.boolean().default(false) }).strict();
export const consoleFrameSchema = z.object({
  sequence: z.number().int().positive(), stream: z.enum(['stdout', 'stderr']), text: z.string().max(consoleLimits.frameBytes),
}).strict();
export const consoleBatchSchema = z.object({
  revision: z.number().int().nonnegative(), captureId: z.string().uuid(), frames: z.array(consoleFrameSchema).max(consoleLimits.frames),
  firstSequence: z.number().int().positive(), nextSequence: z.number().int().positive(),
  truncated: z.boolean(), unavailable: z.boolean(),
}).strict().refine(batch => batch.frames.reduce((n, f) => n + new TextEncoder().encode(f.text).length, 0) <= consoleLimits.batchBytes, 'Console batch exceeds byte limit');
export const consoleDemandSchema = consoleTargetSchema.extend({
  id: z.string().max(160), revision: z.number().int().nonnegative(), after: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict();
export type ConsoleTarget = z.infer<typeof consoleTargetSchema>;
export type ConsoleFrame = z.infer<typeof consoleFrameSchema>;
export type ConsoleBatch = z.infer<typeof consoleBatchSchema>;
export type ConsoleDemand = z.infer<typeof consoleDemandSchema>;
