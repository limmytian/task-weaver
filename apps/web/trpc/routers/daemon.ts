import { router, publicProcedure } from "../init";
import {
  daemonProgressService,
  daemonService,
  daemonSloService,
  daemonSloQuerySchema,
  daemonObservabilityQuerySchema,
  daemonObservabilityService,
  daemonMetricsQuerySchema,
  daemonMetricsService,
  daemonHistoryQuerySchema,
  daemonTimelineQuerySchema,
  requestDaemonControlSchema,
} from "@task-weaver/core";
import { z } from "zod";

export const daemonRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    return daemonService.listOnlineDaemons(ctx.db);
  }),
  queues: publicProcedure.query(async ({ ctx }) => {
    return daemonService.listDaemonControlPlaneQueues(ctx.db);
  }),
  overview: publicProcedure
    .input(daemonObservabilityQuerySchema)
    .query(({ ctx, input }) => daemonObservabilityService.getDaemonObservabilityOverview(ctx.db, input)),
  slo: publicProcedure
    .input(daemonSloQuerySchema)
    .query(({ ctx, input }) => daemonSloService.getDaemonSloReport(ctx.db, input)),
  metrics: publicProcedure
    .input(daemonMetricsQuerySchema)
    .query(({ ctx, input }) => daemonMetricsService.getDaemonMetricsReport(ctx.db, input)),
  control: publicProcedure
    .input(z.object({ daemonId: z.string().uuid() }).merge(requestDaemonControlSchema))
    .mutation(({ ctx, input }) => daemonService.requestDaemonControl(
      ctx.db,
      input.daemonId,
      input.action,
      input.reason,
      ctx.actor,
    )),
  timeline: publicProcedure
    .input(daemonTimelineQuerySchema)
    .query(({ ctx, input }) => daemonProgressService.listRequirementTimeline(ctx.db, input)),
  history: publicProcedure
    .input(daemonHistoryQuerySchema)
    .query(({ ctx, input }) => daemonProgressService.listCorrelatedHistory(ctx.db, input)),
});
