import { z } from "zod";
import { router, resourceProcedure } from "../init";
import {
  acquireDueSchedulesSchema,
  createScheduleSchema,
  listSchedulesSchema,
  scheduleService,
  updateScheduleSchema,
} from "@task-weaver/core";

export const scheduleRouter = router({
  list: resourceProcedure
    .input(listSchedulesSchema)
    .query(async ({ ctx, input }) => scheduleService.listSchedules(ctx.db, input)),

  get: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => scheduleService.getSchedule(ctx.db, input.id)),

  create: resourceProcedure
    .input(createScheduleSchema)
    .mutation(async ({ ctx, input }) => scheduleService.createSchedule(ctx.db, input, ctx.actor)),

  update: resourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateScheduleSchema }))
    .mutation(async ({ ctx, input }) => scheduleService.updateSchedule(ctx.db, input.id, input.data, ctx.actor)),

  archive: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => scheduleService.archiveSchedule(ctx.db, input.id, ctx.actor)),

  runNow: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => scheduleService.runScheduleNow(ctx.db, input.id, ctx.actor)),

  runs: resourceProcedure
    .input(z.object({ scheduleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => scheduleService.listScheduleRuns(ctx.db, input.scheduleId)),

  acquireDue: resourceProcedure
    .input(acquireDueSchedulesSchema)
    .mutation(async ({ ctx, input }) => scheduleService.acquireDueSchedules(ctx.db, input, ctx.actor)),
});
