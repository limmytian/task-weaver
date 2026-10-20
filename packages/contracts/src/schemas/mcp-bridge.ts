import { z } from "zod";
import { mcpRetrievalScopeSchema } from "./mcp-server-planning";

export const mcpRegistrySearchSchema = mcpRetrievalScopeSchema.extend({
  intent: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(5),
}).strict();
export const mcpRegistryToolSchema = z.object({ toolId: z.string().uuid() }).strict();
export const mcpRegistryCallSchema = mcpRegistryToolSchema.extend({
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  arguments: z.record(z.unknown()).default({}),
  confirmed: z.literal(true),
  targetApprovalId: z.string().uuid().optional(),
}).strict();
