import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { createDb, runMigrations, projects, requirements, tasks, piAgentRuns, activityLog } from "@task-weaver/db";
import { apiKeyService, piAgentService } from "@task-weaver/core";
import { createPartnersGatewayClient } from "@task-weaver/partners-gateway";
import { PiAgentGatewayWorker } from "@task-weaver/partners-gateway/worker";
import { createApiApplication } from "./application.js";

const databaseUrl = process.env.TW_GATEWAY_E2E_DATABASE_URL;

test("Partners Gateway persists HTTP/SSE execution in real PostgreSQL", {
  skip: !databaseUrl,
  timeout: 60_000,
}, async (t) => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, "127.0.0.1", "Use a disposable loopback database only");
  assert.equal(url.pathname, "/tw_gateway_e2e");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  const key = await apiKeyService.createApiKey(db, { name: "gateway-e2e" });
  const actor = { id: `apikey:${key.id}`, type: "agent" as const };
  const [project] = await db.insert(projects).values({ name: "Gateway E2E", createdBy: actor.id }).returning();
  const [requirement] = await db.insert(requirements).values({ projectId: project!.id, title: "Gateway E2E", createdBy: actor.id }).returning();
  let scenario = "succeeded";
  let submissions = 0;
  let transientFailures = 0;
  const requests: string[] = [];
  const gateway = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== "Bearer fixture-token") {
      response.writeHead(401).end("Unauthorized");
      return;
    }
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.executionMode, "ephemeral_interpreter");
      assert.ok(body.inputs.files[0].content.includes("Gateway E2E"));
      submissions++;
      if (transientFailures-- > 0) {
        response.writeHead(503).end("Try again");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: body.id, state: "running", executionMode: "ephemeral_interpreter" }));
      return;
    }
    if (request.url?.endsWith("/events")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      await delay(40);
      const event = `data: ${JSON.stringify({ type: "log.stdout", sequence: 1, state: "running", chunk: "Gateway E2E progress" })}\n\n`;
      response.write(event.slice(0, 17));
      await delay(10);
      response.write(event.slice(17));
      await delay(200);
      if (scenario !== "polling") {
        response.write(`data: ${JSON.stringify({ type: "job.state", sequence: 2, state: scenario })}\n\n`);
      }
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/artifacts")) {
      response.end(JSON.stringify({ items: [{ id: "result", path: "/workspace/result.json", content: "private payload" }] }));
    } else {
      response.end(JSON.stringify({ id: request.url?.split("/").at(-1), state: "succeeded", executionMode: "ephemeral_interpreter" }));
    }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  assert.ok(address && typeof address !== "string");
  const config = { enabled: true, baseUrl: `http://127.0.0.1:${address.port}`, serviceToken: "fixture-token", defaultTimeoutSeconds: 900 };
  const env = {
    PARTNERS_GATEWAY_URL: config.baseUrl,
    PARTNERS_GATEWAY_SERVICE_TOKEN: config.serviceToken,
    PARTNERS_GATEWAY_WORKER_ACTOR_ID: actor.id,
    PARTNERS_GATEWAY_WORKER_ASSIGNED_AGENT_ID: "gateway-e2e-agent",
    PARTNERS_GATEWAY_WORKER_IDLE_POLL_MS: "100",
    TW_PRESET_SKILLS_SYNC: "disabled",
  };
  const application = createApiApplication({ db, databaseUrl: databaseUrl!, env });
  const api = serve({ fetch: application.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => api.listening ? resolve() : api.once("listening", resolve));
  const apiAddress = api.address();
  assert.ok(apiAddress && typeof apiAddress !== "string");
  const base = `http://127.0.0.1:${apiAddress.port}/api/v1/pi-agent`;
  const headers = { authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" };
  const worker = new PiAgentGatewayWorker(db, createPartnersGatewayClient(config), config, {
    actor, assignedAgentId: "gateway-e2e-agent", workerId: "gateway-e2e-worker",
    leaseDurationMinutes: 1, heartbeatIntervalMs: 20, progressFlushIntervalMs: 1,
    idlePollIntervalMs: 20, statusPollIntervalMs: 20, retryBaseDelayMs: 30, retryMaxDelayMs: 30,
  });
  async function createRun(maxRetries = 0) {
    const [task] = await db.insert(tasks).values({ projectId: project!.id, requirementId: requirement!.id,
      title: "Gateway E2E task", createdBy: actor.id, assignee: "gateway-e2e-agent", assigneeType: "agent" }).returning();
    const result = await fetch(`${base}/runs`, { method: "POST", headers, body: JSON.stringify({ taskId: task!.id,
      assignedAgentId: "gateway-e2e-agent", requestedPiProvider: "fixture", requestedPiModel: "fixture", maxRetries }) });
    assert.equal(result.status, 201, await result.clone().text());
    return await result.json() as { id: string };
  }
  async function waitFor(id: string, predicate: (run: Awaited<ReturnType<typeof piAgentService.getRun>>) => boolean) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const run = await piAgentService.getRun(db, id);
      if (predicate(run)) return run;
      await delay(10);
    }
    throw new Error("Timed out waiting for persisted run state");
  }
  try {
    const policy = await fetch(`${base}/policy`, { method: "PUT", headers, body: JSON.stringify({ enabled: true, executionMode: "live" }) });
    assert.equal(policy.status, 200);
    await t.test("authenticated module controls and Gateway authentication", async () => {
      assert.equal((await fetch(`${base}/worker/status`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/worker/health`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/worker/status`, { headers: { authorization: "Bearer invalid" } })).status, 401);
      await assert.rejects(createPartnersGatewayClient({ ...config, serviceToken: "invalid" }).health());
    });
    for (const state of ["succeeded", "failed", "cancelled", "timed_out", "polling"]) {
      await t.test(`persists ${state} execution and releases its lease`, async () => {
        scenario = state;
        const run = await createRun();
        const execution = worker.runOnce(new AbortController().signal);
        const running = await waitFor(run.id, (row) => row.status === "running");
        const progress = await waitFor(run.id, (row) => Boolean(row.eventLog?.length));
        assert.ok(progress.leaseExpiresAt! > running.leaseExpiresAt!);
        assert.equal(progress.leaseOwnerId, "gateway-e2e-worker");
        await execution;
        const done = await piAgentService.getRun(db, run.id);
        assert.equal(done.status, state === "polling" ? "succeeded" : state === "timed_out" ? "failed" : state);
        assert.equal(done.leaseOwnerId, null);
        assert.equal(done.leaseExpiresAt, null);
        assert.ok(done.completedAt);
        assert.equal(done.actualPiProvider, "partners-gateway");
        assert.equal(done.piSessionId, `tw_pi_${run.id}`);
        assert.ok(done.outputSummary?.includes("Gateway E2E progress"));
        assert.deepEqual(done.costMetadata?.gatewayArtifacts, [{ id: "result", path: "/workspace/result.json" }]);
        const history = await db.select().from(activityLog).where(eq(activityLog.entityId, run.id));
        assert.ok(history.some((item) => item.action === "acquired"));
        assert.ok(history.some((item) => item.action === "completed"));
        assert.equal((await fetch(`${base}/runs/${run.id}`, { headers })).status, 200);
      });
    }
    await t.test("transient retry persists backoff and exhaustion", async () => {
      scenario = "succeeded";
      transientFailures = 1;
      const run = await createRun(1);
      await worker.runOnce(new AbortController().signal);
      const retry = await piAgentService.getRun(db, run.id);
      assert.equal(retry.status, "queued");
      assert.equal(retry.retryCount, 1);
      assert.equal(retry.leaseOwnerId, null);
      assert.ok(retry.nextAttemptAt);
      await delay(40);
      await worker.runOnce(new AbortController().signal);
      assert.equal((await piAgentService.getRun(db, run.id)).status, "succeeded");
      transientFailures = 2;
      const exhausted = await createRun(1);
      await worker.runOnce(new AbortController().signal);
      await delay(40);
      await assert.rejects(worker.runOnce(new AbortController().signal));
      const failed = await piAgentService.getRun(db, exhausted.id);
      assert.equal(failed.status, "failed");
      assert.equal(failed.retryCount, 1);
      assert.equal(failed.leaseOwnerId, null);
    });
    await t.test("concurrent workers acquire once and recover an expired lease", async () => {
      const run = await createRun();
      const results = await Promise.allSettled(["worker-a", "worker-b"].map((workerId) => piAgentService.acquireRun(db,
        { assignedAgentId: "gateway-e2e-agent", workerId, durationMinutes: 1 }, actor)));
      assert.equal(results.filter((result) => result.status === "fulfilled" && result.value?.id === run.id).length, 1);
      await db.update(piAgentRuns).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(piAgentRuns.id, run.id));
      const before = submissions;
      await worker.runOnce(new AbortController().signal);
      assert.equal(submissions, before + 1);
      assert.equal((await piAgentService.getRun(db, run.id)).status, "succeeded");
    });
    await t.test("application starts the module worker and shuts down cleanly", async () => {
      await application.start();
      const run = await createRun();
      await waitFor(run.id, (row) => row.status === "succeeded");
      await application.stop();
      const response = await fetch(`${base}/worker/status`, { headers });
      const status = await response.json();
      assert.equal(status.running, false);
      assert.equal(status.workerId, null);
      assert.ok(requests.some((request) => request.endsWith("/events")));
    });
  } finally {
    await application.stop();
    if ("closeAllConnections" in api) api.closeAllConnections();
    gateway.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => api.close(() => resolve())), new Promise<void>((resolve) => gateway.close(() => resolve()))]);
    await db.$client.end();
  }
});
