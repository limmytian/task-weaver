import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, authSessions, authActors, authRateLimits, webhooks, webhookDeliveries } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, createWebhookService, webhookService, createWebhookSchema, updateWebhookSchema } = apiRequire("@task-weaver/core");
const { eq, like } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("webhook authorization binds ownership, scope, credentials and outbound retries", { skip: !databaseUrl, timeout: 150_000 }, async t => {
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

  const services = (identity: any) => createWebhookService(identity.context);
  const input = createWebhookSchema.parse({ projectId: project.id, url: "https://hooks.example.test/receive", events: ["task.created", "document.updated", "document.deleted", "document.linked"] });
  const hook = await services(owner).createWebhook(db, input);
  const calls: Array<{ url: string; body: string; headers: Headers; redirect: string }> = [];
  let fail = false;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), body: init.body, headers: new Headers(init.headers), redirect: init.redirect });
    return new Response("Untrusted response content", { status: fail ? 503 : 200 });
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const visible = { type: "task_created", projectId: project.id, taskId: task.id, title: "Private title", attributes: { secret: "Internal provider value" } };
  async function rest(path: string, identity: any, method = "GET", body?: unknown) {
    const headers = new Headers(identity?.headers ?? {}); headers.set("content-type", "application/json");
    const response = await api.request(`/api/v1/webhooks${path}`, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  await t.test("management requires project rights and secrets are returned only once", async () => {
    assert.ok(hook.secret);
    for (const identity of [admin, outsider, viewer, member]) {
      await assert.rejects(services(identity).getWebhook(db, hook.id));
      await assert.rejects(services(identity).createWebhook(db, input));
      assert.equal((await rest(`/${hook.id}`, identity)).status, 404);
    }
    assert.equal((await rest(`/${hook.id}`, null)).status, 401);
    for (const value of [await services(owner).getWebhook(db, hook.id), await services(owner).listWebhooks(db), await services(owner).updateWebhook(db, hook.id, { description: "Updated" })]) {
      assert.ok(!JSON.stringify(value).includes(hook.secret));
      assert.ok(!JSON.stringify(value).includes("authorityCeiling"));
    }
    const rotated = await services(owner).updateWebhook(db, hook.id, updateWebhookSchema.parse({ rotateSecret: true }));
    assert.ok(rotated.secret && rotated.secret !== hook.secret);
    hook.secret = rotated.secret;
    assert.ok(!JSON.stringify(await services(owner).getWebhook(db, hook.id)).includes(hook.secret));
    assert.equal((await rest(`/${hook.id}`, owner, "PATCH", { ownerActorId: outsider.actor.id })).status, 400);
    await assert.rejects(webhookService.getWebhook(db, hook.id));
  });
  await t.test("actual REST management and test delivery use the verified core service", async () => {
    const created = await rest("", owner, "POST", input);
    assert.equal(created.status, 201);
    assert.ok(created.body.secret);
    const detail = await rest(`/${created.body.id}`, owner);
    assert.equal(detail.status, 200);
    assert.ok(!("secret" in detail.body));
    const rotated = await rest(`/${created.body.id}`, owner, "PATCH", { rotateSecret: true });
    assert.equal(rotated.status, 200);
    assert.ok(rotated.body.secret !== created.body.secret);
    const tested = await rest(`/${created.body.id}/test`, owner, "POST");
    assert.equal(tested.status, 200);
    assert.equal(tested.body.status, "success");
    assert.equal((await rest(`/${created.body.id}`, owner, "DELETE")).status, 200);
  });
  await t.test("outbound HMAC covers only authorized hints and routine logs omit payload and response", async () => {
    calls.length = 0;
    await webhookService.deliverEvent(db, visible);
    assert.equal(calls.length, 1);
    const request = calls[0];
    assert.equal(request.headers.get("X-TaskWeaver-Signature"), `sha256=${createHmac("sha256", hook.secret).update(request.body).digest("hex")}`);
    assert.equal(request.redirect, "manual");
    for (const secret of [hook.secret, "Private title", "Internal provider value", "attributes"]) assert.ok(!request.body.includes(secret));
    const logs = await services(owner).listWebhookDeliveries(db, hook.id);
    assert.equal(logs[0].status, "success");
    assert.ok(!JSON.stringify(logs).includes("Untrusted response"));
    assert.ok(!JSON.stringify(logs).includes(task.id));
    assert.ok(!JSON.stringify(logs).includes("payload"));
  });
  await t.test("project and global hooks cannot exfiltrate private or other-project resources", async () => {
    const globalHook = await services(admin).createWebhook(db, { ...input, projectId: undefined });
    for (const identity of [owner, member]) await assert.rejects(services(identity).createWebhook(db, { ...input, projectId: undefined }));
    calls.length = 0;
    await webhookService.deliverEvent(db, { ...visible, projectId: other.id });
    await webhookService.deliverEvent(db, { type: "document_updated", documentId: personal.id });
    await webhookService.deliverEvent(db, { type: "document_updated", documentId: hiddenDoc.id });
    await webhookService.deliverEvent(db, { type: "document_linked", sourceDocId: doc.id, targetDocId: hiddenDoc.id });
    assert.equal(calls.length, 0);
    const shared = await admin.service.documentService.createDocument(db, { title: "Shared", content: "Public instance resource" }, admin.actor);
    await webhookService.deliverEvent(db, { type: "document_updated", documentId: shared.id });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, globalHook.url);
    await services(admin).deleteWebhook(db, globalHook.id);
  });
  await t.test("credential ceiling and revocation apply to fanout, retries and test delivery", async () => {
    const readOnly = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Read", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read"] }], expiresAt: null });
    const readContext = await runtime.verify(new Headers({ authorization: `Bearer ${readOnly.rawKey}` }));
    await assert.rejects(createWebhookService(readContext).createWebhook(db, input));
    const key = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Hook", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read", "webhook.manage"] }], expiresAt: null });
    const context = await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` }));
    const keyService = createWebhookService(context);
    const bound = await keyService.createWebhook(db, input);
    fail = true;
    const attempt = await keyService.sendTestEvent(db, bound.id);
    assert.equal(attempt.status, "failed");
    const retry = await keyService.retryWebhookDelivery(db, bound.id, attempt.id);
    assert.equal(retry.retryCount, 1);
    await runtime.identity.revokeKey(owner.headers, owner.actor.id, key.id);
    calls.length = 0;
    await webhookService.deliverEvent(db, visible);
    assert.equal(calls.length, 1); // Only the separately session-bound hook remains eligible.
    await assert.rejects(services(owner).sendTestEvent(db, bound.id));
    await assert.rejects(services(owner).retryWebhookDelivery(db, bound.id, attempt.id));
    await services(owner).deleteWebhook(db, bound.id);
    fail = false;
  });
  await t.test("stale configuration generations and resource changes cannot restore replay eligibility", async () => {
    fail = true;
    await webhookService.deliverEvent(db, visible);
    const logs = await services(owner).listWebhookDeliveries(db, hook.id);
    const attempt = logs.find((row: any) => row.status === "failed");
    assert.ok(attempt);
    await assert.rejects(owner.service.taskService.updateTask(db, task.id, { projectId: other.id, requirementId: otherRequirement.id }, owner.actor));
    // A current owner cannot transfer to an unauthorized project; simulated corrupt storage still must fail closed.
    const [stored] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, attempt.id));
    await db.update(webhookDeliveries).set({ payload: { ...(stored.payload as object), data: { type: "task_created", taskId: task.id, projectId: other.id } } }).where(eq(webhookDeliveries.id, attempt.id));
    calls.length = 0;
    await assert.rejects(services(owner).retryWebhookDelivery(db, hook.id, attempt.id));
    assert.equal(calls.length, 0);
    await services(owner).updateWebhook(db, hook.id, { rotateSecret: true });
    assert.deepEqual(await services(owner).listWebhookDeliveries(db, hook.id), []);
    await assert.rejects(services(owner).retryWebhookDelivery(db, hook.id, attempt.id));
    fail = false;
  });
  await t.test("membership reductions and disabled subjects stop existing bindings", async () => {
    await runtime.identity.setMembership(owner.headers, project.id, member.actor.id, { role: "maintainer" });
    const bound = await services(member).createWebhook(db, input);
    await runtime.identity.setMembership(owner.headers, project.id, member.actor.id, { role: "member" });
    calls.length = 0;
    await webhookService.deliverEvent(db, visible);
    assert.equal(calls.length, 1);
    await assert.rejects(services(owner).sendTestEvent(db, bound.id));
    await services(owner).deleteWebhook(db, bound.id);
    const otherTask = await outsider.service.taskService.createTask(db, { projectId: other.id, requirementId: otherRequirement.id, title: "Other" }, outsider.actor);
    await services(outsider).createWebhook(db, { ...input, projectId: other.id });
    await db.update(authActors).set({ status: "disabled" }).where(eq(authActors.id, outsider.actor.id));
    calls.length = 0;
    await webhookService.deliverEvent(db, { ...visible, projectId: other.id, taskId: otherTask.id });
    assert.equal(calls.length, 0);
  });
  await t.test("legacy hooks stay closed and session expiry stops delivery", async () => {
    const [legacy] = await db.insert(webhooks).values({ projectId: project.id, url: input.url, events: input.events, secret: randomBytes(32).toString("hex"), active: true }).returning();
    calls.length = 0;
    await webhookService.deliverEvent(db, visible);
    assert.equal(calls.length, 1);
    assert.deepEqual(await services(owner).listWebhookDeliveries(db, legacy.id), []);
    await services(owner).deleteWebhook(db, legacy.id);
    await db.update(authSessions).set({ createdAt: new Date(Date.now() - 10000), authenticatedAt: new Date(Date.now() - 10000), idleExpiresAt: new Date(Date.now() - 1000) }).where(eq(authSessions.id, owner.context.credential.id));
    calls.length = 0;
    await webhookService.deliverEvent(db, visible);
    assert.equal(calls.length, 0);
    const fresh = await login(email); // This is the administrator; it has no project management authority.
    await assert.rejects(services(fresh).getWebhook(db, hook.id));
  });
});
