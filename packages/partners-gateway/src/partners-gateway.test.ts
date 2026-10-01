import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGatewayJobRequestFromPiRun,
  buildPiCompletionFromGateway,
  createPartnersGatewayClient,
  getPartnersGatewayConfig,
  getPartnersGatewayWorkerConfig,
  isTransientGatewayError,
  normalizeGatewayArtifactReferences,
  parseGatewaySseEvent,
  PartnersGatewayError,
} from "./index";

test("reads Partners gateway config from environment", () => {
  const config = getPartnersGatewayConfig({
    PARTNERS_GATEWAY_URL: "http://127.0.0.1:4010",
    PARTNERS_GATEWAY_SERVICE_TOKEN: "token",
    PARTNERS_GATEWAY_TENANT_ID: "tenant_1",
    PARTNERS_GATEWAY_PROJECT_ID: "project_1",
    PARTNERS_GATEWAY_DEFAULT_TIMEOUT_SECONDS: "1200",
  });

  assert.equal(config.enabled, true);
  assert.equal(config.baseUrl, "http://127.0.0.1:4010");
  assert.equal(config.defaultTimeoutSeconds, 1200);
});

test("rejects partial gateway credentials and invalid worker timing", () => {
  assert.throws(() => getPartnersGatewayConfig({
    PARTNERS_GATEWAY_URL: "http://gateway.local",
  }), /must be configured together/);
  assert.throws(() => getPartnersGatewayWorkerConfig({
    PARTNERS_GATEWAY_WORKER_LEASE_MINUTES: "1",
    PARTNERS_GATEWAY_WORKER_HEARTBEAT_INTERVAL_MS: "60000",
  }), /shorter than the lease duration/);
  assert.throws(() => getPartnersGatewayWorkerConfig({
    PARTNERS_GATEWAY_WORKER_RETRY_BASE_MS: "2000",
    PARTNERS_GATEWAY_WORKER_RETRY_MAX_MS: "1000",
  }), /cannot exceed the maximum delay/);
});

test("reads validated gateway worker configuration", () => {
  const config = getPartnersGatewayWorkerConfig({
    PARTNERS_GATEWAY_WORKER_ACTOR_ID: "api-key-actor",
    PARTNERS_GATEWAY_WORKER_ASSIGNED_AGENT_ID: "ti-agent",
    PARTNERS_GATEWAY_WORKER_LEASE_MINUTES: "10",
    PARTNERS_GATEWAY_WORKER_HEARTBEAT_INTERVAL_MS: "1000",
  });
  assert.equal(config.actorId, "api-key-actor");
  assert.equal(config.assignedAgentId, "ti-agent");
  assert.equal(config.leaseDurationMinutes, 10);
  assert.equal(config.heartbeatIntervalMs, 1000);
});

test("creates gateway jobs with service-token headers", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createPartnersGatewayClient({
    enabled: true,
    baseUrl: "http://gateway.local/",
    serviceToken: "secret-token",
    defaultTimeoutSeconds: 900,
  }, async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      id: "job_1",
      state: "queued",
      executionMode: "ephemeral_interpreter",
    }), { status: 202, headers: { "content-type": "application/json" } });
  });

  const job = await client.createJob({
    id: "tw_pi_stable_run",
    executionMode: "ephemeral_interpreter",
    command: { argv: ["echo", "ok"] },
    timeoutSeconds: 30,
  });

  assert.equal(job.id, "job_1");
  assert.equal(calls[0]?.url, "http://gateway.local/v1/jobs");
  assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, "Bearer secret-token");
  assert.equal((calls[0]?.init?.headers as Record<string, string>)["idempotency-key"], "tw_pi_stable_run");
});

