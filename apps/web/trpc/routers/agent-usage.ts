import { z } from "zod";
import {
  agentUsageQuerySchema,
  createResourceServices,
} from "@task-weaver/core";
import { router, ordinaryResourceProcedure } from "../init";
// Usage reads share the live core authorization used by REST.
export const agentUsageRouter = router({
  scopes: ordinaryResourceProcedure
    .input(
      z.object({
        kind: z.enum(["project", "requirement", "task"]),
        projectId: z.string().uuid().optional(),
        requirementId: z.string().uuid().optional(),
        query: z.string().trim().max(500).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.kind === "project") {
        const result = await createResourceServices(ctx.identity).projectService.listProjects(ctx.db, {
          view: "summary",
          pageSize: 50,
          query: input.query || undefined,
        });
        return z
          .array(z.object({ id: z.string().uuid(), name: z.string() }))
          .parse(result.items)
          .map((item) => ({ id: item.id, label: item.name }));
      }
      if (!input.projectId) return [];
      if (input.kind === "requirement") {
        const result = await createResourceServices(ctx.identity).requirementService.listRequirements(ctx.db, {
          projectId: input.projectId,
          view: "summary",
          pageSize: 50,
          completedWithinDays: 0,
          query: input.query || undefined,
        });
        return z
          .array(z.object({ id: z.string().uuid(), title: z.string() }))
          .parse(result.items)
          .map((item) => ({ id: item.id, label: item.title }));
      }
      const result = await createResourceServices(ctx.identity).taskService.listTasks(ctx.db, {
        projectId: input.projectId,
        requirementId: input.requirementId,
        view: "summary",
        pageSize: 50,
        completedWithinDays: 0,
        query: input.query || undefined,
      });
      return z
        .array(z.object({ id: z.string().uuid(), title: z.string() }))
        .parse(result.items)
        .map((item) => ({ id: item.id, label: item.title }));
    }),
  runs: ordinaryResourceProcedure
    .input(agentUsageQuerySchema)
    .query(({ ctx, input }) => createResourceServices(ctx.identity).agentUsageService.listUsage(ctx.db, input)),
  summary: ordinaryResourceProcedure
    .input(agentUsageQuerySchema)
    .query(({ ctx, input }) => createResourceServices(ctx.identity).agentUsageService.summarizeUsage(ctx.db, input)),
  run: ordinaryResourceProcedure
    .input(
      z.object({ projectId: z.string().uuid(), processId: z.string().uuid() }),
    )
    .query(({ ctx, input }) =>
      createResourceServices(ctx.identity).agentUsageService.getUsage(ctx.db, input.projectId, input.processId),
    ),
});
