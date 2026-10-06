import { z } from "zod";
import { router, ordinaryResourceProcedure } from "../init";
import {
  createResourceServices,
  personalResourceOwnerId,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  registerMcpServerSchema,
  updateMcpServerSchema,
} from "@task-weaver/core";

export const mcpRouter = router({
  list: ordinaryResourceProcedure
    .input(z.object({
      projectId: z.string().uuid().optional(),
      includeGlobal: z.boolean().default(true),
      includePersonal: z.boolean().default(false),
      personalOwnerId: z.string().optional(),
      personalOwnerType: z.enum(["human", "agent"]).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).mcpRegistryService.listServers(ctx.db, {
        ...input,
        personalOwnerId: input?.personalOwnerId ?? personalResourceOwnerId(ctx.identity),
        personalOwnerType: input?.personalOwnerType ?? "human",
      });
    }),

  get: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const server = await createResourceServices(ctx.identity).mcpRegistryService.getServer(ctx.db, input.id);
      const tools = await createResourceServices(ctx.identity).mcpRegistryService.listServerTools(ctx.db, input.id);
      return { server, tools };
    }),

  create: ordinaryResourceProcedure
    .input(registerMcpServerSchema)
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).mcpRegistryService.registerServer(ctx.db, input, ctx.actor);
    }),

  update: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateMcpServerSchema }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).mcpRegistryService.updateServer(ctx.db, input.id, input.data, ctx.actor);
    }),

  delete: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return forwardMcpRequest(ctx.req, "/servers/" + input.id, "DELETE");

    }),

  sync: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return forwardMcpRequest(ctx.req, "/servers/" + input.id + "/sync", "POST") as Promise<{ items: unknown[]; count: number }>;
    }),
});

async function forwardMcpRequest(request: Request, path: string, method: "POST" | "DELETE") {
  const headers = new Headers();
  for (const name of ["authorization", "cookie", "origin", "x-csrf-token"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const apiUrl = process.env.TW_API_URL || "http://localhost:3001";
  const response = await fetch(apiUrl + "/api/v1/mcp" + path, { method, headers, redirect: "error" });
  if (response.status === 403) throw new AuthorizationError();
  if (response.status === 404) throw new NotFoundError("Resource not found");
  if (response.status === 409) throw new ConflictError("MCP operation conflicted", 0);
  if (!response.ok) throw new Error("MCP operation failed");
  return response.json();
}
