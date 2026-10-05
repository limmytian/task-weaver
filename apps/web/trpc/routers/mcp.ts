import { z } from "zod";
import { router, resourceProcedure } from "../init";
import {
  mcpRegistryService,
  registerMcpServerSchema,
  updateMcpServerSchema,
} from "@task-weaver/core";

export const mcpRouter = router({
  list: resourceProcedure
    .input(z.object({
      projectId: z.string().uuid().optional(),
      includeGlobal: z.boolean().default(true),
      includePersonal: z.boolean().default(false),
      personalOwnerId: z.string().optional(),
      personalOwnerType: z.enum(["human", "agent"]).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      return mcpRegistryService.listServers(ctx.db, {
        ...input,
        personalOwnerId: input?.personalOwnerId ?? ctx.actor.id,
        personalOwnerType: input?.personalOwnerType ?? ctx.actor.type,
      });
    }),

  get: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const server = await mcpRegistryService.getServer(ctx.db, input.id);
      const tools = await ctx.db.query.mcpTools.findMany({
        where: (tools, { eq }) => eq(tools.serverId, input.id),
      });
      return { server, tools };
    }),

  create: resourceProcedure
    .input(registerMcpServerSchema)
    .mutation(async ({ ctx, input }) => {
      return mcpRegistryService.registerServer(ctx.db, input, ctx.actor);
    }),

  update: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateMcpServerSchema }))
    .mutation(async ({ ctx, input }) => {
      return mcpRegistryService.updateServer(ctx.db, input.id, input.data, ctx.actor);
    }),

  delete: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const apiUrl = process.env.TW_API_URL || "http://localhost:3001";
      try {
        await fetch(`${apiUrl}/api/v1/mcp/servers/${input.id}`, {
          method: "DELETE",
        });
      } catch (err) {
        console.warn("Failed to notify API server of MCP disconnection. Deleting database registry directly.", err);
      }
      return mcpRegistryService.deleteServer(ctx.db, input.id, ctx.actor);
    }),

  sync: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const apiUrl = process.env.TW_API_URL || "http://localhost:3001";
      const res = await fetch(`${apiUrl}/api/v1/mcp/servers/${input.id}/sync`, {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Failed to sync server tools (status ${res.status})`);
      }
      return res.json() as Promise<{ items: unknown[]; count: number }>;
    }),
});
