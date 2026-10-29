import { z } from "zod";

export const attentionCategorySchema = z.enum(["recovery", "failure", "review", "blocked"]);
export const attentionQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  category: attentionCategorySchema.optional(),
  after: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(25),
});
export type AttentionCategory = z.infer<typeof attentionCategorySchema>;
export const attentionItemSchema = z.object({
  id: z.string(), requirementId: z.string().uuid(), projectId: z.string().uuid(),
  title: z.string(), projectName: z.string(), category: attentionCategorySchema,
  reason: z.string(), nextAction: z.string(), canAct: z.boolean(),
  responsibility: z.literal("available_to_you"), updatedAt: z.string(), planRevision: z.number(),
});
export const attentionPageSchema = z.object({
  items: z.array(attentionItemSchema).max(50), next: z.string().uuid().nullable(),
  observedAt: z.string(), countScope: z.literal("page_only"),
});
