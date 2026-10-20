import { z } from "zod";
import { recordMemorySchema, updateMemorySchema, memoryTypeSchema } from "./memory";
import { mcpRetrievalScopeSchema } from "./mcp-server-planning";

const id = z.string().uuid();
export const mcpMemorySearchSchema = mcpRetrievalScopeSchema.extend({
  query: z.string().trim().min(1).max(500),
  memoryType: memoryTypeSchema.optional(),
  limit: z.number().int().min(1).max(20).default(5),
}).strict();
export const mcpMemoryGetSchema = z.object({ id, includeExpired: z.boolean().default(false) }).strict();
export const mcpMemoryRecordSchema = recordMemorySchema.omit({ personalOwnerId: true, personalOwnerType: true, metadata: true }).extend({
  content: z.string().min(1).max(32768),
  tags: z.array(z.string().max(100)).max(20).optional(),
  scope: z.enum(["global", "project", "personal"]).default("project"),
  confirmed: z.literal(true),
  idempotencyKey: id,
}).strict();
export const mcpMemoryUpdateSchema = z.object({ id, patch: updateMemorySchema.omit({ personalOwnerId: true, personalOwnerType: true, metadata: true }).extend({
  content: z.string().min(1).max(32768).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  expectedVersion: z.number().int().min(1),
}).strict() }).strict();
export const mcpMemoryForgetSchema = z.object({ id, expectedVersion: z.number().int().min(1), confirmed: z.literal(true) }).strict();
