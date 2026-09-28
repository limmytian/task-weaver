import { z } from "zod";
import { router, publicProcedure } from "../init";
import {
  acquireDueSchedulesSchema,
  createScheduleSchema,
  listSchedulesSchema,
  scheduleService,
  updateScheduleSchema,
} from "@task-weaver/core";

export const scheduleRouter = router({
  list: publicProcedure
    .input(listSchedulesSchema)
    .query(async ({ ctx, input }) => scheduleService.listSchedules(ctx.db, input)),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => scheduleService.getSchedule(ctx.db, input.id)),

  create: publicProcedure
    .input(createScheduleSchema)
    .mutation(async ({ ctx, input }) => scheduleService.createSchedule(ctx.db, input, ctx.actor)),

  update: publicProcedure
    .input(z.object({ id: z.string().uuid(), data: updateScheduleSchema }))
    .mutation(async ({ ctx, input }) => scheduleService.updateSchedule(ctx.db, input.id, input.data, ctx.actor)),

  archive: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => scheduleService.archiveSchedule(ctx.db, input.id, ctx.actor)),

  runNow: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => scheduleService.runScheduleNow(ctx.db, input.id, ctx.actor)),

  runs: publicProcedure
    .input(z.object({ scheduleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => scheduleService.listScheduleRuns(ctx.db, input.scheduleId)),

  acquireDue: publicProcedure
    .input(acquireDueSchedulesSchema)
    .mutation(async ({ ctx, input }) => scheduleService.acquireDueSchedules(ctx.db, input, ctx.actor)),
});
