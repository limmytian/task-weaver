import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, authSessions, authActors, authRateLimits, daemons, daemonWorkerProgress } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, authorizedRealtimeEvent, createAuthorizedEventStream, resourceAuthority, createScheduleSchema } = apiRequire("@task-weaver/core");
const { eq, like } = apiRequire("drizzle-orm");
const { emit } = apiRequire("@task-weaver/realtime");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("realtime authorization rechecks resource scopes, credentials and stream resumptions", { skip: !databaseUrl, timeout: 150_000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/tw_auth_e2e");
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
  const owner = await human(), outsider = await human(), viewer = await human(), member = await human();
  const project = await owner.service.projectService.createProject(db, { name: "Owned project" }, owner.actor);
  const other = await outsider.service.projectService.createProject(db, { name: "Other project" }, outsider.actor);
  await runtime.identity.setMembership(owner.headers, project.id, viewer.actor.id, { role: "viewer" });
  await runtime.identity.setMembership(owner.headers, project.id, member.actor.id, { role: "member" });
  const requirement = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: "Work", status: "approved" }, owner.actor);
  const otherRequirement = await outsider.service.requirementService.createRequirement(db, { projectId: other.id, title: "Private work", status: "approved" }, outsider.actor);
  const task = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: requirement.id, title: "Task" }, owner.actor);
  const doc = await owner.service.documentService.createDocument(db, { projectId: project.id, title: "Project document", content: "Version one" }, owner.actor);
  const personal = await owner.service.documentService.createDocument(db, { personalOwnerId: owner.actor.id, personalOwnerType: "human", title: "Private note", content: "Private content" }, owner.actor);
  const hiddenDoc = await outsider.service.documentService.createDocument(db, { personalOwnerId: outsider.actor.id, personalOwnerType: "human", title: "Hidden wiki target", content: "Hidden content" }, outsider.actor);
  const api = createApiApplication({ db, databaseUrl: databaseUrl!, env: { TW_AUTH_SECRET: config.secret, TW_AUTH_BASE_URL: config.baseURL, TW_AUTH_TRUSTED_ORIGINS: config.trustedOrigins[0], TW_PRESET_SKILLS_SYNC: "disabled" } }).app;
  async function event(identity: any, value: any) {
    return authorizedRealtimeEvent(db, await resourceAuthority(db, identity.context), value);
  }
  await t.test("project and personal events reject outsiders and administrators", async () => {
    for (const value of [
      { type: "task_created", taskId: task.id, projectId: project.id, title: "Secret" },
      { type: "document_updated", documentId: doc.id },
      { type: "requirement_updated", requirementId: requirement.id, projectId: project.id },
    ]) {
      assert.ok(await event(owner, value));
      assert.ok(await event(viewer, value));
      assert.equal(await event(outsider, value), null);
      assert.equal(await event(admin, value), null);
    }
    const value = { type: "document_updated", documentId: personal.id };
    assert.ok(await event(owner, value));
    for (const identity of [admin, outsider, viewer]) assert.equal(await event(identity, value), null);
    assert.equal(await event(owner, { type: "task_updated", taskId: task.id, projectId: other.id }), null);
  });
  await t.test("link events require both endpoints, including unlink hints", async () => {
    assert.equal(await event(owner, { type: "document_linked", sourceDocId: doc.id, targetDocId: hiddenDoc.id }), null);
    assert.equal(await event(owner, { type: "document_unlinked", linkId: randomUUID() }), null);
    assert.ok(await event(owner, { type: "document_unlinked", linkId: randomUUID(), sourceDocId: doc.id, targetDocId: personal.id }));
    assert.equal(await event(viewer, { type: "document_unlinked", linkId: randomUUID(), sourceDocId: doc.id, targetDocId: personal.id }), null);
  });
  await t.test("deleted documents use persisted scoped tombstones", async () => {
    await owner.service.documentService.deleteDocument(db, personal.id, owner.actor);
    const value = { type: "document_deleted", documentId: personal.id };
    assert.ok(await event(owner, value));
    assert.equal(await event(admin, value), null);
    assert.equal(await event(owner, { type: "document_deleted", documentId: randomUUID() }), null);
  });
  await t.test("schedule and daemon hints obey stored relations and omit mixed worker payloads", async () => {
    const schedule = await owner.service.scheduleService.createSchedule(db, createScheduleSchema.parse({ targetScope: "personal", kind: "one_off", title: "Private reminder", startsAt: new Date(), taskTemplate: { title: "Reminder" } }), owner.actor);
    const hint = { type: "schedule_updated", projectId: null, scheduleId: schedule.id };
    assert.ok(await event(owner, hint));
    for (const identity of [admin, outsider, viewer]) assert.equal(await event(identity, hint), null);
    const [daemon] = await db.insert(daemons).values({ name: "Fixture", role: "executor", status: "idle", activeWorkerStates: [{ requirementId: otherRequirement.id, message: "hidden" }] }).returning();
    const runId = randomUUID();
    await db.insert(daemonWorkerProgress).values({ daemonId: daemon.id, runId, workerIndex: 0, role: "executor", phase: "executing", requirementId: requirement.id, currentTaskId: task.id, leaseGeneration: 1 });
    const status = { type: "daemon_status_changed", daemonId: daemon.id, status: "idle", host: "secret-host", activeTaskIds: [randomUUID()] };
    assert.deepEqual(await event(owner, status), { type: status.type, daemonId: daemon.id });
    assert.equal(await event(admin, status), null);
    const progress = { type: "daemon_progress_updated", projectId: project.id, daemonId: daemon.id, runId, requirementId: requirement.id, currentTaskId: task.id, executionSliceId: null, message: "secret" };
    assert.ok(await event(owner, progress));
    assert.equal(await event(viewer, progress), null); // audit.read is required.
    assert.equal(await event(owner, { ...progress, requirementId: otherRequirement.id }), null);
    assert.ok(!JSON.stringify(await event(owner, progress)).includes("secret"));
  });
  await t.test("scoped keys and revoked membership never regain personal or project access", async () => {
    const key = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Events", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read"] }], expiresAt: null });
    const headers = new Headers({ authorization: `Bearer ${key.rawKey}` });
    const identity = { context: await runtime.verify(headers) };
    assert.ok(await event(identity, { type: "task_updated", taskId: task.id, projectId: project.id }));
    assert.equal(await event(identity, { type: "document_updated", documentId: hiddenDoc.id }), null);
    const response = await createAuthorizedEventStream(db, identity.context, new Request("http://localhost/events", { headers: { "Last-Event-ID": "999999999999-999999999" } }), { heartbeatMs: 10 });
    const reader = response.body!.getReader();
    const connected = new TextDecoder().decode((await reader.read()).value);
    assert.ok(connected.includes('"resume":"resync"'));
    assert.ok(!connected.includes("999999999"));
    await runtime.identity.revokeKey(owner.headers, owner.actor.id, key.id);
    while (!(await reader.read()).done) { /* Drain already authorized heartbeat frames. */ }
    await assert.rejects(resourceAuthority(db, identity.context));
  });
  await t.test("filtered SSE uses connection-local sequences and omits raw metadata", async () => {
    const response = await createAuthorizedEventStream(db, owner.context, new Request("http://localhost/events"), { heartbeatMs: 60_000 });
    const reader = response.body!.getReader();
    await reader.read();
    emit({ type: "task_created", projectId: other.id, taskId: randomUUID(), title: "Hidden", sequence: 987654 });
    emit({ type: "task_created", projectId: project.id, taskId: task.id, title: "Secret", attributes: { secret: "provider" }, sequence: 987655 });
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert.ok(frame.includes('"sequence":1'));
    for (const hidden of ["987654", "987655", "Hidden", "Secret", "provider", "attributes", "cursor"]) assert.ok(!frame.includes(hidden));
    await reader.cancel();
  });
  await t.test("membership change closes a live stream before the next event", async () => {
    const response = await createAuthorizedEventStream(db, viewer.context, new Request("http://localhost/events"), { heartbeatMs: 10 });
    const reader = response.body!.getReader(); await reader.read();
    await runtime.identity.removeMembership(owner.headers, project.id, viewer.actor.id);
    while (!(await reader.read()).done) { /* Drain already authorized heartbeat frames. */ }
    assert.equal(await event(viewer, { type: "task_updated", taskId: task.id, projectId: project.id }), null);
  });
  await t.test("session expiry and actor disablement close long-lived connections", async () => {
    for (const mode of ["expire", "disable"] as const) {
      const identity = await human();
      const response = await createAuthorizedEventStream(db, identity.context, new Request("http://localhost/events"), { heartbeatMs: 10 });
      const reader = response.body!.getReader(); await reader.read();
      if (mode === "expire") await db.update(authSessions).set({ createdAt: new Date(Date.now() - 10000), authenticatedAt: new Date(Date.now() - 10000), idleExpiresAt: new Date(Date.now() - 1000) }).where(eq(authSessions.id, identity.context.credential.id));
      else await db.update(authActors).set({ status: "disabled" }).where(eq(authActors.id, identity.actor.id));
      while (!(await reader.read()).done) { /* Drain already authorized heartbeat frames. */ }
      await assert.rejects(createAuthorizedEventStream(db, identity.context, new Request("http://localhost/events", { headers: { "Last-Event-ID": "old-cursor" } })));
    }
  });
  await t.test("actual daemon SSE authenticates without granting supervisor authority", async () => {
    assert.equal((await api.request("/api/v1/daemons/events")).status, 401);
    assert.equal((await api.request("/api/v1/daemons/events", { headers: { "X-Actor-Id": owner.actor.id } })).status, 401);
    const response = await api.request("/api/v1/daemons/events", { headers: owner.headers });
    assert.equal(response.status, 404); // Polling configuration keeps the optional stream disabled.
    const previous = process.env.TW_DAEMON_MODE;
    process.env.TW_DAEMON_MODE = "sse";
    try {
      const live = await api.request("/api/v1/daemons/events", { headers: owner.headers });
      assert.equal(live.status, 200);
      const reader = live.body!.getReader(); await reader.read(); await reader.cancel();
    } finally {
      if (previous === undefined) delete process.env.TW_DAEMON_MODE;
      else process.env.TW_DAEMON_MODE = previous;
    }
    assert.equal((await api.request("/api/v1/daemons/register", { method: "POST", headers: owner.headers, body: JSON.stringify({ name: "Human SSE client", role: "executor", capabilities: ["codex"] }) })).status, 403);
  });
});
