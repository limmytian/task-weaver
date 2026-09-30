import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "@task-weaver/db";
import {
  getPartnersGatewayConfig,
  getPartnersGatewayWorkerConfig,
  type PartnersGatewayConfig,
} from "@task-weaver/partners-gateway";
import {
  TASK_WEAVER_MODULE_API_VERSION,
  defineTaskWeaverModule,
} from "@task-weaver/module-sdk";
import {
  checkPiAgentGatewayHealth,
  createPiAgentGatewayWorker,
  getPiAgentGatewayWorkerStatus,
  type PiAgentGatewayWorker,
} from "./worker.js";

const moduleId = "task-weaver.partners-gateway";

const gatewayConfigurationSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().url().optional(),
  serviceToken: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  defaultTimeoutSeconds: z.number().int().min(30).max(86_400),
}).superRefine((config, context) => {
  if (config.enabled !== Boolean(config.baseUrl && config.serviceToken)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A configured Partners Gateway requires both a URL and a service token",
    });
  }
});

export function createPartnersGatewayModule(db: Database, env: NodeJS.ProcessEnv = process.env) {
  const defaultConfig = getPartnersGatewayConfig(env);
  const workerConfig = defaultConfig.enabled ? getPartnersGatewayWorkerConfig(env) : null;
  let config: PartnersGatewayConfig = defaultConfig;
  let worker: PiAgentGatewayWorker | null = null;

  const routes = new Hono();
  routes.get("/status", (context) => context.json(getPiAgentGatewayWorkerStatus(config, worker)));
  routes.get("/health", async (context) => {
    const health = await checkPiAgentGatewayHealth(config);
    return context.json(health, health.ok ? 200 : 503);
  });

  return defineTaskWeaverModule({
    manifest: {
      apiVersion: TASK_WEAVER_MODULE_API_VERSION,
      id: moduleId,
      name: "Partners Gateway reference module",
      version: "0.2.0",
      supportedCoreVersion: "^0.2.0",
      capabilities: ["partners-gateway.execution"],
      permissions: [{
        id: "partners-gateway.worker.read",
        description: "Read the Partners Gateway worker status and health",
      }],
    },
    configuration: {
      schema: gatewayConfigurationSchema,
      defaultValue: defaultConfig,
      sensitiveKeys: ["serviceToken"],
    },
    apiRoutes: [{
      id: "partners-gateway-worker-controls",
      method: "GET",
      path: "/api/v1/pi-agent/worker",
      route: routes,
    }],
    workers: [{
      id: "partners-gateway-runner",
      start: (context: { composition: { configuration: Readonly<Record<string, unknown>> } }) => {
        config = context.composition.configuration[moduleId] as PartnersGatewayConfig;
        const resolvedWorkerConfig = workerConfig ?? getPartnersGatewayWorkerConfig(env);
        worker = createPiAgentGatewayWorker(db, config, resolvedWorkerConfig);
        worker?.start();
      },
      stop: async () => {
        await worker?.stop();
        worker = null;
      },
    }],
    eventSubscribers: [{
      id: "partners-gateway-scheduled-run",
      eventTypes: ["schedule_run_created"],
      handle: () => worker?.wake(),
    }],
    healthChecks: [{
      id: "partners-gateway-runtime",
      check: () => ({
        status: worker?.getStatus().lastError ? "degraded" as const : "healthy" as const,
      }),
    }],
  });
}
