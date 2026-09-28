import { and, eq, or, sql, inArray } from "drizzle-orm";
import { type Database, mcpServers, mcpTools, mcpToolCalls } from "@task-weaver/db";
import type { Actor } from "../schemas/common";
import type {
  RegisterMcpServerInput,
  UpdateMcpServerInput,
  SearchMcpToolsInput,
} from "../schemas/mcp";
import { NotFoundError, ConflictError } from "../errors";

export interface McpPoolClient {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

export interface McpPool {
  getOrConnect(server: { id: string; name: string; transport: string; config: unknown }): Promise<McpPoolClient>;
  disconnect(serverId: string): Promise<void>;
  isConnected(serverId: string): boolean;
}

// -- Server CRUD --

export async function registerServer(
  db: Database,
  input: RegisterMcpServerInput,
  _actor: Actor,
) {
  const existing = await db.query.mcpServers.findFirst({
    where: eq(mcpServers.name, input.name),
  });
  if (existing) {
    throw new ConflictError(`MCP server with name "${input.name}" already exists`, 0);
  }

  const [server] = await db
    .insert(mcpServers)
    .values({
      name: input.name,
      description: input.description,
      projectId: input.projectId ?? null,
      personalOwnerId: input.personalOwnerId ?? null,
      personalOwnerType: input.personalOwnerType ?? null,
      transport: input.transport,
      config: input.config,
      tags: input.tags,
      active: input.active,
      clientId: input.clientId,
      nodeId: input.nodeId,
      scope: input.transport === "stdio" ? (input.scope ?? "private") : null,
      ttl: input.ttl,
      expiresAt: input.clientId ? new Date(Date.now() + (input.ttl ?? 60) * 1000) : null,
    })
    .returning();

  return server!;
}

export async function heartbeatServer(
  db: Database,
  serverId: string,
  clientId: string,
) {
  const server = await getServer(db, serverId);
  if (server.clientId !== clientId) {
    throw new ConflictError("Client ID mismatch for MCP server heartbeat", 0);
  }

  const [updated] = await db
    .update(mcpServers)
    .set({
      expiresAt: new Date(Date.now() + server.ttl * 1000),
      status: "connected",
      statusMessage: null,
      lastConnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mcpServers.id, serverId))
    .returning();

  return updated!;
}

export async function getServer(db: Database, id: string) {
  const server = await db.query.mcpServers.findFirst({
    where: eq(mcpServers.id, id),
  });
  if (!server) throw new NotFoundError("MCP server not found");
  return server;
}

export async function listServers(
  db: Database,
  filters?: {
    active?: boolean;
    tags?: string[];
    projectId?: string;
    includeGlobal?: boolean;
    includePersonal?: boolean;
    personalOwnerId?: string;
    personalOwnerType?: "human" | "agent";
  },
) {
  const conditions = [];
  if (filters?.active !== undefined) {
    conditions.push(eq(mcpServers.active, filters.active));
  }
  if (filters?.tags && filters.tags.length > 0) {
    conditions.push(sql`${mcpServers.tags} && ${filters.tags}`);
  }
  conditions.push(buildServerScopeCondition(filters ?? {}));

  return db.query.mcpServers.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: (s, { asc }) => [asc(s.name)],
  });
}

export async function updateServer(
  db: Database,
  id: string,
  input: UpdateMcpServerInput,
  _actor: Actor,
) {
  const existing = await getServer(db, id);
  const { localScopeConsent: _localScopeConsent, ...updates } = input;
  const finalTransport = updates.transport ?? existing.transport;
  const finalScope = updates.scope ?? existing.scope;
  const finalNodeId = updates.nodeId ?? existing.nodeId;
  const isEnablingLocalScope = finalTransport === "stdio"
    && finalScope === "local"
    && (existing.transport !== "stdio" || existing.scope !== "local" || input.scope === "local");

  if (isEnablingLocalScope && !finalNodeId) {
    throw new ConflictError("nodeId is required when sharing a stdio MCP server with scope=local", 0);
  }
  if (isEnablingLocalScope && input.localScopeConsent !== true) {
    throw new ConflictError("localScopeConsent=true is required to share a stdio MCP server with scope=local", 0);
  }

  const [updated] = await db
    .update(mcpServers)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(mcpServers.id, id))
    .returning();

  return updated!;
}

export async function deleteServer(db: Database, id: string, _actor: Actor) {
  await getServer(db, id);
  await db.delete(mcpServers).where(eq(mcpServers.id, id));
}

// -- Tool Sync --

