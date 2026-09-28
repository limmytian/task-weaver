import { z } from "zod";

export const actorSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["human", "agent"]),
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const requirementLeaseFenceFields = {
  leaseGeneration: z.number().int().positive().optional(),
  daemonId: z.string().uuid().optional(),
};

export type Actor = z.infer<typeof actorSchema>;
export type Pagination = z.infer<typeof paginationSchema>;
export interface RequirementLeaseFence {
  leaseGeneration?: number;
  daemonId?: string;
}
