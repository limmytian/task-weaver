import { z } from "zod";
import { router, resourceProcedure } from "../init";
import {
  addRequirementRepositorySchema,
  addTaskRepositorySchema,
  createRepositorySchema,
  listRepositoriesSchema,
  repositoryReadinessInputSchema,
  repositoryService,
  updateRepositorySchema,
} from "@task-weaver/core";

export const repositoryRouter = router({
  list: resourceProcedure.input(listRepositoriesSchema).query(({ ctx, input }) =>
    repositoryService.listRepositories(ctx.db, input, ctx.actor)),
  get: resourceProcedure.input(z.object({ id: z.string().uuid() }).merge(repositoryReadinessInputSchema))
    .query(({ ctx, input }) => {
      const { id, ...readiness } = input;
      return repositoryService.getRepository(ctx.db, id, ctx.actor, readiness);
    }),
  create: resourceProcedure.input(createRepositorySchema).mutation(({ ctx, input }) =>
    repositoryService.createRepository(ctx.db, input, ctx.actor)),
  update: resourceProcedure.input(z.object({ id: z.string().uuid(), data: updateRepositorySchema }))
    .mutation(({ ctx, input }) => repositoryService.updateRepository(ctx.db, input.id, input.data, ctx.actor)),
  archive: resourceProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ ctx, input }) =>
    repositoryService.archiveRepository(ctx.db, input.id, ctx.actor)),
  readiness: resourceProcedure.input(z.object({ id: z.string().uuid() }).merge(repositoryReadinessInputSchema))
    .query(({ ctx, input }) => {
      const { id, ...readiness } = input;
      return repositoryService.getRepositoryReadiness(ctx.db, id, ctx.actor, readiness);
    }),
  listForRequirement: resourceProcedure.input(z.object({ requirementId: z.string().uuid() }))
    .query(({ ctx, input }) => repositoryService.listRequirementRepositories(ctx.db, input.requirementId, ctx.actor)),
  addToRequirement: resourceProcedure
    .input(z.object({ requirementId: z.string().uuid() }).merge(addRequirementRepositorySchema))
    .mutation(({ ctx, input }) => {
      const { requirementId, ...data } = input;
      return repositoryService.addRequirementRepository(ctx.db, requirementId, data, ctx.actor);
    }),
  removeFromRequirement: resourceProcedure
    .input(z.object({ requirementId: z.string().uuid(), repositoryId: z.string().uuid() }))
    .mutation(({ ctx, input }) => repositoryService.removeRequirementRepository(
      ctx.db, input.requirementId, input.repositoryId, ctx.actor,
    )),
  retryDelivery: resourceProcedure.input(z.object({
    linkId: z.string().uuid(),
    reason: z.string().trim().min(3).max(1000).optional(),
  })).mutation(({ ctx, input }) => repositoryService.retryRequirementRepositoryDelivery(
    ctx.db,
    input.linkId,
    ctx.actor,
    input.reason,
  )),
  manualHandoff: resourceProcedure.input(z.object({
    linkId: z.string().uuid(),
    reason: z.string().trim().min(3).max(1000),
  })).mutation(({ ctx, input }) => repositoryService.handoffRequirementRepositoryDelivery(
    ctx.db,
    input.linkId,
    input.reason,
    ctx.actor,
  )),
  listForTask: resourceProcedure.input(z.object({ taskId: z.string().uuid() }))
    .query(({ ctx, input }) => repositoryService.listTaskRepositories(ctx.db, input.taskId, ctx.actor)),
  addToTask: resourceProcedure.input(z.object({ taskId: z.string().uuid() }).merge(addTaskRepositorySchema))
    .mutation(({ ctx, input }) => {
      const { taskId, ...data } = input;
      return repositoryService.addTaskRepository(ctx.db, taskId, data, ctx.actor);
    }),
  removeFromTask: resourceProcedure.input(z.object({ taskId: z.string().uuid(), repositoryId: z.string().uuid() }))
    .mutation(({ ctx, input }) => repositoryService.removeTaskRepository(ctx.db, input.taskId, input.repositoryId, ctx.actor)),
});
