import { router, resourceProcedure, ordinaryResourceProcedure } from "../init";
import {
  createResourceServices,
  executorToolSchema,
  resumeExecutorSchema,

  daemonSloService,
  daemonSloQuerySchema,
  daemonObservabilityQuerySchema,

  daemonMetricsQuerySchema,

  daemonHistoryQuerySchema,
  daemonTimelineQuerySchema,
  requestDaemonControlSchema,
} from "@task-weaver/core";
import { z } from "zod";

export const daemonRouter = router({
  executorDaemons: ordinaryResourceProcedure.query(({ ctx }) => createResourceServices(ctx.identity).daemonService.listExecutorDaemons(ctx.db)),
  executorProfiles: ordinaryResourceProcedure.input(z.object({ daemonId: z.string().uuid() }))
    .query(({ ctx, input }) => createResourceServices(ctx.identity).daemonService.listExecutorProfiles(ctx.db, input.daemonId)),
  executorHistory: ordinaryResourceProcedure.input(z.object({ daemonId: z.string().uuid() }))
    .query(({ ctx, input }) => createResourceServices(ctx.identity).daemonService.listExecutorAvailabilityHistory(ctx.db, input.daemonId)),
  resumeExecutor: ordinaryResourceProcedure.input(z.object({ daemonId: z.string().uuid(), tool: executorToolSchema }).merge(resumeExecutorSchema))
    .mutation(({ ctx, input }) => createResourceServices(ctx.identity).daemonService.requestExecutorResume(ctx.db, input.daemonId, input.tool, input, ctx.actor)),
  refreshExecutor: ordinaryResourceProcedure.input(z.object({ daemonId: z.string().uuid(), tool: executorToolSchema }))
    .mutation(({ ctx, input }) => createResourceServices(ctx.identity).daemonService.requestExecutorRefresh(ctx.db, input.daemonId, input.tool)),
  list: resourceProcedure.query(async ({ ctx }) => {
    return createResourceServices(ctx.identity).daemonService.listOnlineDaemons(ctx.db);
  }),
  queues: ordinaryResourceProcedure.query(async ({ ctx }) => {
    return createResourceServices(ctx.identity).daemonService.listDaemonControlPlaneQueues(ctx.db);
  }),
  overview: ordinaryResourceProcedure
    .input(daemonObservabilityQuerySchema)
    .query(({ ctx, input }) => createResourceServices(ctx.identity).daemonObservabilityService.getDaemonObservabilityOverview(ctx.db, input)),
  slo: resourceProcedure
    .input(daemonSloQuerySchema)
    .query(({ ctx, input }) => daemonSloService.getDaemonSloReport(ctx.db, input)),
  metrics: ordinaryResourceProcedure
    .input(daemonMetricsQuerySchema)
    .query(({ ctx, input }) => createResourceServices(ctx.identity).daemonMetricsService.getDaemonMetricsReport(ctx.db, input)),
  control: resourceProcedure
    .input(z.object({ daemonId: z.string().uuid() }).merge(requestDaemonControlSchema))
    .mutation(({ ctx, input }) => createResourceServices(ctx.identity).daemonService.requestDaemonControl(
      ctx.db,
      input.daemonId,
      input.action,
      input.reason,
      ctx.actor,
    )),
  timeline: ordinaryResourceProcedure
    .input(daemonTimelineQuerySchema)
    .query(({ ctx, input }) => createResourceServices(ctx.identity).daemonProgressService.listRequirementTimeline(ctx.db, input)),
  history: ordinaryResourceProcedure
    .input(daemonHistoryQuerySchema)
    .query(({ ctx, input }) => createResourceServices(ctx.identity).daemonProgressService.listCorrelatedHistory(ctx.db, input)),
});
