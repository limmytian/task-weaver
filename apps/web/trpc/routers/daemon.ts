import { router, resourceProcedure, ordinaryResourceProcedure } from "../init";
import {
  createResourceServices,

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
