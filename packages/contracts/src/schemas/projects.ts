import { z } from "zod";

export const projectStatusSchema = z.enum(["active", "archived"]);

export const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
});

export const executorFallbackPolicySchema = z.object({
  allowedTools: z.array(z.enum(["codex", "claude", "agy", "aider", "cursor"])).max(5).default([]),
  authenticationMode: z.literal("subscription"),
  allowPaidApi: z.literal(false),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  status: projectStatusSchema.optional(),
  executorFallbackPolicy: executorFallbackPolicySchema.nullable().optional(),
});

export const listProjectsSchema = z.object({
  status: projectStatusSchema.optional(),
  query: z.string().trim().min(1).max(500).optional(),
  view: z.enum(["summary", "full"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export type ListProjectsInput = z.infer<typeof listProjectsSchema>;