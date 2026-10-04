import { Hono } from "hono";
import type { Database } from "@task-weaver/db";
import { initRealtime, shutdown as shutdownRealtime, subscribe } from "@task-weaver/realtime";
import type { RealtimeEvent } from "@task-weaver/realtime";
import {
  skillPackageStorageService,
  skillPresetService,
  webhookService,
} from "@task-weaver/core";
import { resolve } from "node:path";
import { actorMiddleware, type Env } from "./middleware/actor.js";
import { apiKeyMiddleware } from "./middleware/api-key.js";
import agentUsageRoutes from "./routes/agent-usage.js";
import activityRoutes from "./routes/activity.js";
import apiKeyRoutes from "./routes/api-keys.js";
import assistantRoutes from "./routes/assistant.js";
import contextRoutes from "./routes/context.js";
import daemonRoutes from "./routes/daemons.js";
import documentRoutes from "./routes/documents.js";
import embeddingRoutes from "./routes/embeddings.js";
import graphqlRoutes from "./graphql/index.js";
import mcpRoutes from "./routes/mcp.js";
import memoryRoutes from "./routes/memory.js";
import observabilityRoutes from "./routes/observability.js";
import tiRoutes from "./routes/ti.js";
import planRoutes from "./routes/plans.js";
import projectRoutes from "./routes/projects.js";
import repositoryRoutes from "./routes/repositories.js";
import requirementRoutes from "./routes/requirements.js";
import reviewRoutes from "./routes/reviews.js";
import scheduleRoutes from "./routes/schedules.js";
import searchRoutes from "./routes/search.js";
import taskRoutes from "./routes/tasks.js";
import versionRoutes from "./routes/version.js";
import webhookRoutes from "./routes/webhooks.js";
import { mcpPool } from "./mcp-pool.js";
import { createPartnersGatewayRuntime } from "@task-weaver/partners-gateway/runtime";

export const TASK_WEAVER_VERSION = "0.3.1" as const;

interface ApplicationLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
}
interface ApiRuntimeContext { db: Database; logger: ApplicationLogger; signal: AbortSignal }
interface ApplicationServices {
  apiRoutes: Array<{ id: string; method: string; path: string; mountPath?: string; route: Hono<any> }>;
  workers: Array<{ id: string; start(context: ApiRuntimeContext): void | Promise<void>; stop?(context: ApiRuntimeContext): Promise<void> }>;
  eventSubscribers: Array<{ id: string; eventTypes: readonly RealtimeEvent["type"][]; handle(event: RealtimeEvent, context: ApiRuntimeContext): void | Promise<void> }>;
  healthChecks: Array<{ id: string; check(): { status: "healthy" | "degraded" } }>;
}
export interface ApiApplicationOptions {
  db: Database;
  databaseUrl: string;
  env?: NodeJS.ProcessEnv;
  logger?: ApplicationLogger;
  runtimeDependencies?: Partial<ApiRuntimeDependencies>;
}

export interface ApiRuntimeDependencies {
  initRealtime(connectionString: string): Promise<void>;
  shutdownRealtime(): Promise<void>;
  subscribe(listener: (event: RealtimeEvent) => void): () => void;
}

