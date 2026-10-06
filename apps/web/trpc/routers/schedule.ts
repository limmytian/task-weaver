import { z } from "zod";
import { router, resourceProcedure, ordinaryResourceProcedure } from "../init";
import {
  acquireDueSchedulesSchema,
  createScheduleSchema,
  listSchedulesSchema,
  createResourceServices,
  updateScheduleSchema,
} from "@task-weaver/core";

export const scheduleRouter = router({
  list: ordinaryResourceProcedure
    .input(listSchedulesSchema)
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).scheduleService.listSchedules(ctx.db, input)),

  get: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).scheduleService.getSchedule(ctx.db, input.id)),

  create: ordinaryResourceProcedure
    .input(createScheduleSchema)
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).scheduleService.createSchedule(ctx.db, input, ctx.actor)),

  update: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid(), data: updateScheduleSchema }))
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).scheduleService.updateSchedule(ctx.db, input.id, input.data, ctx.actor)),

  archive: ordinaryResourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).scheduleService.archiveSchedule(ctx.db, input.id, ctx.actor)),

  runNow: resourceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).scheduleService.runScheduleNow(ctx.db, input.id, ctx.actor)),

  runs: ordinaryResourceProcedure
    .input(z.object({ scheduleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => createResourceServices(ctx.identity).scheduleService.listScheduleRuns(ctx.db, input.scheduleId)),

  acquireDue: resourceProcedure
    .input(acquireDueSchedulesSchema)
    .mutation(async ({ ctx, input }) => createResourceServices(ctx.identity).scheduleService.acquireDueSchedules(ctx.db, input, ctx.actor)),
});
