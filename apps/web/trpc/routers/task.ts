import { z } from "zod";
import { router, publicProcedure } from "../init";
import {
  taskService,
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
  list: publicProcedure
    .input(listTasksSchema)
    .query(async ({ ctx, input }) => {
      return taskService.listTasks(ctx.db, input);
    }),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return taskService.getTaskDetail(ctx.db, input.id);
    }),

  create: publicProcedure
    .input(createTaskSchema)
    .mutation(async ({ ctx, input }) => {
      return taskService.createTask(ctx.db, input, ctx.actor);
    }),

  listPersonal: publicProcedure
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
      return taskService.listTasks(ctx.db, {
        ...(input ?? {}),
        scope: "personal",
        personalOwnerId: input?.personalOwnerId ?? ctx.actor.id,
        personalOwnerType: input?.personalOwnerType ?? ctx.actor.type,
      });
    }),

  createPersonal: publicProcedure
    .input(createPersonalTaskSchema)
    .mutation(async ({ ctx, input }) => {
      return taskService.createPersonalTask(ctx.db, input, ctx.actor);
    }),

  update: publicProcedure
    .input(z.object({ id: z.string().uuid(), data: updateTaskSchema }))
    .mutation(async ({ ctx, input }) => {
      return taskService.updateTask(ctx.db, input.id, input.data, ctx.actor);
    }),

  updateStatus: publicProcedure
    .input(z.object({ id: z.string().uuid() }).merge(updateTaskStatusSchema))
    .mutation(async ({ ctx, input }) => {
      return taskService.updateTaskStatus(
        ctx.db,
        input.id,
        input.status,
        ctx.actor,
        input.reason,
      );
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return taskService.deleteTask(ctx.db, input.id, ctx.actor);
    }),

  removeDependency: publicProcedure
    .input(z.object({ depId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return taskService.removeTaskDependency(ctx.db, input.depId);
    }),

  addComment: publicProcedure
    .input(z.object({ taskId: z.string().uuid() }).merge(createTaskCommentSchema))
    .mutation(async ({ ctx, input }) => {
      return taskService.addTaskComment(ctx.db, input.taskId, input.content, ctx.actor);
    }),

  addNote: publicProcedure
    .input(z.object({ taskId: z.string().uuid() }).merge(createTaskNoteSchema))
    .mutation(async ({ ctx, input }) => {
      return taskService.addTaskNote(
        ctx.db,
        input.taskId,
        input.content,
        input.pinned,
        ctx.actor,
      );
    }),

  addDependency: publicProcedure
    .input(z.object({ taskId: z.string().uuid() }).merge(createTaskDependencySchema))
    .mutation(async ({ ctx, input }) => {
      return taskService.addTaskDependency(
        ctx.db,
        input.taskId,
        input.dependsOnTaskId,
        input.type,
        ctx.actor,
        input.description,
      );
    }),

  board: publicProcedure
    .input(z.object({
      projectId: z.string().uuid(),
      includeTerminal: z.boolean().optional(),
      completedWithinDays: z.number().int().min(0).optional(),
    }))
    .query(async ({ ctx, input }) => {
      return taskService.getKanbanBoard(ctx.db, input.projectId, {
        includeTerminal: input.includeTerminal,
        completedWithinDays: input.completedWithinDays,
      });
    }),

  gantt: publicProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return taskService.getGanttChart(ctx.db, input.projectId);
    }),

  dependencyGraph: publicProcedure
    .input(z.object({ requirementId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return taskService.getRequirementTaskDependencyGraph(ctx.db, input.requirementId);
    }),
});
