import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createDb, runMigrations } from "@task-weaver/db";
import { initRealtime, subscribe } from "@task-weaver/realtime";
import {
  partnersGatewayService,
  skillPresetService,
  skillPackageStorageService,
  webhookService,
} from "@task-weaver/core";
import { actorMiddleware, type Env } from "./middleware/actor.js";
import { apiKeyMiddleware } from "./middleware/api-key.js";
import projectRoutes from "./routes/projects.js";
import taskRoutes from "./routes/tasks.js";
import documentRoutes from "./routes/documents.js";
import searchRoutes from "./routes/search.js";
import requirementRoutes from "./routes/requirements.js";
import activityRoutes from "./routes/activity.js";
import apiKeyRoutes from "./routes/api-keys.js";
import webhookRoutes from "./routes/webhooks.js";
import contextRoutes from "./routes/context.js";
import mcpRoutes from "./routes/mcp.js";
import memoryRoutes from "./routes/memory.js";
import scheduleRoutes from "./routes/schedules.js";
import piAgentRoutes from "./routes/pi-agent.js";
import assistantRoutes from "./routes/assistant.js";
import planRoutes from "./routes/plans.js";
import graphqlRoutes from "./graphql/index.js";
import daemonRoutes from "./routes/daemons.js";
import observabilityRoutes from "./routes/observability.js";
import repositoryRoutes from "./routes/repositories.js";
import reviewRoutes from "./routes/reviews.js";
import embeddingRoutes from "./routes/embeddings.js";
import { mcpPool } from "./mcp-pool.js";
import { resolve } from "node:path";
import {
  createPiAgentGatewayWorkerFromEnv,
  registerPiAgentGatewayRuntime,
} from "./pi-agent-gateway-worker.js";

// Initialize database
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

// Run database migrations before starting the server
try {
  await runMigrations(databaseUrl);
  console.log("Database migrations completed");
} catch (err) {
  console.error("Failed to run database migrations:", err);
  process.exit(1);
}

const db = createDb(databaseUrl);

// Import Git-managed global skills after migrations and before serving requests.
// Every API replica runs this idempotent sync; a transaction advisory lock keeps
// concurrent startups from creating duplicate package versions.
if (process.env.TW_PRESET_SKILLS_SYNC !== "disabled") {
  const storageDirectory = process.env.SKILL_PACKAGE_STORAGE_DIR
    ?? resolve(process.cwd(), "data", "skill-packages");
  try {
    const presetSync = await skillPresetService.syncGitManagedSkillPackages(
      db,
      new skillPackageStorageService.LocalSkillPackageStorageAdapter(storageDirectory),
    );
    console.log("Git-managed skill presets synchronized", presetSync);
  } catch (err) {
    console.error("Failed to synchronize Git-managed skill presets:", err);
    process.exit(1);
  }
}

// Enable PG NOTIFY so REST mutations broadcast events to other processes (e.g. web SSE)
initRealtime(databaseUrl).catch((err) => {
  console.error("Failed to initialize realtime (PG NOTIFY):", err);
});

// Subscribe to realtime events and deliver to webhooks
subscribe((event) => {
  webhookService.deliverEvent(db, event).catch((err) => {
    console.error("Webhook delivery error:", err);
  });
});

// Create Hono app with typed variables
const app = new Hono<Env>();

// Inject database instance into context for all routes
app.use("*", async (c, next) => {
  c.set("db", db);
  await next();
});

// Authenticate via API key (if Bearer token present), then extract actor
app.use("*", apiKeyMiddleware);
app.use("*", actorMiddleware);

// Health check endpoint
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Mount REST API routes under /api/v1
app.route("/api/v1/projects", projectRoutes);
app.route("/api/v1", taskRoutes);
app.route("/api/v1/documents", documentRoutes);
app.route("/api/v1/search", searchRoutes);
app.route("/api/v1", requirementRoutes);
app.route("/api/v1/activity", activityRoutes);
app.route("/api/v1/api-keys", apiKeyRoutes);
app.route("/api/v1/webhooks", webhookRoutes);
app.route("/api/v1/context", contextRoutes);
app.route("/api/v1/mcp", mcpRoutes);
app.route("/api/v1/memories", memoryRoutes);
app.route("/api/v1", scheduleRoutes);
app.route("/api/v1/pi-agent", piAgentRoutes);
app.route("/api/v1/assistant", assistantRoutes);
app.route("/api/v1/plans", planRoutes);
app.route("/api/v1/graphql", graphqlRoutes);
app.route("/api/v1/daemons", daemonRoutes);
app.route("/api/v1/observability", observabilityRoutes);
app.route("/api/v1", repositoryRoutes);
app.route("/api/v1", reviewRoutes);
app.route("/api/v1/embeddings", embeddingRoutes);

// Start MCP connection pool idle reaper
mcpPool.startIdleReaper();

const gatewayConfig = partnersGatewayService.getPartnersGatewayConfig();
const piAgentGatewayWorker = createPiAgentGatewayWorkerFromEnv(db, gatewayConfig);
registerPiAgentGatewayRuntime(gatewayConfig, piAgentGatewayWorker);
piAgentGatewayWorker?.start();

// Start the server
const port = Number(process.env.PORT) || 3001;

const server = serve(
  { fetch: app.fetch, port },
  (info) => {
    console.log(`Task Weaver API server running on http://localhost:${info.port}`);
  },
);

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  server.close();
  await piAgentGatewayWorker?.stop();
  mcpPool.stopIdleReaper();
  await mcpPool.disconnectAll();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export default app;
