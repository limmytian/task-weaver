import { z } from "zod";

const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

export const memoryTypeSchema = z.enum(["user", "feedback", "project", "reference", "other"]);

export const memoryEntityTypeSchema = z.enum(["project", "requirement", "task", "document"]);

export const recordMemorySchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  memoryType: memoryTypeSchema.default("other"),
  projectId: z.string().uuid().optional(),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  entityType: memoryEntityTypeSchema.optional(),
  entityId: z.string().uuid().optional(),
  expiresAt: z.string().datetime().optional(),
});

export const updateMemorySchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  memoryType: memoryTypeSchema.optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  personalOwnerId: z.string().nullable().optional(),
  personalOwnerType: z.enum(["human", "agent"]).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const searchMemorySchema = z.object({
  query: z.string().trim().min(1).max(500),
  memoryType: memoryTypeSchema.optional(),
  projectId: z.string().uuid().optional(),
  includeGlobal: queryBooleanSchema.default(true),
  includePersonal: queryBooleanSchema.default(false),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
  entityType: memoryEntityTypeSchema.optional(),
  entityId: z.string().uuid().optional(),
  createdBy: z.string().optional(),
  preferredActorId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  includeExpired: queryBooleanSchema.default(false),
});

export const listMemoriesSchema = z.object({
  memoryType: memoryTypeSchema.optional(),
  projectId: z.string().uuid().optional(),
  includeGlobal: queryBooleanSchema.default(true),
  includePersonal: queryBooleanSchema.default(false),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
  entityType: memoryEntityTypeSchema.optional(),
  entityId: z.string().uuid().optional(),
  createdBy: z.string().optional(),
  tags: z.array(z.string()).optional(),
  includeExpired: queryBooleanSchema.default(false),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type MemoryEntityType = z.infer<typeof memoryEntityTypeSchema>;
export type RecordMemoryInput = z.infer<typeof recordMemorySchema>;
export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;
export type SearchMemoryInput = z.infer<typeof searchMemorySchema>;
export type ListMemoriesInput = z.infer<typeof listMemoriesSchema>;
