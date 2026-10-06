import { z } from "zod";
import { router, resourceProcedure, ordinaryResourceProcedure } from "../init";
import {
  addRequirementRepositorySchema,
  addTaskRepositorySchema,
  createRepositorySchema,
  listRepositoriesSchema,
  repositoryReadinessInputSchema,
  createResourceServices,
  updateRepositorySchema,
} from "@task-weaver/core";

export const repositoryRouter = router({
  list: ordinaryResourceProcedure.input(listRepositoriesSchema).query(({ ctx, input }) =>
    createResourceServices(ctx.identity).repositoryService.listRepositories(ctx.db, input, ctx.actor)),
  get: ordinaryResourceProcedure.input(z.object({ id: z.string().uuid() }).merge(repositoryReadinessInputSchema))
    .query(({ ctx, input }) => {
      const { id, ...readiness } = input;
      return createResourceServices(ctx.identity).repositoryService.getRepository(ctx.db, id, ctx.actor, readiness);
    }),
  create: resourceProcedure.input(createRepositorySchema).mutation(({ ctx, input }) =>
    createResourceServices(ctx.identity).repositoryService.createRepository(ctx.db, input, ctx.actor)),
  update: resourceProcedure.input(z.object({ id: z.string().uuid(), data: updateRepositorySchema }))
    .mutation(({ ctx, input }) => createResourceServices(ctx.identity).repositoryService.updateRepository(ctx.db, input.id, input.data, ctx.actor)),
  archive: resourceProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ ctx, input }) =>
    createResourceServices(ctx.identity).repositoryService.archiveRepository(ctx.db, input.id, ctx.actor)),
  readiness: ordinaryResourceProcedure.input(z.object({ id: z.string().uuid() }).merge(repositoryReadinessInputSchema))
    .query(({ ctx, input }) => {
      const { id, ...readiness } = input;
      return createResourceServices(ctx.identity).repositoryService.getRepositoryReadiness(ctx.db, id, ctx.actor, readiness);
    }),
  listForRequirement: ordinaryResourceProcedure.input(z.object({ requirementId: z.string().uuid() }))
    .query(({ ctx, input }) => createResourceServices(ctx.identity).repositoryService.listRequirementRepositories(ctx.db, input.requirementId, ctx.actor)),
  addToRequirement: resourceProcedure
    .input(z.object({ requirementId: z.string().uuid() }).merge(addRequirementRepositorySchema))
    .mutation(({ ctx, input }) => {
      const { requirementId, ...data } = input;
      return createResourceServices(ctx.identity).repositoryService.addRequirementRepository(ctx.db, requirementId, data, ctx.actor);
    }),
  removeFromRequirement: resourceProcedure
    .input(z.object({ requirementId: z.string().uuid(), repositoryId: z.string().uuid() }))
    .mutation(({ ctx, input }) => createResourceServices(ctx.identity).repositoryService.removeRequirementRepository(
      ctx.db, input.requirementId, input.repositoryId, ctx.actor,
    )),
  retryDelivery: resourceProcedure.input(z.object({
    linkId: z.string().uuid(),
    reason: z.string().trim().min(3).max(1000).optional(),
  })).mutation(({ ctx, input }) => createResourceServices(ctx.identity).repositoryService.retryRequirementRepositoryDelivery(
    ctx.db,
    input.linkId,
    ctx.actor,
    input.reason,
  )),
  manualHandoff: resourceProcedure.input(z.object({
    linkId: z.string().uuid(),
    reason: z.string().trim().min(3).max(1000),
  })).mutation(({ ctx, input }) => createResourceServices(ctx.identity).repositoryService.handoffRequirementRepositoryDelivery(
    ctx.db,
    input.linkId,
    input.reason,
    ctx.actor,
  )),
  listForTask: ordinaryResourceProcedure.input(z.object({ taskId: z.string().uuid() }))
    .query(({ ctx, input }) => createResourceServices(ctx.identity).repositoryService.listTaskRepositories(ctx.db, input.taskId, ctx.actor)),
  addToTask: resourceProcedure.input(z.object({ taskId: z.string().uuid() }).merge(addTaskRepositorySchema))
    .mutation(({ ctx, input }) => {
      const { taskId, ...data } = input;
      return createResourceServices(ctx.identity).repositoryService.addTaskRepository(ctx.db, taskId, data, ctx.actor);
    }),
  removeFromTask: resourceProcedure.input(z.object({ taskId: z.string().uuid(), repositoryId: z.string().uuid() }))
    .mutation(({ ctx, input }) => createResourceServices(ctx.identity).repositoryService.removeTaskRepository(ctx.db, input.taskId, input.repositoryId, ctx.actor)),
});
