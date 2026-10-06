import { Hono } from "hono";
import {
  createResourceServices,
  personalResourceOwnerId,
  uploadMcpToolsSchema,
  completeLocalMcpRequestSchema,
  registerMcpServerSchema,
  updateMcpServerSchema,
  searchMcpToolsSchema,
  callMcpToolSchema,
  NotFoundError,
  ConflictError,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";
import { mcpPool } from "../mcp-pool.js";

const mcp = new Hono<Env>();

// -- Server endpoints --

// POST /servers - Register MCP server
mcp.post("/servers", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json();

  const parsed = registerMcpServerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const server = await createResourceServices(c.get("identity")).mcpRegistryService.registerServer(db, parsed.data, actor);
    return c.json(server, 201);
  } catch (err) {
    if (err instanceof ConflictError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

// GET /servers - List servers
mcp.get("/servers", async (c) => {
  const db = c.get("db");
  const active = c.req.query("active");
  const tags = c.req.query("tags")?.split(",");
  const projectId = c.req.query("projectId");
  const includeGlobal = c.req.query("includeGlobal");
  const includePersonal = c.req.query("includePersonal");

  const servers = await createResourceServices(c.get("identity")).mcpRegistryService.listServers(db, {
    active: active === "true" ? true : active === "false" ? false : undefined,
    tags,
    projectId: projectId || undefined,
    includeGlobal: includeGlobal === "false" ? false : true,
    includePersonal: includePersonal === "true",
    personalOwnerId: c.req.query("personalOwnerId") ?? personalResourceOwnerId(c.get("identity")),
    personalOwnerType: (c.req.query("personalOwnerType") as "human" | "agent" | undefined) ?? "human",
  });

  return c.json({ items: servers });
});

// GET /servers/:id - Get server detail
mcp.get("/servers/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const server = await createResourceServices(c.get("identity")).mcpRegistryService.getServer(db, id);
    return c.json(server);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// PATCH /servers/:id - Update server
mcp.patch("/servers/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = updateMcpServerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const server = await createResourceServices(c.get("identity")).mcpRegistryService.updateServer(db, id, parsed.data, actor);
    return c.json(server);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

// DELETE /servers/:id - Delete server
mcp.delete("/servers/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");

  try {
    await createResourceServices(c.get("identity")).mcpRegistryService.deleteServer(db, id, actor);
    await mcpPool.disconnect(id);
    return c.json({ success: true });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// POST /servers/:id/sync - Sync tools from server
mcp.post("/servers/:id/sync", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const tools = await createResourceServices(c.get("identity")).mcpRegistryService.syncTools(db, id, mcpPool);
    return c.json({ items: tools, count: tools.length });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// POST /servers/:id/heartbeat - Keep-alive for client-hosted (stdio) MCP servers
mcp.post("/servers/:id/heartbeat", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  
  // Try to get clientId from header, query, or body
  let clientId = c.req.header("X-Client-Id") || c.req.query("clientId");
  if (!clientId) {
    try {
      const body = await c.req.json();
      clientId = body.clientId;
    } catch {
      // ignore
    }
  }

  if (!clientId) {
    return c.json({ error: "Missing Client ID in request header (X-Client-Id), query, or body" }, 400);
  }

  try {
    const server = await createResourceServices(c.get("identity")).mcpRegistryService.heartbeatServer(db, id, clientId);
    return c.json({ success: true, expiresAt: server.expiresAt });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

// POST /servers/:id/upload-tools - Sync tool schemas manually uploaded by client
mcp.post("/servers/:id/upload-tools", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);

  const parsed = uploadMcpToolsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);

  try {
    const results = await createResourceServices(c.get("identity")).mcpRegistryService.uploadTools(db, id, parsed.data.tools);
    return c.json({ items: results, count: results.length });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// -- Tool endpoints --

// GET /tools/search - Search tools by intent
mcp.get("/tools/search", async (c) => {
  const db = c.get("db");
  const query = c.req.query();

  const parsed = searchMcpToolsSchema.safeParse({
    intent: query.intent ?? query.q,
    tags: query.tags ? query.tags.split(",") : undefined,
    serverId: query.serverId,
    projectId: query.projectId,
    includeGlobal: query.includeGlobal,
    includePersonal: query.includePersonal,
    personalOwnerId: query.personalOwnerId ?? personalResourceOwnerId(c.get("identity")),
    personalOwnerType: query.personalOwnerType ?? "human",
    clientId: query.clientId || c.req.header("X-Client-Id"),
    nodeId: query.nodeId || c.req.header("X-Node-Id"),
    limit: query.limit,
  });

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  const results = await createResourceServices(c.get("identity")).mcpRegistryService.searchTools(db, parsed.data);
  return c.json({ items: results });
});

// GET /tools/:id - Get tool detail
mcp.get("/tools/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  try {
    const tool = await createResourceServices(c.get("identity")).mcpRegistryService.getToolDetail(db, id);
    return c.json(tool);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// POST /tools/:id/call - Execute tool via proxy
mcp.post("/tools/:id/call", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const parsed = callMcpToolSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await createResourceServices(c.get("identity")).mcpRegistryService.callTool(
      db,
      id,
      parsed.data.arguments,
      actor,
      mcpPool,
    );
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

mcp.post("/servers/:id/poll", async c => {
  const items = await createResourceServices(c.get("identity")).mcpRegistryService.pollLocalToolRequests(c.get("db"), c.req.param("id"));
  return c.json({ items });
});

mcp.post("/requests/:id/result", async c => {
  const parsed = completeLocalMcpRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  return c.json(await createResourceServices(c.get("identity")).mcpRegistryService.completeLocalToolRequest(c.get("db"), c.req.param("id"), parsed.data));
});

export default mcp;
