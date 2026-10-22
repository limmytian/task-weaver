import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { serve } = apiRequire("@hono/node-server");
const { createDb, runMigrations, authInstanceState, authRateLimits, inboundEvents, inboundSources, tasks, webhookEvents } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, createInboundSourceService, processInboundEventOnce } = apiRequire("@task-weaver/core");
const { eq, like } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("verified HTTP inbound events commit only scoped, deduplicated platform actions", { skip: !databaseUrl, timeout: 120_000 }, async t => {
  assert.equal(new URL(databaseUrl!).hostname, "127.0.0.1");
  assert.equal(new URL(databaseUrl!).pathname, "/tw_auth_e2e");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
  // Bootstrap a fresh fixture instance without inheriting another suite's rate counter.
  await db.delete(authRateLimits).where(like(authRateLimits.id, "bootstrap:%"));
  await db.update(authInstanceState).set({ initializedByUserId: null, initializedAt: null }).where(eq(authInstanceState.id, "instance"));
  const config = {
    secret: randomBytes(32).toString("hex"), bootstrapSecret: randomBytes(32).toString("hex"),
    baseURL: "http://127.0.0.1:3001", trustedOrigins: ["http://127.0.0.1:3000"],
  };
  const runtime = createAuthenticationRuntime(db, config);
  const auth = runtime.authentication;
  const password = randomBytes(24).toString("hex");
  function csrf() {
    const challenge = auth.csrfChallenge();
    return new Headers({ origin: config.trustedOrigins[0], "x-csrf-token": challenge.csrfToken, cookie: challenge.headers.getSetCookie().map((c: string) => c.split(";")[0]).join("; ") });
  }
  async function login(email: string) {
    const headers = csrf();
    const result = await auth.login(headers, { email, password }, randomUUID());
    headers.set("cookie", [headers.get("cookie"), ...result.headers.getSetCookie().map((c: string) => c.split(";")[0])].join("; "));
    const context = await runtime.verify(headers);
    return { headers, context, actor: { id: context.actor.id, type: context.actor.type }, service: createResourceServices(context) };
  }
  const email = `${randomUUID()}@example.test`;
  await auth.bootstrap(csrf(), { email, displayName: "Admin fixture", password, bootstrapSecret: config.bootstrapSecret }, randomUUID());
  const admin = await login(email);
  async function human() {
    const email = `${randomUUID()}@example.test`;
    const invitation = await auth.provision(admin.headers, { email, displayName: "Resource fixture" });
    await auth.activate(csrf(), { token: invitation.activationToken, password }, randomUUID());
    return login(email);
  }
  const owner = await human(), outsider = await human();
  const project = await owner.service.projectService.createProject(db, { name: "Inbound owned project" }, owner.actor);
  const other = await outsider.service.projectService.createProject(db, { name: "Inbound other project" }, outsider.actor);
  const requirement = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: "Inbound work", status: "approved" }, owner.actor);
  const siblingRequirement = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: "Other lane", status: "approved" }, owner.actor);
  const otherRequirement = await outsider.service.requirementService.createRequirement(db, { projectId: other.id, title: "Foreign lane", status: "approved" }, outsider.actor);
  const task = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: requirement.id, title: "Inbound target" }, owner.actor);
  const sibling = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: siblingRequirement.id, title: "Sibling target" }, owner.actor);
  const foreign = await outsider.service.taskService.createTask(db, { projectId: other.id, requirementId: otherRequirement.id, title: "Foreign target" }, outsider.actor);
  const app = createApiApplication({ db, databaseUrl: databaseUrl!, env: { TW_AUTH_SECRET: config.secret, TW_AUTH_BASE_URL: config.baseURL,
    TW_AUTH_TRUSTED_ORIGINS: config.trustedOrigins[0], TW_PRESET_SKILLS_SYNC: "disabled" } }).app;
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  const manager = createInboundSourceService(owner.context);
  const ruleId = randomUUID();
  const input = { name: "Build source", projectId: project.id, requirementId: requirement.id, active: true, rules: [{ id: ruleId,
    eventTypes: ["build.completed"], conditions: [{ path: "data.status", operator: "equals", value: "passed" }], actions: [
      { type: "create_task", title: "Build {{data.name}}" },
      { type: "add_comment", target: { taskIdPath: "data.taskId" }, content: "Build {{data.name}} verified" },
      { type: "update_task", target: { taskIdPath: "data.taskId" }, changes: { priority: "high" } },
      { type: "record_evidence", target: { taskIdPath: "data.taskId" }, content: "Build evidence {{data.name}}" },
    ] }] };
  const headers = new Headers(owner.headers); headers.set("content-type", "application/json");
  const response = await app.request("/api/v1/inbound/sources", { method: "POST", headers, body: JSON.stringify(input) });
  assert.equal(response.status, 201);
  const source = await response.json() as any;
  const send = async (value: unknown, options: { secret?: string; timestamp?: number; raw?: string } = {}) => {
    const body = options.raw ?? JSON.stringify(value), timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", options.secret ?? source.secret).update(`${timestamp}.${body}`).digest("hex");
    return fetch(base + source.endpoint, { method: "POST", headers: { "content-type": "application/json", "x-taskweaver-signature-v1": `t=${timestamp},v1=${signature}` }, body });
  };
  const envelope = (overrides: Record<string, unknown> = {}) => ({ eventId: randomUUID(), type: "build.completed", data: { name: randomUUID(), status: "passed", taskId: task.id }, ...overrides });
  const drain = async (eventId: string) => {
    for (let i = 0; i < 100; i++) {
      const row = await db.query.inboundEvents.findFirst({ where: eq(inboundEvents.id, eventId) });
      if (!["pending", "processing"].includes(row.status)) return row;
      await processInboundEventOnce(db);
    }
    throw new Error("Inbox did not drain");
  };
  await t.test("signature, timestamp, size, envelope and management boundaries fail closed", async () => {
    assert.equal((await send(envelope(), { secret: "wrong" })).status, 401);
    assert.equal((await send(envelope(), { timestamp: Math.floor(Date.now() / 1000) - 600 })).status, 401);
    assert.equal((await send(envelope(), { raw: "{" })).status, 400);
    assert.equal((await send(envelope(), { raw: "x".repeat(65_537) })).status, 413);
    assert.equal((await send({ ...envelope(), ownerActorId: outsider.actor.id })).status, 400);
    await assert.rejects(() => createInboundSourceService(outsider.context).list(db, project.id));
    assert.ok(!JSON.stringify(await manager.list(db, project.id)).includes(source.secret));
  });
  await t.test("accepted events survive restart and commit actions plus causation receipts exactly once", async () => {
    const event = envelope();
    const accepted = await send(event); assert.equal(accepted.status, 202);
    const receipt = await accepted.json() as any;
    assert.equal((await manager.receipts(db, source.id, receipt.id)).length, 0);
    assert.equal((await (await send(event)).json() as any).duplicate, true);
    await db.update(inboundEvents).set({ status: "processing", leaseId: randomUUID(), leaseExpiresAt: new Date(0), attempts: 1 }).where(eq(inboundEvents.id, receipt.id));
    assert.equal((await drain(receipt.id)).status, "processed");
    const actions = await manager.receipts(db, source.id, receipt.id); assert.equal(actions.length, 4);
    const created = await db.query.tasks.findFirst({ where: eq(tasks.id, actions.find((action: any) => action.actionType === "create_task").entityId) });
    assert.equal(created.projectId, project.id); assert.equal(created.requirementId, requirement.id);
    assert.equal((await owner.service.taskService.getTaskDetail(db, task.id)).priority, "high");
    const correlated = await db.select().from(webhookEvents).where(eq(webhookEvents.causationId, receipt.id));
    assert.ok(correlated.length >= 2); assert.ok(correlated.every((event: any) => event.actorId === owner.actor.id));
    await processInboundEventOnce(db);
    assert.equal((await manager.receipts(db, source.id, receipt.id)).length, 4);
    assert.equal((await send({ ...event, data: { ...event.data, name: "changed" } })).status, 409);
    await assert.rejects(() => manager.retry(db, source.id, receipt.id));
  });
  await t.test("forged same-project-other-lane and foreign targets roll back the entire action batch", async () => {
    for (const target of [sibling.id, foreign.id]) {
      const value = envelope({ data: { name: randomUUID(), status: "passed", taskId: target, projectId: other.id, credentialId: outsider.context.credential.id } });
      const accepted = await send(value); const receipt = await accepted.json() as any;
      const before = await db.select().from(tasks).where(eq(tasks.requirementId, requirement.id));
      assert.equal((await drain(receipt.id)).status, "failed");
      assert.equal((await manager.receipts(db, source.id, receipt.id)).length, 0);
      assert.equal((await db.select().from(tasks).where(eq(tasks.requirementId, requirement.id))).length, before.length);
    }
  });
  await t.test("rotation and credential revocation invalidate already accepted work", async () => {
    const accepted = await (await send(envelope())).json() as any;
    const rotated = await manager.update(db, source.id, { rotateSecret: true });
    assert.equal((await drain(accepted.id)).status, "failed");
    assert.equal((await send(envelope())).status, 401);
    source.secret = rotated.secret;
    const key = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Inbound binding", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read", "resource.write", "webhook.manage"] }], expiresAt: null });
    const context = await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` }));
    const bound = await createInboundSourceService(context).create(db, input);
    const body = JSON.stringify(envelope()), timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", bound.secret).update(`${timestamp}.${body}`).digest("hex");
    const pending = await fetch(base + bound.endpoint, { method: "POST", headers: { "x-taskweaver-signature-v1": `t=${timestamp},v1=${signature}` }, body });
    const receipt = await pending.json() as any;
    await runtime.identity.revokeKey(owner.headers, owner.actor.id, key.id);
    assert.equal((await drain(receipt.id)).status, "failed");
    assert.equal((await manager.receipts(db, bound.id, receipt.id)).length, 0);
  });
  await t.test("a real PostgreSQL serialization failure rolls back actions and a fresh worker retries once", async () => {
    const fault = await manager.create(db, { ...input, name: "Fault recovery", rules: [{ id: randomUUID(), eventTypes: ["build.completed"], conditions: [], actions: [
      { type: "create_task", title: "Fault-proof-{{data.name}}" },
      { type: "add_comment", target: { taskIdPath: "data.taskId" }, content: "Recovered {{data.name}}" },
    ] }] });
    await db.$client.unsafe(`CREATE SEQUENCE task_weaver.inbound_test_failure;
      CREATE FUNCTION task_weaver.inbound_test_fail_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.title LIKE 'Fault-proof-%' AND nextval('task_weaver.inbound_test_failure') = 1 THEN
          RAISE EXCEPTION 'Acceptance serialization fault' USING ERRCODE = '40001';
        END IF; RETURN NEW; END $$;
      CREATE TRIGGER inbound_test_failure BEFORE INSERT ON task_weaver.tasks FOR EACH ROW EXECUTE FUNCTION task_weaver.inbound_test_fail_once();`).simple();
    try {
      const event = envelope(), body = JSON.stringify(event), timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac("sha256", fault.secret).update(`${timestamp}.${body}`).digest("hex");
      const accepted = await fetch(base + fault.endpoint, { method: "POST", headers: { "x-taskweaver-signature-v1": `t=${timestamp},v1=${signature}` }, body });
      assert.equal(accepted.status, 202);
      const receipt = await accepted.json() as any;
      assert.equal((await drain(receipt.id)).status, "failed");
      assert.equal((await manager.receipts(db, fault.id, receipt.id)).length, 0);
      assert.ok((await db.query.inboundEvents.findFirst({ where: eq(inboundEvents.id, receipt.id) })).nextAttemptAt);
      await db.update(inboundEvents).set({ nextAttemptAt: new Date(0) }).where(eq(inboundEvents.id, receipt.id));
      await processInboundEventOnce(db);
      const result = await db.query.inboundEvents.findFirst({ where: eq(inboundEvents.id, receipt.id) });
      assert.equal(result.status, "processed"); assert.equal(result.attempts, 2);
      assert.equal((await manager.receipts(db, fault.id, receipt.id)).length, 2);
      assert.equal((await db.select().from(tasks).where(eq(tasks.title, `Fault-proof-${event.data.name}`))).length, 1);
    } finally {
      await db.$client.unsafe(`DROP TRIGGER inbound_test_failure ON task_weaver.tasks; DROP FUNCTION task_weaver.inbound_test_fail_once(); DROP SEQUENCE task_weaver.inbound_test_failure;`).simple();
      await manager.delete(db, fault.id);
    }
  });
  await t.test("verified actions reuse existing schedules under their original project and requirement", async () => {
    await runtime.identity.setMembership(owner.headers, project.id, outsider.actor.id, { role: "owner" });
    await runtime.identity.setMembership(outsider.headers, project.id, owner.actor.id, { role: "owner", explicitPermissions: ["execution.run"] });
    const { createScheduleSchema } = apiRequire("@task-weaver/core");
    const schedule = await owner.service.scheduleService.createSchedule(db, createScheduleSchema.parse({ projectId: project.id, requirementId: requirement.id,
      targetScope: "project", kind: "one_off", title: "Inbound schedule", startsAt: new Date(), taskTemplate: { title: "Inbound scheduled task" }, autoRun: false }), owner.actor);
    const scheduled = await manager.create(db, { ...input, name: "Schedule source", rules: [{ id: randomUUID(), eventTypes: ["schedule.requested"], conditions: [], actions: [{ type: "run_schedule", scheduleId: schedule.id }] }] });
    const body = JSON.stringify({ eventId: randomUUID(), type: "schedule.requested", data: {} }), timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", scheduled.secret).update(`${timestamp}.${body}`).digest("hex");
    const accepted = await fetch(base + scheduled.endpoint, { method: "POST", headers: { "x-taskweaver-signature-v1": `t=${timestamp},v1=${signature}` }, body });
    assert.equal(accepted.status, 202);
    const event = await accepted.json() as any;
    assert.equal((await drain(event.id)).status, "processed");
    const actions = await manager.receipts(db, scheduled.id, event.id); assert.equal(actions.length, 1);
    const runs = await owner.service.scheduleService.listScheduleRuns(db, schedule.id);
    assert.equal(runs.length, 1); assert.equal(runs[0].id, actions[0].entityId);
    const generated = await owner.service.taskService.getTask(db, runs[0].generatedTaskId);
    assert.equal(generated.projectId, project.id); assert.equal(generated.requirementId, requirement.id);
    await manager.delete(db, scheduled.id);
  });
  await t.test("unmatched events are ignored and persisted source rate limits return HTTP 429", async () => {
    const ignored = await (await send(envelope({ type: "unmatched" }))).json() as any;
    assert.equal((await drain(ignored.id)).status, "ignored");
    const storedSource = await db.query.inboundSources.findFirst({ where: eq(inboundSources.id, source.id) });
    await db.insert(inboundEvents).values(Array.from({ length: 101 }, () => ({ sourceId: source.id, bindingId: storedSource.bindingId,
      externalId: randomUUID(), eventType: "rate-fixture", payloadHash: "fixture", payload: {}, status: "processed" })));
    assert.equal((await send(envelope())).status, 429);
  });
  await manager.delete(db, source.id);
});
