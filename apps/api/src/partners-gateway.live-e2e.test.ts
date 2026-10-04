import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { createDb, runMigrations, projects, requirements, tasks, tiAgentRuns } from "@task-weaver/db";
import { apiKeyService, tiAgentService } from "@task-weaver/core";
import { createPartnersGatewayClient, type PartnersGatewayJob, type PartnersGatewayJobRequest, type PartnersGatewayEvent } from "@task-weaver/partners-gateway";
import { TiAgentGatewayWorker } from "@task-weaver/partners-gateway/worker";
import { createApiApplication } from "./application.js";

const databaseUrl = process.env.TW_GATEWAY_E2E_DATABASE_URL;
const gatewayUrl = process.env.TW_GATEWAY_LIVE_URL;
const token = process.env.TW_GATEWAY_LIVE_TOKEN;

test("live Partners Gateway executes Kubernetes jobs with real Core persistence", {
  skip: !(databaseUrl && gatewayUrl && token), timeout: 180_000,
}, async (t) => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/tw_gateway_e2e");
  const prefix = `tw_live_${randomUUID().replaceAll("-", "")}`;
  const config = { enabled: true, baseUrl: gatewayUrl!, serviceToken: token!,
    tenantId: process.env.TW_GATEWAY_LIVE_TENANT ?? "task-weaver", projectId: prefix, defaultTimeoutSeconds: 30 };
  const client = createPartnersGatewayClient(config);
  const activeJobs = new Set<string>();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
  async function waitJob(id: string, desired?: string): Promise<PartnersGatewayJob> {
    for (let attempt = 0; attempt < 240; attempt++) {
      const job = await client.getJob(id);
      if (desired ? job.state === desired : terminal.has(job.state)) return job;
      assert.ok(!desired || !terminal.has(job.state), `Job ended before ${desired}: ${job.state}`);
      await delay(250);
    }
    throw new Error(`Live verification job timed out: ${id}`);
  }
  function request(name: string, command: string, timeoutSeconds = 30): PartnersGatewayJobRequest {
    return { id: `${prefix}_${name}`, tenantId: config.tenantId, projectId: prefix,
      executionMode: "ephemeral_interpreter", command: { argv: ["bash", "-lc", command], cwd: "/workspace" },
      timeoutSeconds, metadata: { purpose: "Task Weaver live verification" } };
  }
  async function submit(body: PartnersGatewayJobRequest) {
    activeJobs.add(body.id!);
    const job = await client.createJob(body);
    assert.equal(job.id, body.id);
    return job;
  }
  try {
    await t.test("readiness and authentication reject missing, invalid and out-of-scope tokens", async () => {
      assert.equal((await fetch(`${gatewayUrl}/ready`)).status, 200);
      for (const auth of [undefined, "Bearer invalid-live-verification"]) {
        const response = await fetch(`${gatewayUrl}/v1/jobs`, { method: "POST",
          headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
          body: JSON.stringify(request("unauthorized", "true")) });
        assert.equal(response.status, 401);
      }
      const response = await fetch(`${gatewayUrl}/v1/jobs`, { method: "POST", headers,
        body: JSON.stringify({ ...request("forbidden", "true"), tenantId: `outside_${prefix}` }) });
      assert.equal(response.status, 403);
    });
    await t.test("remote execution, SSE replay, S3 artifacts and idempotent retries", async () => {
      const content = '{"verified":true}\n';
      const body = { ...request("success", 'echo TW_LIVE_STDOUT; echo TW_LIVE_STDERR >&2; cat /workspace/input.json > /workspace/result.json; sleep 2'),
        inputs: { files: [{ path: "/workspace/input.json", content }] },
        artifactPolicy: { collect: ["workspace:/workspace/result.json"] } };
      const accepted = await submit(body);
      await client.createJob(body);
      const conflict = await fetch(`${gatewayUrl}/v1/jobs`, { method: "POST",
        headers: { ...headers, "idempotency-key": body.id! }, body: JSON.stringify({ ...body, timeoutSeconds: 31 }) });
      assert.equal(conflict.status, 409);
      const events: PartnersGatewayEvent[] = [];
      for await (const event of client.streamEvents(accepted.id, { signal: AbortSignal.timeout(60_000) })) {
        events.push(event);
        if (event.state && terminal.has(event.state)) break;
      }
      assert.ok(events.some((event) => event.chunk?.includes("TW_LIVE_STDOUT")));
      assert.ok(events.some((event) => event.chunk?.includes("TW_LIVE_STDERR")));
      const done = await waitJob(accepted.id);
      assert.equal(done.state, "succeeded");
      assert.equal(done.exitCode, 0);
      assert.equal(done.provider, "kubernetes");
      const artifacts = (await client.listArtifacts(done.id)).items as Array<{ id: string; name: string; sha256: string }>;
      const artifact = artifacts.find((item) => item.name === "result.json");
      assert.ok(artifact);
      const response = await fetch(`${gatewayUrl}/v1/artifacts/${artifact.id}/download`, { headers });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.toString(), content);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
      assert.equal((await fetch(`${gatewayUrl}/v1/artifacts/${artifact.id}/download`)).status, 401);
      const before = await client.getJob(done.id);
      await client.createJob(body);
      await delay(2_000);
      assert.deepEqual(await client.getJob(done.id), before, "A retry must not reset or reexecute a completed job");
      assert.deepEqual((await client.listArtifacts(done.id)).items, artifacts);
      const replay = [];
      const lastEventId = String(events[0]!.sequence);
      for await (const event of client.streamEvents(done.id, { lastEventId, signal: AbortSignal.timeout(10_000) })) {
        replay.push(event);
        if (event.state && terminal.has(event.state)) break;
      }
      assert.ok(replay.length > 0);
      assert.ok(replay.every((event) => event.sequence > events[0]!.sequence));
      console.log(`Verified remote job ${done.id}: ${events.length} events, ${artifacts.length} artifacts`);
    });
    for (const [name, command, timeoutSeconds, expected] of [
      ["failure", "echo TW_LIVE_FAILURE >&2; exit 17", 30, "failed"],
      ["timeout", "sleep 10", 1, "timed_out"],
      ["cancel", "echo TW_LIVE_CANCEL; sleep 60", 90, "cancelled"],
    ] as const) {
      await t.test(`${name} reaches its remote terminal state`, async () => {
        const job = await submit(request(name, command, timeoutSeconds));
        if (name === "cancel") {
          await waitJob(job.id, "running");
          const response = await fetch(`${gatewayUrl}/v1/jobs/${job.id}/cancel`, { method: "POST", headers,
            body: JSON.stringify({ reason: "Task Weaver live verification cleanup" }) });
          assert.equal(response.status, 202);
        }
        const done = await waitJob(job.id);
        assert.equal(done.state, expected);
        if (name === "failure") assert.equal(done.exitCode, 17);
      });
    }
    await t.test("real API and worker persist remote execution and recover an expired lease without reexecution", async () => {
      await runMigrations(databaseUrl!);
      const db = createDb(databaseUrl!);
      const key = await apiKeyService.createApiKey(db, { name: "live-gateway-e2e" });
      const actor = { id: `apikey:${key.id}`, type: "agent" as const };
      const [project] = await db.insert(projects).values({ name: prefix, createdBy: actor.id }).returning();
      const [requirement] = await db.insert(requirements).values({ projectId: project!.id, title: prefix, createdBy: actor.id }).returning();
      const [task] = await db.insert(tasks).values({ projectId: project!.id, requirementId: requirement!.id,
        title: "Live Kubernetes execution", createdBy: actor.id, assignee: prefix, assigneeType: "agent" }).returning();
      const application = createApiApplication({ db, databaseUrl: databaseUrl!,
        env: { TW_PRESET_SKILLS_SYNC: "disabled" } });
      const api = serve({ fetch: application.app.fetch, port: 0, hostname: "127.0.0.1" });
      await new Promise<void>((resolve) => api.listening ? resolve() : api.once("listening", resolve));
      const address = api.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}/api/v1/ti`;
      const apiHeaders = { authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" };
      try {
        assert.equal((await fetch(`${base}/policy`, { method: "PUT", headers: apiHeaders,
          body: JSON.stringify({ enabled: true, executionMode: "live" }) })).status, 200);
        const response = await fetch(`${base}/runs`, { method: "POST", headers: apiHeaders,
          body: JSON.stringify({ taskId: task!.id, assignedAgentId: prefix, requestedProvider: "verification", requestedModel: "verification", maxRetries: 1 }) });
        assert.equal(response.status, 201);
        const run = await response.json() as { id: string };
        const worker = new TiAgentGatewayWorker(db, client, config, { actor, assignedAgentId: prefix,
          workerId: prefix, leaseDurationMinutes: 1, heartbeatIntervalMs: 100, progressFlushIntervalMs: 100,
          idlePollIntervalMs: 100, statusPollIntervalMs: 100, retryBaseDelayMs: 100, retryMaxDelayMs: 100 });
        activeJobs.add(`tw_ti_${run.id}`);
        assert.equal(await worker.runOnce(new AbortController().signal), true);
        const done = await tiAgentService.getRun(db, run.id);
        assert.equal(done.status, "succeeded");
        assert.equal(done.leaseOwnerId, null);
        assert.ok(done.completedAt);
        assert.ok(done.outputSummary?.includes("Live Kubernetes execution"));
        assert.ok(done.eventLog!.length > 0);
        assert.ok(Number(done.costMetadata?.gatewayArtifactCount) > 0);
        assert.equal((await fetch(`${base}/runs/${run.id}`, { headers: apiHeaders })).status, 200);
        const before = await client.getJob(`tw_ti_${run.id}`);
        await db.update(tiAgentRuns).set({ status: "running", completedAt: null,
          leaseOwnerId: "expired-live-worker", leaseExpiresAt: new Date(Date.now() - 60_000) }).where(eq(tiAgentRuns.id, run.id));
        assert.equal(await worker.runOnce(new AbortController().signal), true);
        assert.equal((await tiAgentService.getRun(db, run.id)).status, "succeeded");
        await delay(2_000);
        assert.deepEqual(await client.getJob(`tw_ti_${run.id}`), before);
        console.log(`Verified persisted Core run ${run.id} and expired lease recovery`);
      } finally {
        await application.stop();
        if ("closeAllConnections" in api) api.closeAllConnections();
        await new Promise<void>((resolve) => api.close(() => resolve()));
        await db.$client.end();
      }
    });
  } finally {
    for (const id of activeJobs) {
      const job = await client.getJob(id).catch(() => null);
      if (job && !terminal.has(job.state)) await fetch(`${gatewayUrl}/v1/jobs/${id}/cancel`, {
        method: "POST", headers, body: JSON.stringify({ reason: "Live verification cleanup" }) });
    }
  }
});