export async function syncTools(
  db: Database,
  serverId: string,
  pool: McpPool,
) {
  const server = await getServer(db, serverId);
  let client: McpPoolClient;

  try {
    client = await pool.getOrConnect(server as Parameters<McpPool["getOrConnect"]>[0]);
  } catch (err) {
    await db
      .update(mcpServers)
      .set({
        status: "error",
        statusMessage: err instanceof Error ? err.message : String(err),
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, serverId));
    throw err;
  }

  await db
    .update(mcpServers)
    .set({
      status: "connected",
      statusMessage: null,
      lastConnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mcpServers.id, serverId));

  const { tools } = await client.listTools();

  // Remove tools no longer present on server
  const currentToolNames = tools.map((t) => t.name);
  if (currentToolNames.length > 0) {
    await db
      .delete(mcpTools)
      .where(
        and(
          eq(mcpTools.serverId, serverId),
          sql`${mcpTools.name} NOT IN (${sql.join(currentToolNames.map(n => sql`${n}`), sql`, `)})`,
        ),
      );
  } else {
    await db.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
  }

  // Upsert tools
  const results = [];
  for (const tool of tools) {
    const existing = await db.query.mcpTools.findFirst({
      where: and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, tool.name)),
    });

    if (existing) {
      const [updated] = await db
        .update(mcpTools)
        .set({
          description: tool.description ?? null,
          inputSchema: (tool.inputSchema as Record<string, unknown>) ?? null,
        })
        .where(eq(mcpTools.id, existing.id))
        .returning();
      results.push(updated!);
    } else {
      const [created] = await db
        .insert(mcpTools)
        .values({
          serverId,
          name: tool.name,
          description: tool.description ?? null,
          inputSchema: (tool.inputSchema as Record<string, unknown>) ?? null,
        })
        .returning();
      results.push(created!);
    }
  }

  return results;
}

export async function uploadTools(
  db: Database,
  serverId: string,
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>,
) {
  await getServer(db, serverId);

  // Remove tools no longer present on server
  const currentToolNames = tools.map((t) => t.name);
  if (currentToolNames.length > 0) {
    await db
      .delete(mcpTools)
      .where(
        and(
          eq(mcpTools.serverId, serverId),
          sql`${mcpTools.name} NOT IN (${sql.join(currentToolNames.map(n => sql`${n}`), sql`, `)})`,
        ),
      );
  } else {
    await db.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
  }

  // Upsert tools
  const results = [];
  for (const tool of tools) {
    const existing = await db.query.mcpTools.findFirst({
      where: and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, tool.name)),
    });

    if (existing) {
      const [updated] = await db
        .update(mcpTools)
        .set({
          description: tool.description ?? null,
          inputSchema: (tool.inputSchema as Record<string, unknown>) ?? null,
        })
        .where(eq(mcpTools.id, existing.id))
        .returning();
      results.push(updated!);
    } else {
      const [created] = await db
        .insert(mcpTools)
        .values({
          serverId,
          name: tool.name,
          description: tool.description ?? null,
          inputSchema: (tool.inputSchema as Record<string, unknown>) ?? null,
        })
        .returning();
      results.push(created!);
    }
  }

  return results;
}

// -- Tool Search --

export async function searchTools(db: Database, input: SearchMcpToolsInput) {
  const likePattern = `%${input.intent}%`;
  const conditions = [];

  conditions.push(
    or(
      sql`${mcpTools.name} ILIKE ${likePattern}`,
      sql`${mcpTools.description} ILIKE ${likePattern}`,
    ),
  );

  if (input.serverId) {
    conditions.push(eq(mcpTools.serverId, input.serverId));
  }

  if (input.tags && input.tags.length > 0) {
    conditions.push(sql`${mcpTools.tags} && ${input.tags}`);
  }

  const serverScopeVisibility = buildServerScopeSql(input);

  // Only include tools from active, non-expired servers.
  // Visibility rules for stdio servers:
  //   scope=private: only the matching clientId can see it
  //   scope=local:   only agents on the same node (nodeId match) can see it
  //   sse/http:      visible to everyone (global)
  const visibilityConditions = [sql`transport != 'stdio'`];
  if (input.clientId) {
    visibilityConditions.push(sql`(transport = 'stdio' AND scope = 'private' AND client_id = ${input.clientId})`);
  }
  if (input.nodeId) {
    visibilityConditions.push(sql`(transport = 'stdio' AND scope = 'local' AND node_id = ${input.nodeId})`);
  }
  const visibilityExpr = sql.join(visibilityConditions, sql` OR `);

  conditions.push(
    sql`${mcpTools.serverId} IN (
      SELECT id FROM mcp_servers
      WHERE active = true
      AND (expires_at IS NULL OR expires_at > NOW())
      AND ${serverScopeVisibility}
      AND (${visibilityExpr})
    )`,
  );

  const results = await db
    .select({
      id: mcpTools.id,
      name: mcpTools.name,
      description: mcpTools.description,
      inputSchema: mcpTools.inputSchema,
      serverId: mcpTools.serverId,
      tags: mcpTools.tags,
    })
    .from(mcpTools)
    .where(and(...conditions))
    .limit(input.limit);

  // Enrich with server names
  if (results.length === 0) return [];
  const serverIds = [...new Set(results.map((r) => r.serverId))];
  const servers = await db.query.mcpServers.findMany({
    where: inArray(mcpServers.id, serverIds),
    columns: { id: true, name: true },
  });
  const serverMap = new Map(servers.map((s) => [s.id, s.name]));

  return results.map((r) => ({
    ...r,
    serverName: serverMap.get(r.serverId) ?? "unknown",
  }));
}

