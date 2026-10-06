import { z } from "zod";
import { router, ordinaryResourceProcedure as resourceProcedure } from "../init";
import {
  createResourceServices,
  createTaskSchema,
  createPersonalTaskSchema,
  updateTaskSchema,
  updateTaskStatusSchema,
  listTasksSchema,
  createTaskCommentSchema,
  createTaskNoteSchema,
  createTaskDependencySchema,
} from "@task-weaver/core";

export const taskRouter = router({
  list: resourceProcedure
    .input(listTasksSchema)
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.listTasks(ctx.db, input);
    }),

  get: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.getTaskDetail(ctx.db, input.id);
    }),

  create: resourceProcedure
    .input(createTaskSchema)
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.createTask(ctx.db, input, ctx.actor);
    }),

  listPersonal: resourceProcedure
    .input(z.object({
      personalOwnerId: z.string().optional(),
      personalOwnerType: z.enum(["human", "agent"]).optional(),
      status: z.enum(["todo", "in_progress", "in_review", "done", "cancelled"]).optional(),
      assignee: z.string().optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
      tag: z.string().optional(),
      completedWithinDays: z.number().int().min(0).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.listTasks(ctx.db, {
        ...(input ?? {}),
        scope: "personal",
        personalOwnerId: input?.personalOwnerId ?? (ctx.identity.actor.type === "human" ? ctx.identity.actor.id : ctx.identity.actor.managedByActorId),
        personalOwnerType: input?.personalOwnerType ?? "human",
      });
    }),

  createPersonal: resourceProcedure
    .input(createPersonalTaskSchema)
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.createPersonalTask(ctx.db, input, ctx.actor);
    }),

  update: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateTaskSchema }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.updateTask(ctx.db, input.id, input.data, ctx.actor);
    }),

  updateStatus: resourceProcedure
    .input(z.object({ id: z.string().uuid() }).merge(updateTaskStatusSchema))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.updateTaskStatus(
        ctx.db,
        input.id,
        input.status,
        ctx.actor,
        input.reason,
      );
    }),

  delete: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.deleteTask(ctx.db, input.id, ctx.actor);
    }),

  removeDependency: resourceProcedure
    .input(z.object({ depId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.removeTaskDependency(ctx.db, input.depId);
    }),

  addComment: resourceProcedure
    .input(z.object({ taskId: z.string().uuid() }).merge(createTaskCommentSchema))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.addTaskComment(ctx.db, input.taskId, input.content, ctx.actor);
    }),

  addNote: resourceProcedure
    .input(z.object({ taskId: z.string().uuid() }).merge(createTaskNoteSchema))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.addTaskNote(
        ctx.db,
        input.taskId,
        input.content,
        input.pinned,
        ctx.actor,
      );
    }),

  addDependency: resourceProcedure
    .input(z.object({ taskId: z.string().uuid() }).merge(createTaskDependencySchema))
    .mutation(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.addTaskDependency(
        ctx.db,
        input.taskId,
        input.dependsOnTaskId,
        input.type,
        ctx.actor,
        input.description,
      );
    }),

  board: resourceProcedure
    .input(z.object({
      projectId: z.string().uuid(),
      includeTerminal: z.boolean().optional(),
      completedWithinDays: z.number().int().min(0).optional(),
    }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.getKanbanBoard(ctx.db, input.projectId, {
        includeTerminal: input.includeTerminal,
        completedWithinDays: input.completedWithinDays,
      });
    }),

  gantt: resourceProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.getGanttChart(ctx.db, input.projectId);
    }),

  dependencyGraph: resourceProcedure
    .input(z.object({ requirementId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return createResourceServices(ctx.identity).taskService.getRequirementTaskDependencyGraph(ctx.db, input.requirementId);
    }),
});