export interface ApiApplication {
  app: Hono<Env>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const consoleLogger: ApplicationLogger = {
  debug: (message, details) => console.debug(message, details ?? {}),
  info: (message, details) => console.info(message, details ?? {}),
  warn: (message, details) => console.warn(message, details ?? {}),
  error: (message, error) => console.error(message, error),
};

function applicationServices(env: NodeJS.ProcessEnv): ApplicationServices {
  return {
    apiRoutes: [
      { id: "agent-usage", method: "GET", path: "/api/v1/agent-usage", route: agentUsageRoutes },
      { id: "version", method: "GET", path: "/api/v1/version", route: versionRoutes },
      { id: "projects", method: "GET", path: "/api/v1/projects", route: projectRoutes },
      { id: "tasks", method: "GET", path: "/api/v1/tasks", mountPath: "/api/v1", route: taskRoutes },
      { id: "documents", method: "GET", path: "/api/v1/documents", route: documentRoutes },
      { id: "search", method: "GET", path: "/api/v1/search", route: searchRoutes },
      { id: "requirements", method: "GET", path: "/api/v1/requirements", mountPath: "/api/v1", route: requirementRoutes },
      { id: "activity", method: "GET", path: "/api/v1/activity", route: activityRoutes },
      { id: "api-keys", method: "GET", path: "/api/v1/api-keys", route: apiKeyRoutes },
      { id: "webhooks", method: "GET", path: "/api/v1/webhooks", route: webhookRoutes },
      { id: "context", method: "GET", path: "/api/v1/context", route: contextRoutes },
      { id: "mcp", method: "GET", path: "/api/v1/mcp", route: mcpRoutes },
      { id: "memories", method: "GET", path: "/api/v1/memories", route: memoryRoutes },
      { id: "schedules", method: "GET", path: "/api/v1/schedules", mountPath: "/api/v1", route: scheduleRoutes },
      { id: "ti-agent", method: "GET", path: "/api/v1/ti", route: tiRoutes },
      { id: "assistant", method: "GET", path: "/api/v1/assistant", route: assistantRoutes },
      { id: "plans", method: "POST", path: "/api/v1/plans", route: planRoutes },
      { id: "graphql", method: "POST", path: "/api/v1/graphql", route: graphqlRoutes },
      { id: "daemons", method: "GET", path: "/api/v1/daemons", route: daemonRoutes },
      { id: "observability", method: "GET", path: "/api/v1/observability", route: observabilityRoutes },
      { id: "repositories", method: "GET", path: "/api/v1/repositories", mountPath: "/api/v1", route: repositoryRoutes },
      { id: "reviews", method: "POST", path: "/api/v1/reviews", mountPath: "/api/v1", route: reviewRoutes },
      { id: "embeddings", method: "GET", path: "/api/v1/embeddings", route: embeddingRoutes },
    ],
    workers: [
      {
        id: "skill-preset-sync",
        start: async (context: ApiRuntimeContext) => {
          if (env.TW_PRESET_SKILLS_SYNC === "disabled") return;
          const storageDirectory = env.SKILL_PACKAGE_STORAGE_DIR
            ?? resolve(process.cwd(), "data", "skill-packages");
          const result = await skillPresetService.syncGitManagedSkillPackages(
            context.db,
            new skillPackageStorageService.LocalSkillPackageStorageAdapter(storageDirectory),
          );
          context.logger.info("Git-managed skill presets synchronized", { ...result });
        },
      },
      {
        id: "mcp-pool-reaper",
        start: () => mcpPool.startIdleReaper(),
        stop: async () => {
          mcpPool.stopIdleReaper();
          await mcpPool.disconnectAll();
        },
      },
    ],
    eventSubscribers: [{
      id: "webhook-delivery",
      eventTypes: [
        "task_created", "task_updated", "task_status_changed", "task_commented",
        "task_deleted", "task_claimed", "task_released", "document_created",
        "document_updated", "document_deleted", "document_linked", "document_unlinked",
        "document_task_linked", "document_task_unlinked", "requirement_created",
        "requirement_updated", "requirement_deleted", "requirement_claimed",
        "requirement_released", "repository_retry_requested", "daemon_status_changed",
        "daemon_progress_updated", "schedule_created", "schedule_updated",
        "schedule_run_created",
      ],
      handle: async (event, context: ApiRuntimeContext) => {
        await webhookService.deliverEvent(context.db, event);
      },
    }],
    healthChecks: [{ id: "core-api", check: () => ({ status: "healthy" as const }) }],
  };
}

export function createApiApplication(options: ApiApplicationOptions): ApiApplication {
  const logger = options.logger ?? consoleLogger;
  const runtimeDependencies: ApiRuntimeDependencies = {
    initRealtime,
    shutdownRealtime,
    subscribe,
    ...options.runtimeDependencies,
  };
  const env = options.env ?? process.env;
  const services = applicationServices(env);
  const gateway = createPartnersGatewayRuntime(options.db, env);
  services.apiRoutes.push(...gateway.apiRoutes);
  services.workers.push(...gateway.workers);
  services.eventSubscribers.push(...gateway.eventSubscribers);
  services.healthChecks.push(...gateway.healthChecks);
  const controller = new AbortController();
  const startedWorkers: typeof services.workers[number][] = [];
  const unsubscribe: Array<() => void> = [];
  let started = false;
  let stopped = false;
  const context: ApiRuntimeContext = {
    db: options.db,
    logger,
    signal: controller.signal,
  };
  const app = new Hono<Env>();
  app.use("*", async (requestContext, next) => {
    requestContext.set("db", options.db);
    await next();
  });
  app.use("*", apiKeyMiddleware);
  app.use("*", actorMiddleware);
  app.get("/health", async (requestContext) => {
    const checks = await Promise.all(services.healthChecks.map(async (healthCheck) => {
      try {
        return { id: healthCheck.id, ...await healthCheck.check() };
      } catch (error) {
        return {
          id: healthCheck.id,
          status: "unhealthy" as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    const status = checks.some((check) => check.status === "unhealthy")
      ? "unhealthy"
      : checks.some((check) => check.status === "degraded") ? "degraded" : "ok";
    return requestContext.json(
      { status, timestamp: new Date().toISOString(), checks },
      status === "unhealthy" ? 503 : 200,
    );
  });
  for (const route of services.apiRoutes) app.route(route.mountPath ?? route.path, route.route);

  async function stopRuntime(): Promise<void> {
    controller.abort();
    const errors: unknown[] = [];
    for (const worker of startedWorkers.reverse()) {
      try {
        await worker.stop?.(context);
      } catch (error) {
        errors.push(error);
      }
    }
    startedWorkers.length = 0;
    for (const removeSubscriber of unsubscribe.splice(0)) removeSubscriber();
    try {
      await runtimeDependencies.shutdownRealtime();
    } catch (error) {
      errors.push(error);
    }
    started = false;
    stopped = true;
    if (errors.length > 0) throw new AggregateError(errors, "API runtime shutdown failed");
  }

  return {
    app,
    async start() {
      if (started) return;
      if (stopped) throw new Error("API application cannot restart after shutdown");
      try {
        await runtimeDependencies.initRealtime(options.databaseUrl);
      } catch (error) {
        logger.error("Failed to initialize realtime (PG NOTIFY)", error);
      }
      for (const subscriber of services.eventSubscribers) {
        unsubscribe.push(runtimeDependencies.subscribe((event) => {
          if (!subscriber.eventTypes.includes(event.type)) return;
          Promise.resolve(subscriber.handle(event, context)).catch((error: unknown) => {
            logger.error(`Event subscriber '${subscriber.id}' failed`, error);
          });
        }));
      }
      try {
        for (const worker of services.workers) {
          await worker.start(context);
          startedWorkers.push(worker);
        }
        started = true;
      } catch (error) {
        await stopRuntime();
        throw error;
      }
    },
    stop: stopRuntime,
  };
}
