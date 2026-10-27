/** Owned loopback-only API process for the bounded mixed-workload comparison. */
import { serve } from "@hono/node-server";
import { mock } from "node:test";
import { createDb, measureDatabaseWork } from "@task-weaver/db";
import { createAuthenticationRuntime, createResourceServices, authenticationFailure } from "@task-weaver/core";
import { createApiApplication } from "./application";
import { fullQueueProjection } from "./performance-queue-projection";

if (!process.send || !process.env.TW_PERFORMANCE_DATABASE_URL) throw Error("Owned fixture IPC is required");
const url = new URL(process.env.TW_PERFORMANCE_DATABASE_URL);
if (url.hostname !== "127.0.0.1" || url.pathname !== "/tw_performance") throw Error("Only the disposable performance database is supported");
const db = createDb(url.href, { maxConnections: 1, measureQueries: true });
let application: ReturnType<typeof createApiApplication> | undefined;
let queueRead: ((request: Request) => Promise<Response>) | undefined;
const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
  if (!application) return new Response(null, { status: 503 });
  const { value, measurement } = await measureDatabaseWork(async () => {
    if (new URL(request.url).pathname === "/performance/queue" && queueRead) {
      try { return await queueRead(request); }
      catch (error) { const failure = authenticationFailure(error); return Response.json({ code: failure.code }, { status: failure.status }); }
    }
    return application!.app.fetch(request);
  });
  const headers = new Headers(value.headers);
  headers.set("x-tw-fixture-queries", String(measurement.queryCount));
  headers.set("x-tw-fixture-entry-ms", String(measurement.phases.transactionEntry.milliseconds));
  headers.set("x-tw-fixture-lock-ms", String(measurement.phases.identityLock.milliseconds));
  return new Response(value.body, { status: value.status, headers });
} }, info => process.send?.({ type: "listening", port: info.port }));
process.on("message", async (message: { type: string; variant?: string; configuration?: any }) => {
  if (message.type === "configure") {
    const configuration = message.configuration;
    if (message.variant === "legacy") {
      const transaction = db.transaction.bind(db);
      mock.method(db, "transaction", (callback: any, options: any) => transaction(async tx => {
        const read = tx.query.requirements.findMany.bind(tx.query.requirements);
        const capture = mock.method(tx.query.requirements, "findMany", (input: any) => read(input?.with?.workflowInputs && input?.with?.tasks ? fullQueueProjection(input) : input));
        try { return await callback(tx); } finally { capture.mock.restore(); }
      }, options));
    }
    const auth = createAuthenticationRuntime(db, configuration);
    application = createApiApplication({ db, databaseUrl: url.href, env: { TW_AUTH_SECRET: configuration.secret,
      TW_AUTH_BASE_URL: configuration.baseURL, TW_AUTH_TRUSTED_ORIGINS: configuration.trustedOrigins[0], TW_PRESET_SKILLS_SYNC: "disabled" } });
    // This fixture-only route runs normal verification and the unchanged live resource factory.
    queueRead = async request => {
      auth.assertOrigin(request.headers);
      const context = await auth.verify(request.headers);
      return Response.json(await createResourceServices(context).daemonService.listDaemonControlPlaneQueues(db));
    };
    process.send?.({ type: "ready" });
  } else if (message.type === "stop") {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await application?.stop(); await db.$client.end({ timeout: 2 }); mock.restoreAll(); process.disconnect();
  }
});
