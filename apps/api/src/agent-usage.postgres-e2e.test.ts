import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createDb,
  runMigrations,
  projects,
  requirements,
  tasks,
  daemons,
  requirementClaims,
  tiAgentRuns,
  agentUsageRuns,
} from "@task-weaver/db";
import { apiKeyService } from "@task-weaver/core";
import { createApiApplication } from "./application.js";
const databaseUrl = process.env.TW_USAGE_E2E_DATABASE_URL;
test(
  "whole-process usage persists with authenticated, scoped and idempotent reporting",
  { skip: !databaseUrl, timeout: 60_000 },
  async (t) => {
    const url = new URL(databaseUrl!);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(
      url.pathname,
      "/tw_usage_e2e",
      "Use only the disposable usage database",
    );
    await runMigrations(databaseUrl!);
    // Applying migrations again must preserve the table and its data contract.
    await runMigrations(databaseUrl!);
    const db = createDb(databaseUrl!);
    t.after(() => db.$client.end());
    const key = await apiKeyService.createApiKey(db, { name: "usage-fixture" });
    const otherKey = await apiKeyService.createApiKey(db, {
      name: "other-reporter",
    });
    const actorId = `apikey:${key.id}`;
    const [project] = await db
      .insert(projects)
      .values({ name: "Usage fixture", createdBy: actorId })
      .returning();
    const [otherProject] = await db
      .insert(projects)
      .values({ name: "Other project", createdBy: actorId })
      .returning();
    const [requirement] = await db
      .insert(requirements)
      .values({ projectId: project!.id, title: "Usage", createdBy: actorId })
      .returning();
    const [task] = await db
      .insert(tasks)
      .values({
        projectId: project!.id,
        requirementId: requirement!.id,
        title: "Usage task",
        createdBy: actorId,
      })
      .returning();
    const [daemon] = await db
      .insert(daemons)
      .values({ name: "Usage daemon", actorId, actorType: "agent" })
      .returning();
    await db
      .insert(requirementClaims)
      .values({
        requirementId: requirement!.id,
        daemonId: daemon!.id,
        claimedBy: actorId,
        claimedByType: "agent",
        expiresAt: new Date(Date.now() + 60_000),
      });
    const app = createApiApplication({
      db,
      databaseUrl: databaseUrl!,
      env: { TW_PRESET_SKILLS_SYNC: "disabled" },
    }).app;
    const headers = {
      authorization: `Bearer ${key.rawKey}`,
      "content-type": "application/json",
    };
    const request = (
      path: string,
      body?: unknown,
      customHeaders: Record<string, string> = headers,
    ) =>
      app.request(`/api/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: customHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const startedAt = "2026-10-02T01:00:00.000Z";
    const endedAt = "2026-10-02T01:00:01.000Z";
    const unknown = {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cacheSemantics: "unknown",
      provider: "unknown",
      model: "unknown",
      completeness: "unknown",
    };
    const partial = {
      ...unknown,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 80,
      cacheSemantics: "included",
      completeness: "partial",
    };
    const body = {
      processId: randomUUID(),
      projectId: project!.id,
      requirementId: requirement!.id,
      daemonId: daemon!.id,
      agent: "codex",
      phase: "execution",
      startedAt,
      endedAt: null,
      outcome: "running",
      revision: 0,
      summary: unknown,
    };
    assert.equal(
      (
        await request("agent-usage/runs", body, {
          "x-actor-id": actorId,
          "content-type": "application/json",
        })
      ).status,
      401,
    );
    assert.equal(
      (await request("agent-usage/runs", { ...body, prompt: "Do not store" }))
        .status,
      400,
    );
    assert.equal(
      (
        await request("agent-usage/runs", {
          ...body,
          projectId: otherProject!.id,
        })
      ).status,
      400,
    );
    assert.equal((await request("agent-usage/runs", body)).status, 200);
    const snapshot = { ...body, revision: 1, summary: partial };
    const concurrent = await Promise.all([
      request("agent-usage/runs", snapshot),
      request("agent-usage/runs", snapshot),
    ]);
    assert.deepEqual(
      concurrent.map((r) => r.status),
      [200, 200],
    );
    assert.equal(
      (
        await request("agent-usage/runs", {
          ...snapshot,
          summary: { ...partial, inputTokens: 200 },
        })
      ).status,
      400,
    );
    assert.equal((await request("agent-usage/runs", body)).status, 200);
    const complete = {
      ...snapshot,
      revision: 2,
      outcome: "succeeded",
      endedAt,
      summary: {
        ...partial,
        inputTokens: 200,
        outputTokens: 20,
        completeness: "complete",
      },
    };
    assert.equal((await request("agent-usage/runs", complete)).status, 200);
    assert.equal((await request("agent-usage/runs", complete)).status, 200);
    assert.equal(
      (
        await request("agent-usage/runs", complete, {
          ...headers,
          authorization: `Bearer ${otherKey.rawKey}`,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("agent-usage/runs", {
          ...complete,
          revision: 3,
          outcome: "running",
          endedAt: null,
        })
      ).status,
      400,
    );
    const cancelled = {
      ...body,
      processId: randomUUID(),
      phase: "review",
      revision: 1,
      outcome: "cancelled",
      endedAt,
      summary: { ...partial, completeness: "complete" },
    };
    assert.equal((await request("agent-usage/runs", cancelled)).status, 200);
    const noUsage = {
      ...body,
      processId: randomUUID(),
      agent: "claude",
      outcome: "failed",
      endedAt,
    };
    assert.equal((await request("agent-usage/runs", noUsage)).status, 200);
    const query = `projectId=${project!.id}`;
    const total: any = await (
      await request(`agent-usage/summary?${query}`)
    ).json();
    assert.deepEqual(
      [total.runs, total.complete, total.partial, total.unknown],
      [3, 1, 1, 1],
    );
    assert.deepEqual(
      [total.inputTokens, total.outputTokens, total.cacheReadTokens],
      ["300", "30", "160"],
    );
    assert.equal(total.cacheWriteTokens, null);
    assert.equal(total.inputReportedRuns, 2);
    assert.equal(total.coverage, 1 / 3);
    const taskTotal: any = await (
      await request(`agent-usage/summary?${query}&taskId=${task!.id}`)
    ).json();
    assert.equal(
      taskTotal.runs,
      0,
      "Shared requirement usage must not be repeated for each task",
    );
    const outside: any = await (
      await request(`agent-usage/runs?projectId=${otherProject!.id}`)
    ).json();
    assert.equal(outside.total, 0);
    assert.equal(
      (
        await request(
          `agent-usage/runs/${body.processId}?projectId=${otherProject!.id}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          `agent-usage/summary?projectId=${otherProject!.id}&taskId=${task!.id}`,
        )
      ).status,
      400,
    );
    const filtered: any = await (
      await request(
        `agent-usage/runs?${query}&since=${startedAt}&until=2026-10-02T01:00:00.001Z&limit=1&offset=1`,
      )
    ).json();
    assert.equal(filtered.total, 3);
    assert.equal(filtered.items.length, 1);
    const excluded: any = await (
      await request(`agent-usage/summary?${query}&until=${startedAt}`)
    ).json();
    assert.equal(excluded.runs, 0);

    const [piRun] = await db
      .insert(tiAgentRuns)
      .values({
        taskId: task!.id,
        assignedAgentId: actorId,
        status: "running",
        leaseOwnerId: "fixture-worker",
        leaseOwnerType: "agent",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(startedAt),
        createdBy: actorId,
      })
      .returning();
    const pi = {
      processId: randomUUID(),
      workerId: "fixture-worker",
      attempt: 0,
      startedAt,
      endedAt: null,
      outcome: "running",
      revision: 0,
      summary: unknown,
    };
    const beforePiReport: any = await (
      await request(`agent-usage/summary?${query}`)
    ).json();
    assert.equal(beforePiReport.knownUnregisteredTiAttempts, 1);
    assert.equal(
      beforePiReport.coverage,
      1 / 4,
      "Unreported Ti work cannot imply complete coverage",
    );
    const path = `ti/runs/${piRun!.id}/usage`;
    assert.equal(
      (
        await request(path, pi, {
          "x-actor-id": actorId,
          "content-type": "application/json",
        })
      ).status,
      401,
    );
    assert.equal(
      (await request(path, { ...pi, workerId: "wrong-worker" })).status,
      400,
    );
    assert.equal(
      (
        await request(path, pi, {
          ...headers,
          authorization: `Bearer ${otherKey.rawKey}`,
        })
      ).status,
      400,
    );
    assert.equal((await request(path, pi)).status, 200);
    const piPartial = {
      ...pi,
      revision: 1,
      summary: { ...partial, model: "multiple" },
    };
    assert.equal((await request(path, piPartial)).status, 200);
    assert.equal(
      (
        await request(`${path}/${pi.processId}/finish`, {
          outcome: "failed",
          endedAt,
        })
      ).status,
      200,
    );
    const [saved] = await db
      .select()
      .from(agentUsageRuns)
      .where(eq(agentUsageRuns.processId, pi.processId));
    assert.equal(saved?.summary.inputTokens, 100);
    assert.equal(saved?.summary.model, "multiple");
    assert.equal(saved?.summary.completeness, "partial");
    await db
      .update(tiAgentRuns)
      .set({ retryCount: 1 })
      .where(eq(tiAgentRuns.id, piRun!.id));
    const retry = { ...pi, processId: randomUUID(), attempt: 1 };
    assert.equal((await request(path, retry)).status, 200);
    const registeredPi: any = await (
      await request(`agent-usage/summary?${query}`)
    ).json();
    assert.equal(registeredPi.knownUnregisteredTiAttempts, 0);
    assert.equal(
      (await request(path, { ...pi, processId: randomUUID() })).status,
      400,
      "Old attempts cannot register new processes",
    );
    assert.equal(
      (
        await request(path, {
          ...retry,
          revision: 1,
          outcome: "cancelled",
          endedAt,
        })
      ).status,
      200,
    );
    const piTotals: any = await (
      await request(`agent-usage/summary?${query}&taskId=${task!.id}`)
    ).json();
    assert.deepEqual(
      [piTotals.runs, piTotals.partial, piTotals.unknown, piTotals.inputTokens],
      [2, 1, 1, "100"],
    );
    assert.equal(
      (
        await request(path, {
          ...retry,
          revision: 2,
          summary: { ...partial, inputTokens: 200 },
          outcome: "cancelled",
          endedAt,
        })
      ).status,
      200,
      "Late reported usage can enrich a registered terminal attempt",
    );
    assert.equal(
      (
        await request("agent-usage/runs", {
          ...body,
          processId: randomUUID(),
          agent: "claude",
          summary: partial,
        })
      ).status,
      400,
    );
  },
);