function buildServerScopeCondition(input: {
  projectId?: string;
  includeGlobal?: boolean;
  includePersonal?: boolean;
  personalOwnerId?: string;
  personalOwnerType?: "human" | "agent";
}) {
  const scopes = [];

  if (input.projectId) {
    scopes.push(eq(mcpServers.projectId, input.projectId));
    if (input.includeGlobal ?? true) {
      scopes.push(sql`${mcpServers.projectId} IS NULL AND ${mcpServers.personalOwnerId} IS NULL`);
    }
  } else {
    scopes.push(sql`${mcpServers.projectId} IS NULL AND ${mcpServers.personalOwnerId} IS NULL`);
  }

  if (input.includePersonal && input.personalOwnerId && input.personalOwnerType) {
    scopes.push(
      and(
        sql`${mcpServers.projectId} IS NULL`,
        eq(mcpServers.personalOwnerId, input.personalOwnerId),
        eq(mcpServers.personalOwnerType, input.personalOwnerType),
      )!,
    );
  }

  return or(...scopes)!;
}

function buildServerScopeSql(input: {
  projectId?: string;
  includeGlobal?: boolean;
  includePersonal?: boolean;
  personalOwnerId?: string;
  personalOwnerType?: "human" | "agent";
}) {
  const scopes = [];

  if (input.projectId) {
    scopes.push(sql`project_id = ${input.projectId}`);
    if (input.includeGlobal) {
      scopes.push(sql`(project_id IS NULL AND personal_owner_id IS NULL)`);
    }
  } else {
    scopes.push(sql`(project_id IS NULL AND personal_owner_id IS NULL)`);
  }

  if (input.includePersonal && input.personalOwnerId && input.personalOwnerType) {
    scopes.push(sql`(project_id IS NULL AND personal_owner_id = ${input.personalOwnerId} AND personal_owner_type = ${input.personalOwnerType})`);
  }

  return sql`(${sql.join(scopes, sql` OR `)})`;
}

export async function getToolDetail(db: Database, toolId: string) {
  const tool = await db.query.mcpTools.findFirst({
    where: eq(mcpTools.id, toolId),
  });
  if (!tool) throw new NotFoundError("MCP tool not found");

  const server = await db.query.mcpServers.findFirst({
    where: eq(mcpServers.id, tool.serverId),
    columns: { id: true, name: true, status: true },
  });

  return { ...tool, server };
}

// -- Tool Call --

export async function callTool(
  db: Database,
  toolId: string,
  args: Record<string, unknown> | undefined,
  actor: Actor,
  pool: McpPool,
) {
  const tool = await db.query.mcpTools.findFirst({
    where: eq(mcpTools.id, toolId),
  });
  if (!tool) throw new NotFoundError("MCP tool not found");

  const server = await getServer(db, tool.serverId);
  if (!server.active) {
    throw new ConflictError("MCP server is disabled", 0);
  }

  const startTime = Date.now();
  let client: McpPoolClient;

  try {
    client = await pool.getOrConnect(server as Parameters<McpPool["getOrConnect"]>[0]);
  } catch (err) {
    await db.insert(mcpToolCalls).values({
      toolId: tool.id,
      serverId: server.id,
      toolName: tool.name,
      input: args ?? null,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
      calledBy: actor.id,
      calledByType: actor.type,
    });
    throw err;
  }

  try {
    const result = await client.callTool({ name: tool.name, arguments: args });
    const durationMs = Date.now() - startTime;
    const isError = Boolean((result as { isError?: boolean }).isError);
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;

    await db.insert(mcpToolCalls).values({
      toolId: tool.id,
      serverId: server.id,
      toolName: tool.name,
      input: args ?? null,
      output: result as Record<string, unknown>,
      status: isError ? "error" : "success",
      errorMessage: isError && content
        ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
        : null,
      durationMs,
      calledBy: actor.id,
      calledByType: actor.type,
    });

    return result;
  } catch (err) {
    await db.insert(mcpToolCalls).values({
      toolId: tool.id,
      serverId: server.id,
      toolName: tool.name,
      input: args ?? null,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
      calledBy: actor.id,
      calledByType: actor.type,
    });
    throw err;
  }
}
