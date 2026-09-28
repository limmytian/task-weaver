import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  daemonService,
  daemonProgressService,
  daemonSloService,
  ConflictError,
  NotFoundError,
  ValidationError,
  registerDaemonSchema,
  updateDaemonStatusSchema,
  requestDaemonControlSchema,
  reportDaemonProgressSchema,
  reconcileDaemonWorkerSchema,
  daemonProgressQuerySchema,
  daemonHistoryQuerySchema,
  daemonTimelineQuerySchema,
  daemonSloQuerySchema,
  daemonObservabilityQuerySchema,
  daemonObservabilityService,
  daemonMetricsQuerySchema,
  daemonMetricsService,
  applyTaskSchema,
  applyRequirementSchema,
  applyReviewSchema,
  applyMergeSchema,
  getDaemonConfig,
} from "@task-weaver/core";
import { serializeRealtimeEvent, subscribe } from "@task-weaver/realtime";
import type { Env } from "../middleware/actor.js";

const daemonsRouter = new Hono<Env>();

// Compatibility alias for daemon-scoped clients. The canonical endpoint is
// /api/v1/observability/overview.
daemonsRouter.get("/observability/overview", async (c) => {
  const parsed = daemonObservabilityQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await daemonObservabilityService.getDaemonObservabilityOverview(c.get("db"), parsed.data));
});

// GET / - List all online/active daemons
daemonsRouter.get("/", async (c) => {
  const db = c.get("db");
  const list = await daemonService.listOnlineDaemons(db);
  return c.json({ items: list });
});

// GET /slo - Production SLO dashboard and release-blocking alerts
daemonsRouter.get("/slo", async (c) => {
  const parsed = daemonSloQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await daemonSloService.getDaemonSloReport(c.get("db"), parsed.data));
});

// Compatibility alias for daemon-scoped clients. The canonical endpoint is
// /api/v1/observability/metrics.
daemonsRouter.get("/metrics", async (c) => {
  const parsed = daemonMetricsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await daemonMetricsService.getDaemonMetricsReport(c.get("db"), parsed.data));
});

// GET /progress/current - Inspect authoritative current worker progress
daemonsRouter.get("/progress/current", async (c) => {
  const parsed = daemonProgressQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json({
    items: await daemonProgressService.listWorkerProgress(c.get("db"), parsed.data),
  });
});

// GET /progress/history - Inspect append-only worker progress and handoff history
daemonsRouter.get("/progress/history", async (c) => {
  const parsed = daemonProgressQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json({
    items: await daemonProgressService.listWorkerProgressHistory(c.get("db"), parsed.data),
  });
});

daemonsRouter.get("/history", async (c) => {
  const parsed = daemonHistoryQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  return c.json(await daemonProgressService.listCorrelatedHistory(c.get("db"), parsed.data));
});

daemonsRouter.get("/logs", async (c) => {
  const parsed = daemonHistoryQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  const maxChars = Number(c.req.query("maxChars") ?? 4_000);
  return c.json(await daemonProgressService.listBoundedLogTail(c.get("db"), { ...parsed.data, maxChars }));
});

// GET /timeline/:requirementId - Correlate progress, tasks, review, retry, and delivery history
daemonsRouter.get("/timeline/:requirementId", async (c) => {
  const parsed = daemonTimelineQuerySchema.safeParse({
    requirementId: c.req.param("requirementId"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }
  try {
    return c.json(await daemonProgressService.listRequirementTimeline(c.get("db"), parsed.data));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// POST /:id/progress - Append a fenced worker progress event and update its current snapshot
daemonsRouter.post("/:id/progress", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = reportDaemonProgressSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await daemonProgressService.reportWorkerProgress(
      c.get("db"),
      c.req.param("id"),
      parsed.data,
      c.get("actor"),
    ));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// POST /:id/reconcile - Reconcile every uncertain task in an interrupted worker run
daemonsRouter.post("/:id/reconcile", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = reconcileDaemonWorkerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await daemonProgressService.reconcileWorkerRun(
      c.get("db"),
      c.req.param("id"),
      parsed.data,
      c.get("actor"),
    ));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// POST /register - Register or update a daemon
daemonsRouter.post("/register", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json().catch(() => ({}));

  const parsed = registerDaemonSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const daemon = await daemonService.registerDaemon(db, parsed.data, actor);
    return c.json(daemon, 201);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

// POST /:id/control - Request a durable pause, drain, or resume transition
daemonsRouter.post("/:id/control", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = requestDaemonControlSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await daemonService.requestDaemonControl(
      c.get("db"),
      c.req.param("id"),
      parsed.data.action,
      parsed.data.reason,
      c.get("actor"),
    ));
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// POST /:id/heartbeat - Heartbeat check-in
daemonsRouter.post("/:id/heartbeat", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");

  try {
    const daemon = await daemonService.heartbeatDaemon(db, id, actor);
    return c.json({ success: true, daemon });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 403);
    }
    throw err;
  }
});

// POST /:id/status - Directly update daemon status (e.g., set to idle after AI task completes)
daemonsRouter.post("/:id/status", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const parsed = updateDaemonStatusSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const daemon = await daemonService.updateDaemonStatus(
      db,
      id,
      parsed.data.status,
      parsed.data.activeTaskIds,
      parsed.data.activeWorkerStates,
      actor,
    );
    return c.json(daemon);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 403);
    }
    throw err;
  }
});

