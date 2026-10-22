import { capabilityAvailabilitySchema } from "./capabilities";
import { mcpTransportSchema } from "./mcp";
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
  timeoutMs: z.number().int().min(100).max(25000).default(25000),
  targetApprovalId: z.string().uuid().optional(),
}).strict();

export const mcpRegistryReadinessSchema = z.object({ serverId: z.string().uuid() }).strict();
export const mcpServerReadinessSchema = z.object({
  serverId: z.string().uuid(), transport: mcpTransportSchema,
  checkedAt: z.string().datetime(), connected: z.boolean(),
  availability: capabilityAvailabilitySchema,
  credentials: z.enum(["unknown", "not_required", "configured", "missing"]),
  runtime: z.object({ profileId: z.string(), profileHash: z.string(), image: z.string(), network: z.literal("none") }).strict().optional(),
  guidance: z.string().min(1).max(500),
}).strict();
