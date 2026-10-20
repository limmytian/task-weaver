import { resolve } from "node:path";
import { recordMcpInvocationAudit, personalResourceOwnerId, skillPackageStorageService } from "@task-weaver/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AuthenticationError, MCP_SERVER_LIMITS } from "@task-weaver/contracts";
import { createMcpToolCaller, createTaskWeaverMcpServer, isMcpArgumentError, type McpCallBudget, type McpExecutor } from "@task-weaver/core/mcp-server";
import { authorizedMcpToolNames, createAuthorizedMcpExecutor } from "@task-weaver/core/mcp-server/executor";
import type { Env } from "../middleware/actor.js";

export interface McpRouteOptions {
  allowedHosts: readonly string[];
  readOnly?: boolean;
  packageStorageDir?: string;
  runtimeProfiles?: string;
  budget?: McpCallBudget;
  signal?: AbortSignal;
  visibleTools?: (context: Env["Variables"]) => Promise<readonly string[]>;
  executor?: (context: Env["Variables"]) => McpExecutor;
}

/** A fresh protocol server per HTTP request avoids mutable cross-caller identity. */
export function createMcpServerRoutes(options: McpRouteOptions) {
  const routes = new Hono<Env>();
  const budget: McpCallBudget = options.budget ?? { active: 0 };
  routes.use("*", bodyLimit({ maxSize: MCP_SERVER_LIMITS.requestBytes, onError: c => c.json({ error: "Request exceeds the MCP limit" }, 413) }));
  routes.use("*", async (c, next) => {
    const identity = c.get("identity");
    if (identity.credential.kind !== "api_key" || !c.req.header("authorization")) throw new AuthenticationError();
    // Never use forwarded Host values as authority. Reverse proxies must preserve
    // a configured public host or operators must explicitly allow their upstream host.
    if (!options.allowedHosts.includes(new URL(c.req.url).host)) return c.json({ error: "Untrusted MCP host" }, 403);
    if (options.signal?.aborted) return c.json({ error: "MCP server is stopping" }, 503);
    await next();
  });
  const caller = (context: Env["Variables"], requestSignal: AbortSignal) => createMcpToolCaller(
    options.executor?.(context) ?? createAuthorizedMcpExecutor(
      context.db, context.identity,
      new skillPackageStorageService.LocalSkillPackageStorageAdapter(options.packageStorageDir ?? process.env.SKILL_PACKAGE_STORAGE_DIR ?? resolve(process.cwd(), "data", "skill-packages")),
      options.runtimeProfiles,
      options.readOnly,
    ),
    { readOnly: options.readOnly, onRejected: options.executor ? undefined : (name, code) => recordMcpInvocationAudit(context.db, context.identity, { personalOwnerId: personalResourceOwnerId(context.identity), personalOwnerType: "human" }, "task-weaver", name, Date.now(), code), budget, signal: options.signal ? AbortSignal.any([requestSignal, options.signal]) : requestSignal },
  );

  // Authenticated JSON adapter used by local stdio clients through CLI request().
  routes.post("/tools/:name", async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
    try {
      const result = await caller(c.var, c.req.raw.signal)(c.req.param("name"), body);
      return c.json(result);
    } catch (error) {
      if (isMcpArgumentError(error)) return c.json({ error: "Invalid tool or arguments" }, 400);
      throw error;
    }
  });
  routes.get("/catalog", async c => {
    const names = await (options.visibleTools?.(c.var) ?? authorizedMcpToolNames(c.get("db"), c.get("identity")));
    return c.json({ tools: names.filter(name => !options.readOnly || !/_(create|update|add|remove|status|claim|heartbeat|release|apply)$/.test(name)) });
  });
  routes.all("/", async c => {
    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return c.json({ error: "This stateless MCP endpoint does not offer an event stream or sessions" }, 405);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: MCP_SERVER_LIMITS.requestBytes });
    const server = createTaskWeaverMcpServer(caller(c.var, c.req.raw.signal), { readOnly: options.readOnly, visibleTools: () => options.visibleTools?.(c.var) ?? authorizedMcpToolNames(c.get("db"), c.get("identity")) });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  return routes;
}
