import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, agentUsageRuns, tiAgentModelConfigs, requirements, tasks, daemons, requirementClaims, tiAgentRuns } from "@task-weaver/db";
import { createAssistantService, createChatModelService, createResourceServices, sendAssistantMessageSchema } from "@task-weaver/core";
import { resourcePostgresFixture } from "./resource-postgres-fixture";
const databaseUrl = process.env.TW_USAGE_E2E_DATABASE_URL;

test("Chat invocations and legacy processes retain usage, snapshots and authenticated isolation", { skip: !databaseUrl, timeout: 90_000 }, async t => {
  const url = new URL(databaseUrl!); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_usage_e2e");
  await runMigrations(databaseUrl!); await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!); t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  let calls = 0, mode = "normal";
  const server = createServer(async (request, response) => {
    let data = ""; for await (const chunk of request) data += chunk;
    const payload = JSON.parse(data); calls++;
    if (mode === "failure") { response.writeHead(503); response.end(); return; }
    const firstTool = ["tool", "operation"].includes(mode) && !payload.messages.some((m: any) => m.role === "tool");
    const message = firstTool ? { content: null, tool_calls: [{ id: "call", type: "function", function: { name: mode === "operation" ? "create_document" : "list_projects", arguments: mode === "operation" ? JSON.stringify({ projectId: f.project.id, title: "Operation fixture", content: "Fixture document" }) : "{}" } }] } : { content: "Fixture answer" };
    const usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } };
    if (payload.stream) {
      response.setHeader("content-type", "text/event-stream");
      response.write(`data: ${JSON.stringify({ model: "actual-fixture", choices: [{ delta: { content: mode === "cancel" ? "Fixture answer".repeat(10) : "Fixture answer" }, finish_reason: "stop" }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      response.end(mode === "partial" ? "" : "data: [DONE]\n\n");
    } else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ model: "actual-fixture", usage, choices: [{ message }] })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const models = createChatModelService(f.owner.context);
  const config = await models.save(db, { provider: "openai", model: "configured-fixture", label: "Original label", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, isDefaultChat: true });
  const assistant = createAssistantService(f.owner.context);
  const send = (project = false, streaming = false, requestId = randomUUID()) => assistant.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({
    message: "Fixture question", requestId, context: project ? { contextKind: "project", projectId: f.project.id } : { contextKind: "global" },
  }), streaming ? async () => {} : undefined);
  const ownerUsage = createResourceServices(f.owner.context).agentUsageService;
  const personalQuery = { scope: "personal" as const, limit: 100, offset: 0 };
  const firstRequest = randomUUID(); await send(false, false, firstRequest); await send(false, false, firstRequest);
  assert.equal(calls, 1, "Request recovery must not repeat model calls");
  mode = "tool"; await send(); assert.equal(calls, 3, "Each tool-loop call has its own record");
  mode = "normal"; await send(true); await send(false, true);
  mode = "partial"; await assert.rejects(send(false, true));
  mode = "failure"; await assert.rejects(send()); await assert.rejects(send());
  const personal = await ownerUsage.listUsage(db, personalQuery);
  assert.equal(personal.total, 7); assert.equal(new Set(personal.items.map(r => r.processId)).size, 7);
  assert.equal(personal.items.filter(r => r.summary.completeness === "partial").length, 1);
  assert.equal(personal.items.filter(r => r.summary.completeness === "unknown").length, 2);
  const original = personal.items.find(r => r.summary.completeness === "complete")!;
  assert.equal(original.modelSnapshot?.configuredModel, "configured-fixture"); assert.equal(original.summary.model, "actual-fixture");
  assert.equal(original.summary.cacheWriteTokens, null);
  await db.update(tiAgentModelConfigs).set({ label: "Edited", model: "edited-model" }).where(eq(tiAgentModelConfigs.id, config.id));
  await db.delete(tiAgentModelConfigs).where(eq(tiAgentModelConfigs.id, config.id));
  const retained = await ownerUsage.getUsage(db, undefined, original.processId);
  assert.equal(retained.modelSnapshot?.displayName, "Original label");
  assert.equal((await createResourceServices(f.outsider.context).agentUsageService.listUsage(db, personalQuery)).total, 0);
  await assert.rejects(createResourceServices(f.outsider.context).agentUsageService.getUsage(db, undefined, original.processId));
  await assert.rejects(createResourceServices(f.outsider.context).agentUsageService.listUsage(db, { scope: "project", projectId: f.project.id, limit: 25, offset: 0 }));
  const response = await f.app.request("/api/v1/agent-usage/runs?scope=personal", { headers: f.owner.headers });
  assert.equal(response.status, 200); assert.equal((await response.json() as any).total, 7);
  assert.equal((await f.app.request("/api/v1/agent-usage/runs?scope=personal")).status, 401);
  const grouped = await ownerUsage.summarizeUsage(db, { ...personalQuery, groupBy: "model", model: "configured-fixture" });
  assert.equal(grouped.runs, 7); assert.equal(grouped.complete, 4); assert.equal(grouped.partial, 1); assert.equal(grouped.unknown, 2);
  assert.equal(grouped.inputTokens, "500"); assert.equal(grouped.groups.reduce((n, g) => n + g.runs, 0), 7);

  await models.save(db, { provider: "openai", model: "second-fixture", label: "Second model", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, isDefaultChat: true });
  await assistant.updatePolicy(db, { assistantAutoEnabled: true, assistantAutoMode: "live" });
  mode = "operation";
  const operation = await send();
  assert.equal(operation.actions.length, 1); assert.equal(operation.actions[0]?.status, "succeeded");
  const operationRows = await ownerUsage.listUsage(db, { ...personalQuery, source: "ti_operation" });
  assert.equal(operationRows.total, 1); assert.deepEqual(operationRows.items[0]?.operationIds, [operation.actions[0]!.id]);
  assert.equal(operationRows.items[0]?.modelSnapshot?.configuredModel, "second-fixture");
  assert.equal(operationRows.items[0]?.summary.inputTokens, 100, "CRUD adds no fabricated tokens");
  mode = "normal"; await send();
  assert.equal((await ownerUsage.listUsage(db, personalQuery)).total, 10);
  mode = "cancel";
  await assert.rejects(assistant.sendReadOnlyMessage(db, sendAssistantMessageSchema.parse({ message: "Cancel fixture", requestId: randomUUID(), context: { contextKind: "global" } }), async event => {
    if (event.type === "text") throw new DOMException("Fixture cancellation", "AbortError");
  }));
  const cancelled = (await ownerUsage.listUsage(db, personalQuery)).items.find(r => r.outcome === "cancelled");
  assert.ok(cancelled); assert.equal(cancelled.summary.completeness, "unknown"); assert.equal(cancelled.summary.inputTokens, null);

  const actor = { id: f.owner.account.actorId, type: "human" as const };
  const [req] = await db.insert(requirements).values({ projectId: f.project.id, title: "Legacy usage", createdBy: actor.id }).returning();
  const [task] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: req!.id, title: "Legacy task", createdBy: actor.id }).returning();
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: "Legacy usage agent" });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "maintainer", explicitPermissions: [] });
  const key = await f.identity.issueKey(f.owner.headers, agent.id, { name: "Usage fixture", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read", "resource.write", "execution.run", "audit.read"] }] });
  const agentIdentity = await f.auth.resolve(new Headers({ authorization: `Bearer ${key.rawKey}` }));
  const agentUsage = createResourceServices(agentIdentity).agentUsageService;
  const [daemon] = await db.insert(daemons).values({ name: "Legacy fixture", actorId: agent.id, actorType: "agent", role: "executor" }).returning();
  await db.update(requirements).set({ leaseGeneration: 1 }).where(eq(requirements.id, req!.id));
  const [claim] = await db.insert(requirementClaims).values({ requirementId: req!.id, daemonId: daemon!.id, claimedBy: agent.id, claimedByType: "agent", generation: 1, workerIndex: "0", expiresAt: new Date(Date.now() + 60_000) }).returning();
  const summary = { inputTokens: 20, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, cacheSemantics: "unknown" as const, provider: "unknown", model: "legacy", completeness: "complete" as const };
  const report = { processId: randomUUID(), projectId: f.project.id, requirementId: req!.id, daemonId: daemon!.id, runId: claim!.id, leaseGeneration: 1, workerIndex: "0", agent: "codex", phase: "execution" as const, startedAt: new Date().toISOString(), endedAt: null, outcome: "running" as const, revision: 1, summary };
  await Promise.all([agentUsage.reportDaemonUsage(db, report, { id: agent.id, type: "agent" }), agentUsage.reportDaemonUsage(db, report, { id: agent.id, type: "agent" })]);
  await assert.rejects(agentUsage.reportDaemonUsage(db, { ...report, summary: { ...summary, inputTokens: 21 } }, { id: agent.id, type: "agent" }));
  const [run] = await db.insert(tiAgentRuns).values({ taskId: task!.id, assignedAgentId: actor.id, createdBy: actor.id, status: "running", leaseOwnerId: "worker", leaseOwnerType: "agent", leaseExpiresAt: new Date(Date.now() + 60_000), startedAt: new Date() }).returning();
  const ti = { processId: randomUUID(), workerId: "worker", attempt: 0, startedAt: new Date().toISOString(), endedAt: null, outcome: "running" as const, revision: 1, summary };
  const legacyTi = { processId: ti.processId, projectId: f.project.id, requirementId: req!.id, taskId: task!.id, tiRunId: run!.id,
    attempt: 0, source: "ti_runtime" as const, agent: "ti", phase: "execution" as const, outcome: "cancelled" as const,
    startedAt: new Date(ti.startedAt), endedAt: new Date(), revision: 1, summary: { ...summary, completeness: "partial" as const }, reportedBy: actor.id };
  await db.insert(agentUsageRuns).values(legacyTi).onConflictDoNothing();
  await db.insert(agentUsageRuns).values(legacyTi).onConflictDoNothing();
  const total = await ownerUsage.summarizeUsage(db, { scope: "project", projectId: f.project.id, limit: 25, offset: 0 });
  assert.equal(total.runs, 3); assert.equal(total.inputTokens, "140"); assert.equal(total.knownUnregisteredTiAttempts, 0);
  assert.equal((await db.select().from(agentUsageRuns)).length, calls + 2, "Delegated/process reporting never duplicates Chat records");
});
