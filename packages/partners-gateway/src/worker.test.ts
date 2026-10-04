import assert from "node:assert/strict";
import test from "node:test";

import { TiAgentGatewayWorker } from "./worker";

const actor = { id: "worker-actor", type: "agent" as const };
const options = {
  actor,
  assignedAgentId: "ti-agent",
  workerId: "api-worker",
  leaseDurationMinutes: 15,
  heartbeatIntervalMs: 10,
  progressFlushIntervalMs: 10,
  idlePollIntervalMs: 10,
  statusPollIntervalMs: 10,
  retryBaseDelayMs: 100,
  retryMaxDelayMs: 1_000,
};
const gatewayConfig = {
  enabled: true,
  baseUrl: "http://gateway.local",
  serviceToken: "token",
  defaultTimeoutSeconds: 900,
};

test("acquires, submits, heartbeats, completes, and cleans up sandbox session", async () => {
  const calls: string[] = [];
  let completionMetadata: Record<string, unknown> | null | undefined;
  let now = 0;
  const worker = new TiAgentGatewayWorker(
    {} as never,
    {
      async createJob() {
        calls.push("createJob");
        return { id: "job-1", state: "running" as const, executionMode: "ephemeral_interpreter" as const, sessionId: "session-1" };
      },
      async getJob() {
        calls.push("getJob");
        return { id: "job-1", state: "succeeded" as const, executionMode: "ephemeral_interpreter" as const, sessionId: "session-1" };
      },
      async listArtifacts() {
        return { items: [{ id: "artifact-1", path: "/workspace/result.json", content: "excluded" }] };
      },
      async deleteSession(sessionId: string) {
        calls.push(`deleteSession:${sessionId}`);
      },
      async health() { return { status: "ok" }; },
      async *streamEvents() {
        calls.push("streamEvents");
        await new Promise((resolve) => setTimeout(resolve, 15));
        yield { type: "log.stdout", sequence: 1, state: "running" as const, chunk: "working" };
        yield { type: "job.state", sequence: 2, state: "succeeded" as const };
      },
    } as never,
    gatewayConfig,
    options,
    {
      async acquireRun() {
        calls.push("acquire");
        return { id: "run-1" } as never;
      },
      async getRun() {
        calls.push("getRun");
        return {
          id: "run-1",
          taskId: "task-1",
          scheduleRunId: null,
          actualModelProvider: "openai",
          actualModelId: "gpt-5.5",
          task: { id: "task-1", title: "Do work", description: null, priority: "high" },
        } as never;
      },
      async heartbeatRunLease() {
        calls.push("heartbeat");
        return {} as never;
      },
      async updateRunProgress(_db, _id, progress) {
        calls.push(`progress:${progress.eventLog.length}`);
        return {} as never;
      },
      async scheduleRunRetry() { return null; },
      async completeRun(_db, _id, completion) {
        calls.push(`complete:${completion.status}`);
        completionMetadata = completion.costMetadata;
        return {} as never;
      },
      async wait() {
        now += 10;
        return true;
      },
      now: () => now,
      log: { info() {}, error() {} },
    },
  );

  assert.equal(await worker.runOnce(new AbortController().signal), true);
  assert.deepEqual(calls.slice(0, 4), ["acquire", "getRun", "createJob", "streamEvents"]);
  assert.ok(calls.includes("heartbeat"));
  assert.ok(calls.includes("progress:2"));
  assert.ok(calls.includes("complete:succeeded"));
  assert.equal(calls.at(-1), "deleteSession:session-1");
  assert.deepEqual(completionMetadata?.gatewayArtifacts, [{
    id: "artifact-1",
    path: "/workspace/result.json",
  }]);
});

test("shutdown interruption leaves the active run leased for recovery", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const worker = new TiAgentGatewayWorker(
    {} as never,
    {
      async createJob() {
        return { id: "job-1", state: "running" as const, executionMode: "ephemeral_interpreter" as const };
      },
      async getJob() {
        calls.push("getJob");
        return { id: "job-1", state: "running" as const, executionMode: "ephemeral_interpreter" as const };
      },
      async listArtifacts() { return { items: [] }; },
      async deleteSession() {},
      async health() { return { status: "ok" }; },
      async *streamEvents() {
        controller.abort();
      },
    } as never,
    gatewayConfig,
    options,
    {
      async acquireRun() { return { id: "run-1" } as never; },
      async getRun() { return { id: "run-1", task: null } as never; },
      async heartbeatRunLease() { calls.push("heartbeat"); return {} as never; },
      async updateRunProgress() { calls.push("progress"); return {} as never; },
      async scheduleRunRetry() { calls.push("retry"); return null; },
      async completeRun() { calls.push("complete"); return {} as never; },
      async wait() {
        controller.abort();
        return false;
      },
      now: () => 0,
      log: { info() {}, error() {} },
    },
  );

  assert.equal(await worker.runOnce(controller.signal), true);
  assert.deepEqual(calls, []);
});

test("shutdown after acquisition does not submit new gateway work", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const worker = new TiAgentGatewayWorker(
    {} as never,
    {
      async createJob() {
        calls.push("createJob");
        return { id: "job-1", state: "running" as const, executionMode: "ephemeral_interpreter" as const };
      },
      async getJob() {
        return { id: "job-1", state: "running" as const, executionMode: "ephemeral_interpreter" as const };
      },
      async listArtifacts() { return { items: [] }; },
      async deleteSession() {},
      async health() { return { status: "ok" }; },
      async *streamEvents() { calls.push("streamEvents"); },
    } as never,
    gatewayConfig,
    options,
    {
      async acquireRun() {
        controller.abort();
        return { id: "run-1" } as never;
      },
      async getRun() { calls.push("getRun"); return {} as never; },
      async heartbeatRunLease() { return {} as never; },
      async updateRunProgress() { calls.push("progress"); return {} as never; },
      async scheduleRunRetry() { calls.push("retry"); return null; },
      async completeRun() { calls.push("complete"); return {} as never; },
      async wait() { return false; },
      now: () => 0,
      log: { info() {}, error() {} },
    },
  );

  assert.equal(await worker.runOnce(controller.signal), true);
  assert.deepEqual(calls, []);
});

test("transient gateway failures schedule durable retry without terminal completion", async () => {
  const calls: string[] = [];
  const worker = new TiAgentGatewayWorker(
    {} as never,
    {
      async createJob() { throw new TypeError("network unavailable"); },
      async getJob() { throw new Error("not reached"); },
      async listArtifacts() { throw new Error("not reached"); },
      async deleteSession() {},
      async health() { return { status: "ok" }; },
      async *streamEvents() {},
    } as never,
    gatewayConfig,
    options,
    {
      async acquireRun() { return { id: "run-1", retryCount: 0, maxRetries: 2 } as never; },
      async getRun() { return { id: "run-1", retryCount: 0, maxRetries: 2, task: null } as never; },
      async heartbeatRunLease() { return {} as never; },
      async updateRunProgress() { return {} as never; },
      async scheduleRunRetry(_db, _id, retry) {
        calls.push(`retry:${retry.delayMs}`);
        return { retryCount: 1, maxRetries: 2, nextAttemptAt: new Date("2026-09-27T09:00:00Z") } as never;
      },
      async completeRun() { calls.push("complete"); return {} as never; },
      async wait() { return true; },
      now: () => 0,
      log: { info() {}, error() {} },
    },
  );

  assert.equal(await worker.runOnce(new AbortController().signal), true);
  assert.deepEqual(calls, ["retry:100"]);
});
