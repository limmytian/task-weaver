import { router, resourceProcedure } from "../init";
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
  list: resourceProcedure.query(async ({ ctx }) => {
    return daemonService.listOnlineDaemons(ctx.db);
  }),
  queues: resourceProcedure.query(async ({ ctx }) => {
    return daemonService.listDaemonControlPlaneQueues(ctx.db);
  }),
  overview: resourceProcedure
    .input(daemonObservabilityQuerySchema)
    .query(({ ctx, input }) => daemonObservabilityService.getDaemonObservabilityOverview(ctx.db, input)),
  slo: resourceProcedure
    .input(daemonSloQuerySchema)
    .query(({ ctx, input }) => daemonSloService.getDaemonSloReport(ctx.db, input)),
  metrics: resourceProcedure
    .input(daemonMetricsQuerySchema)
    .query(({ ctx, input }) => daemonMetricsService.getDaemonMetricsReport(ctx.db, input)),
  control: resourceProcedure
    .input(z.object({ daemonId: z.string().uuid() }).merge(requestDaemonControlSchema))
    .mutation(({ ctx, input }) => daemonService.requestDaemonControl(
      ctx.db,
      input.daemonId,
      input.action,
      input.reason,
      ctx.actor,
    )),
  timeline: resourceProcedure
    .input(daemonTimelineQuerySchema)
    .query(({ ctx, input }) => daemonProgressService.listRequirementTimeline(ctx.db, input)),
  history: resourceProcedure
    .input(daemonHistoryQuerySchema)
    .query(({ ctx, input }) => daemonProgressService.listCorrelatedHistory(ctx.db, input)),
});
