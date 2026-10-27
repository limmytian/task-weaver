import { z } from "zod";

export const mcpTransportSchema = z.enum(["stdio", "sse", "streamable-http", "hosted-stdio"]);

export const mcpServerStdioConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const mcpServerHostedConfigSchema = z.object({
  profileId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  profileHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const hostedMcpRuntimeProfileSchema = z.object({
  id: mcpServerHostedConfigSchema.shape.profileId,
  image: z.string().max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/),
  command: z.string().max(512).regex(/^\/[a-zA-Z0-9_./-]+$/),
  args: z.array(z.string().max(32768)).max(32).default([]),
  projectIds: z.array(z.string().uuid()).max(100).default([]),
  personalActorIds: z.array(z.string().min(1).max(255)).max(100).default([]),
  global: z.boolean().default(false),
  secretReferences: z.record(z.string(), z.string().regex(/^TW_MCP_SECRET_[A-Z0-9_]+$/)).default({}),
}).strict().refine(profile => Object.keys(profile.secretReferences).length <= 16 && Object.keys(profile.secretReferences).every(key => /^[A-Z][A-Z0-9_]{0,99}$/.test(key) && !/^(PATH|HOME|LD_|NODE_|PYTHON|DOCKER|TW_)/.test(key)), "Secret target names must be bounded application-specific environment names");

export const mcpServerHttpConfigSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const mcpScopeSchema = z.enum(["private", "local"]);

const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const requireLocalScopeConsent = <S extends z.ZodType<{ transport?: string; scope?: string; nodeId?: string; localScopeConsent?: boolean }>>(
  schema: S,
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
  config: z.union([mcpServerHostedConfigSchema, mcpServerStdioConfigSchema, mcpServerHttpConfigSchema]),
  tags: z.array(z.string()).optional(),
  readOnly: z.boolean().default(false),
  active: z.boolean().default(true),
  clientId: z.string().optional(),
  nodeId: z.string().optional(),
  scope: mcpScopeSchema.default("private"),
  localScopeConsent: z.boolean().optional(),
  ttl: z.coerce.number<number>().int().min(5).max(3600).default(60),
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
  config: z.union([mcpServerHostedConfigSchema, mcpServerStdioConfigSchema, mcpServerHttpConfigSchema]).optional(),
  tags: z.array(z.string()).optional(),
  readOnly: z.boolean().optional(),
  active: z.boolean().optional(),
  clientId: z.string().optional(),
  nodeId: z.string().optional(),
  scope: mcpScopeSchema.optional(),
  localScopeConsent: z.boolean().optional(),
  ttl: z.coerce.number<number>().int().min(5).max(3600).optional(),
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
  limit: z.coerce.number<number>().int().min(1).max(20).default(10),
});

export const callMcpToolSchema = z.object({
  expectedSchemaHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  approvalId: z.string().uuid().optional(),
  arguments: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 1_048_576, "MCP arguments exceed size limit").optional(),
});

export type McpTransport = z.infer<typeof mcpTransportSchema>;
export type McpScope = z.infer<typeof mcpScopeSchema>;
export type RegisterMcpServerInput = z.infer<typeof registerMcpServerSchema>;
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;
export type SearchMcpToolsInput = z.infer<typeof searchMcpToolsSchema>;
export type CallMcpToolInput = z.infer<typeof callMcpToolSchema>;

export const uploadMcpToolsSchema = z.object({
  tools: z.array(z.object({
    name: z.string().min(1).max(255),
    description: z.string().max(16_384).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
  }).strict()).max(1000),
}).strict();

export const completeLocalMcpRequestSchema = z.object({
  leaseToken: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 1_048_576, "MCP result exceeds size limit"),
}).strict();

export const mcpSecurityScopeSchema = z.object({
  projectId: z.string().uuid().optional(),
  personal: queryBooleanSchema.default(false),
}).strict();
export const setMcpInvocationPolicySchema = mcpSecurityScopeSchema.extend({
  toolId: z.string().min(1).max(255).regex(/^(\*|tw_[a-z_]+|[0-9a-f-]{36})$/),
  mode: z.enum(["allow", "approval", "deny"]),
}).strict();
export const mcpToolAuthorizationSchema = z.object({
  readOnly: z.boolean(),
  targetProjectArgument: z.string().min(1).max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).nullable(),
}).strict();

export const listMcpInvocationAuditsSchema = mcpSecurityScopeSchema.extend({
  limit: z.coerce.number<number>().int().min(1).max(100).default(20),
  offset: z.coerce.number<number>().int().min(0).max(100000).default(0),
}).strict();
