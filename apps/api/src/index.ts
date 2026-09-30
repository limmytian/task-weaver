import { serve } from "@hono/node-server";
import { createDb, runCoreAndExtensionMigrations } from "@task-weaver/db";
import { createDefaultRuntimePorts } from "@task-weaver/core";
import { createApiApplication, TASK_WEAVER_CORE_VERSION } from "./application.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

const application = createApiApplication({
  db: createDb(databaseUrl),
  databaseUrl,
  ports: createDefaultRuntimePorts(),
  coreVersion: TASK_WEAVER_CORE_VERSION,
});

await runCoreAndExtensionMigrations(databaseUrl, application.composition);
console.log("Database migrations completed");
await application.start();

const port = Number(process.env.PORT) || 3001;
const server = serve(
  { fetch: application.app.fetch, port },
  (info) => console.log(`Task Weaver API server running on http://localhost:${info.port}`),
);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  let closeError: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  } catch (error) {
    closeError = error;
  } finally {
    await application.stop();
  }
  if (closeError) throw closeError;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      console.error("API shutdown failed", error);
      process.exitCode = 1;
    });
  });
}

export default application.app;