// POST /:id/apply-task - Pull and pre-lock an available task
daemonsRouter.post("/:id/apply-task", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const parsed = applyTaskSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await daemonService.applyTask(
      db,
      id,
      parsed.data.projectId,
      c.get("actor"),
    );
    if (!result) {
      return c.json({ task: null });
    }
    return c.json({ task: result.task });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// POST /:id/apply-requirement - Pull and pre-lock an available requirement lane
daemonsRouter.post("/:id/apply-requirement", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const parsed = applyRequirementSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const eligibility = parsed.data.includeDiagnostics
      ? await daemonService.explainRequirementEligibility(
          db,
          id,
          parsed.data.projectId,
          parsed.data.modelTiers,
          c.get("actor"),
        )
      : undefined;
    const result = await daemonService.applyRequirement(
      db,
      id,
      parsed.data.projectId,
      parsed.data.workerIndex,
      parsed.data.modelTiers,
      c.get("actor"),
    );
    if (!result) {
      return c.json({
        requirement: null,
        task: null,
        executionSlice: null,
        tasks: [],
        repositories: [],
        eligibility,
      });
    }
    if (eligibility) eligibility.selectedCount = 1;
    return c.json({
      requirement: result.requirement,
      task: result.task,
      executionSlice: result.executionSlice,
      tasks: result.tasks,
      repositories: result.repositories,
      executorTool: result.executorTool,
      eligibility,
      leaseGeneration: result.leaseGeneration,
      runId: result.runId,
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// POST /:id/apply-review - Pull and pre-lock an in-review requirement lane
daemonsRouter.post("/:id/apply-review", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const parsed = applyReviewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await daemonService.applyReview(
      db,
      id,
      parsed.data.projectId,
      parsed.data.workerIndex,
      c.get("actor"),
    );
    if (!result) {
      return c.json({ requirement: null, tasks: [], executionSlice: null, repositories: [] });
    }
    return c.json({
      requirement: result.requirement,
      tasks: result.tasks,
      executionSlice: result.executionSlice,
      repositories: result.repositories,
      leaseGeneration: result.leaseGeneration,
      runId: result.runId,
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// POST /:id/apply-merge - Pull and pre-lock a reviewed requirement lane ready to merge
daemonsRouter.post("/:id/apply-merge", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const parsed = applyMergeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await daemonService.applyMerge(
      db,
      id,
      parsed.data.projectId,
      parsed.data.workerIndex,
      c.get("actor"),
    );
    if (!result) {
      return c.json({ requirement: null, tasks: [], executionSlice: null, repositories: [] });
    }
    return c.json({
      requirement: result.requirement,
      tasks: result.tasks,
      executionSlice: result.executionSlice,
      repositories: result.repositories,
      leaseGeneration: result.leaseGeneration,
      runId: result.runId,
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// GET /events - SSE stream for daemon task notifications (optional, enabled via TW_DAEMON_MODE=sse)
daemonsRouter.get("/events", async (c) => {
  const config = getDaemonConfig();
  if (config.mode !== "sse") {
    return c.json({ error: "SSE mode is not enabled on this server. Set TW_DAEMON_MODE=sse to enable." }, 404);
  }

  return streamSSE(c, async (stream) => {
    const requestedRole = c.req.query("role");
    const lastEventId = c.req.header("Last-Event-ID");
    const lastSequence = lastEventId?.match(/-(\d+)$/)?.[1]
      ? Number(lastEventId.match(/-(\d+)$/)?.[1])
      : null;
    const unsubscribe = subscribe((event) => {
      if (lastSequence !== null && event.sequence !== undefined && event.sequence <= lastSequence) return;
      if (
        event.type === "task_created" ||
        event.type === "task_released" ||
        event.type === "requirement_created" ||
        event.type === "requirement_released" ||
        (event.type === "repository_retry_requested" &&
          (!requestedRole || event.targetRole === requestedRole))
      ) {
        stream.writeSSE({
          id: event.eventId,
          event: event.type,
          data: serializeRealtimeEvent(event),
        }).catch(() => {});
      }
    });

    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({
        serverTime: new Date().toISOString(),
        lastEventId: lastEventId ?? null,
        resume: lastEventId ? "best_effort" : "fresh",
      }),
    });

    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => {});
    }, 30_000);

    stream.onAbort(() => {
      unsubscribe();
      clearInterval(heartbeat);
    });

    // Keep stream alive until client disconnects
    await new Promise(() => {});
  });
});

export default daemonsRouter;