test("maps Ti agent runs to gateway job requests", () => {
  const request = buildGatewayJobRequestFromPiRun({
    run: {
      id: "11111111-1111-1111-1111-111111111111",
      taskId: "22222222-2222-2222-2222-222222222222",
      scheduleRunId: null,
      actualPiProvider: "openai",
      actualPiModel: "gpt-5.5",
    },
    prompt: "Do the assigned work",
    config: {
      enabled: true,
      baseUrl: "http://gateway.local",
      serviceToken: "token",
      tenantId: "tenant_1",
      projectId: "project_1",
      defaultTimeoutSeconds: 600,
    },
  });

  assert.equal(request.id, "tw_pi_11111111-1111-1111-1111-111111111111");
  assert.equal(request.tenantId, "tenant_1");
  assert.equal(request.projectId, "project_1");
  assert.equal(request.inputs?.files[0]?.content, "Do the assigned work");
  assert.equal((request.metadata?.taskWeaver as Record<string, unknown>).taskId, "22222222-2222-2222-2222-222222222222");
});

test("keeps job requests stable when persisted execution metadata changes", () => {
  const run = { id: "stable-run", requestedPiProvider: "openai", requestedPiModel: "gpt-5.5",
    actualPiProvider: "openai", actualPiModel: "gpt-5.5" };
  const config = { enabled: true, defaultTimeoutSeconds: 30 };
  const initial = buildGatewayJobRequestFromPiRun({ run, prompt: "Stable task", config });
  const recovered = buildGatewayJobRequestFromPiRun({
    run: { ...run, actualPiProvider: "partners-gateway", actualPiModel: "kubernetes" },
    prompt: "Stable task", config,
  });
  assert.deepEqual(recovered, initial);
  const unspecified = { ...run, requestedPiProvider: null, requestedPiModel: null };
  assert.deepEqual(
    buildGatewayJobRequestFromPiRun({ run: unspecified, prompt: "Stable task", config }),
    buildGatewayJobRequestFromPiRun({ run: { ...unspecified, actualPiProvider: "partners-gateway", actualPiModel: "kubernetes" },
      prompt: "Stable task", config }),
  );
});

test("maps gateway terminal jobs to Ti completion payloads", () => {
  const completion = buildPiCompletionFromGateway({
    job: {
      id: "job_1",
      state: "succeeded",
      executionMode: "ephemeral_interpreter",
      provider: "local",
      exitCode: 0,
      artifactCount: 1,
    },
    events: [
      { type: "job.state", sequence: 1, state: "running" },
      { type: "log.stdout", sequence: 2, chunk: "review ready" },
    ],
  });

  assert.equal(completion.status, "succeeded");
  assert.equal(completion.actualPiProvider, "partners-gateway");
  assert.equal(completion.actualPiModel, "local");
  assert.equal(completion.outputSummary, "review ready");
  assert.equal(completion.costMetadata?.gatewayJobId, "job_1");
});

test("parses gateway SSE fields and multiline JSON data", () => {
  const event = parseGatewaySseEvent([
    "id: evt_2",
    "event: log.stdout",
    "data: {\"sequence\":2,",
    "data: \"chunk\":\"ready\"}",
  ].join("\n"));

  assert.deepEqual(event, {
    id: "evt_2",
    type: "log.stdout",
    sequence: 2,
    chunk: "ready",
  });
});

test("streams gateway events across response chunks", async () => {
  const encoder = new TextEncoder();
  const client = createPartnersGatewayClient({
    enabled: true,
    baseUrl: "http://gateway.local",
    serviceToken: "token",
    defaultTimeoutSeconds: 900,
  }, async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("event: job.state\ndata: {\"sequence\":1,"));
      controller.enqueue(encoder.encode("\"state\":\"running\"}\n\n"));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } }));

  const events = [];
  for await (const event of client.streamEvents("job_1")) events.push(event);
  assert.deepEqual(events, [{ type: "job.state", sequence: 1, state: "running", id: undefined }]);
});

test("bounds gateway artifact metadata to reference fields", () => {
  assert.deepEqual(normalizeGatewayArtifactReferences([
    { id: "artifact-1", path: "/workspace/report.json", size: 42, content: "excluded" },
    "ignored",
  ]), [{ id: "artifact-1", path: "/workspace/report.json", size: 42 }]);
});

test("classifies only retryable gateway and network failures as transient", () => {
  assert.equal(isTransientGatewayError(new PartnersGatewayError("busy", 503)), true);
  assert.equal(isTransientGatewayError(new PartnersGatewayError("invalid", 400)), false);
  assert.equal(isTransientGatewayError(new TypeError("network")), true);
  assert.equal(isTransientGatewayError(new Error("parse")), false);
});
