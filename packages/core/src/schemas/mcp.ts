import { z } from "zod";

export const mcpTransportSchema = z.enum(["stdio", "sse", "streamable-http"]);

export const mcpServerStdioConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

export const mcpServerHttpConfigSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

export const mcpScopeSchema = z.enum(["private", "local"]);

const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const requireLocalScopeConsent = <T extends { transport?: string; scope?: string; nodeId?: string; localScopeConsent?: boolean }>(
  schema: z.ZodType<T>,
) => schema
  .refine((data) => {
    if (data.scope === "local" && !data.nodeId) {
      return false;
    }
    return true;
  }, {
    message: "nodeId is required when sharing a stdio MCP server with scope=local",
    path: ["nodeId"],
  })
  .refine((data) => {
    if (data.scope === "local" && data.localScopeConsent !== true) {
      return false;
    }
    return true;
  }, {
    message: "localScopeConsent=true is required to share a stdio MCP server with scope=local",
    path: ["localScopeConsent"],
  });

export const registerMcpServerSchema = requireLocalScopeConsent(z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  projectId: z.string().uuid().optional(),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
  transport: mcpTransportSchema,
  config: z.union([mcpServerStdioConfigSchema, mcpServerHttpConfigSchema]),
  tags: z.array(z.string()).optional(),
  active: z.boolean().default(true),
  clientId: z.string().optional(),
  nodeId: z.string().optional(),
  scope: mcpScopeSchema.default("private"),
  localScopeConsent: z.boolean().optional(),
  ttl: z.coerce.number().int().min(5).max(3600).default(60),
})).refine((data) => {
  if (data.transport === "stdio" && !data.clientId) {
    return false;
  }
  return true;
}, {
  message: "clientId is required for stdio transport",
  path: ["clientId"],
});

export const updateMcpServerSchema = requireLocalScopeConsent(z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  personalOwnerId: z.string().nullable().optional(),
  personalOwnerType: z.enum(["human", "agent"]).nullable().optional(),
  transport: mcpTransportSchema.optional(),
  config: z.union([mcpServerStdioConfigSchema, mcpServerHttpConfigSchema]).optional(),
  tags: z.array(z.string()).optional(),
  active: z.boolean().optional(),
  clientId: z.string().optional(),
  nodeId: z.string().optional(),
  scope: mcpScopeSchema.optional(),
  localScopeConsent: z.boolean().optional(),
  ttl: z.coerce.number().int().min(5).max(3600).optional(),
}));

export const searchMcpToolsSchema = z.object({
  intent: z.string().min(1).max(500),
  tags: z.array(z.string()).optional(),
  serverId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  includeGlobal: queryBooleanSchema.default(true),
  includePersonal: queryBooleanSchema.default(false),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
  clientId: z.string().optional(),
  nodeId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

export const callMcpToolSchema = z.object({
  arguments: z.record(z.unknown()).optional(),
});

export type McpTransport = z.infer<typeof mcpTransportSchema>;
export type McpScope = z.infer<typeof mcpScopeSchema>;
export type RegisterMcpServerInput = z.infer<typeof registerMcpServerSchema>;
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;
export type SearchMcpToolsInput = z.infer<typeof searchMcpToolsSchema>;
export type CallMcpToolInput = z.infer<typeof callMcpToolSchema>;
