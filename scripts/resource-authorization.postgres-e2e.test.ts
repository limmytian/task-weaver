import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
import { createTRPCContextFactory } from "../apps/web/trpc/init";
import { appRouter } from "../apps/web/trpc/routers/_app";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, documents, memories, tasks, documentLinks } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, NotFoundError, AuthorizationError, ValidationError } = apiRequire("@task-weaver/core");
const { eq } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("ordinary resources enforce live authorization consistently across transports", { skip: !databaseUrl, timeout: 150_000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/tw_auth_e2e");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
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
  async function rest(path: string, headers: Headers, method = "GET", body?: unknown) {
    const response = await api.request(`/api/v1/${path}`, { headers: new Headers([...headers, ["content-type", "application/json"]]), method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  async function caller(headers: Headers) {
    return appRouter.createCaller(await createTRPCContextFactory({ db, auth: runtime })({ req: new Request(`${config.trustedOrigins[0]}/api/trpc`, { headers, method: "POST" }) }));
  }
  async function graphql(headers: Headers, query: string) {
    return rest("graphql", headers, "POST", { query });
  }

  await t.test("nonmembers and administrators cannot read IDs; viewers cannot write", async () => {
    for (const user of [outsider, admin]) {
      await assert.rejects(user.service.projectService.getProject(db, project.id), NotFoundError);
      await assert.rejects(user.service.taskService.getTask(db, task.id), NotFoundError);
      await assert.rejects(user.service.documentService.getDocument(db, personal.id), NotFoundError);
      assert.equal((await rest(`tasks/${task.id}`, user.headers)).status, 404);
    }
    assert.equal((await viewer.service.taskService.getTask(db, task.id)).id, task.id);
    await assert.rejects(viewer.service.taskService.updateTask(db, task.id, { title: "Denied" }, viewer.actor), AuthorizationError);
    assert.equal((await rest(`tasks/${task.id}`, viewer.headers, "PATCH", { title: "Denied" })).status, 403);
  });
  await t.test("authorized SQL lists, counts and pagination exclude foreign projects", async () => {
    const list = await owner.service.projectService.listProjects(db, { view: "summary", page: 1, pageSize: 1 });
    assert.equal(list.total, 1);
    assert.equal(list.items[0].id, project.id);
    const counts = await owner.service.projectService.getProjectCounts(db, [project.id, other.id]);
    assert.deepEqual(counts.map((c: any) => c.projectId), [project.id]);
    await assert.rejects(owner.service.taskService.listTasks(db, { projectId: other.id }), NotFoundError);
  });
  await t.test("personal ownership and human-bound keys cannot be redirected", async () => {
    const key = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Personal fixture", grants: [{ scope: "personal", actorId: owner.actor.id, permissions: ["resource.read", "resource.write"] }], expiresAt: null });
    const context = await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` }));
    const services = createResourceServices(context);
    const item = await services.taskService.createPersonalTask(db, { title: "Human-owned key task" }, owner.actor);
    assert.equal(item.personalOwnerId, owner.actor.id);
    assert.equal(item.personalOwnerType, "human");
    await assert.rejects(services.taskService.createPersonalTask(db, { title: "Override", personalOwnerId: outsider.actor.id, personalOwnerType: "human" }, owner.actor), AuthorizationError);
    await assert.rejects(services.documentService.getDocument(db, doc.id), NotFoundError);
  });
  await t.test("task relations, assignee eligibility and batch preflight retain atomicity", async () => {
    await assert.rejects(owner.service.taskService.createTask(db, { projectId: project.id, requirementId: otherRequirement.id, title: "Cross project" }, owner.actor), NotFoundError);
    await assert.rejects(owner.service.taskService.updateTask(db, task.id, { assignee: viewer.actor.id, assigneeType: "human" }, owner.actor), ValidationError);
    await assert.rejects(owner.service.taskService.batchCreateTasks(db, { tasks: [{ projectId: project.id, requirementId: requirement.id, title: "Must roll back" }, { projectId: other.id, requirementId: otherRequirement.id, title: "Forbidden" }] }, owner.actor), AuthorizationError);
    const items = await owner.service.taskService.listTasks(db, { projectId: project.id });
    assert.equal(items.length, 1);
    const updated = await owner.service.taskService.updateTask(db, task.id, { assignee: member.actor.id, assigneeType: "human" }, owner.actor);
    assert.equal(updated.assignee, member.actor.id);
    const key = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Both projects forbidden ceiling", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read", "resource.write"] }], expiresAt: null });
    const services = createResourceServices(await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` })));
    await assert.rejects(services.taskService.updateTask(db, task.id, { requirementId: otherRequirement.id }, owner.actor), NotFoundError);
  });
  await t.test("claims require permission and retain holder and execution fences", async () => {
    await assert.rejects(viewer.service.claimService.claimTask(db, task.id, viewer.actor), AuthorizationError);
    const claim = await member.service.claimService.claimTask(db, task.id, member.actor);
    assert.equal(claim.claimedBy, member.actor.id);
    await assert.rejects(owner.service.claimService.releaseTask(db, task.id, owner.actor), ValidationError);
    await member.service.claimService.releaseTask(db, task.id, member.actor);
    await assert.rejects(member.service.claimService.claimRequirement(db, requirement.id, member.actor), AuthorizationError);
    assert.deepEqual(await outsider.service.claimService.listActiveClaims(db), []);
  });
  await t.test("document versions, links and backreferences respect both endpoints", async () => {
    await owner.service.documentService.updateDocument(db, personal.id, { content: "Version two" }, owner.actor);
    await assert.rejects(outsider.service.documentService.getDocumentVersion(db, personal.id, 1), NotFoundError);
    await assert.rejects(owner.service.documentService.linkDocuments(db, doc.id, hiddenDoc.id, "reference", owner.actor), NotFoundError);
    await owner.service.documentService.linkDocuments(db, doc.id, personal.id, "reference", owner.actor);
    const memberView = await member.service.documentService.getDocumentDetail(db, doc.id);
    assert.equal(memberView.outgoingLinks.length, 0);
    const backlinkDoc = await owner.service.documentService.createDocument(db, { projectId: project.id, title: "Backlink target", content: "Target" }, owner.actor);
    await owner.service.documentService.linkDocuments(db, personal.id, backlinkDoc.id, "reference", owner.actor);
    assert.deepEqual(await member.service.documentService.getBacklinks(db, backlinkDoc.id), []);
    const wiki = await owner.service.documentService.createDocument(db, { projectId: project.id, title: "Wiki source", content: "[[Hidden wiki target]]" }, owner.actor);
    const wikiView = await owner.service.documentService.getDocumentDetail(db, wiki.id);
    assert.equal(wikiView.outgoingLinks.length, 0);
  });
  await t.test("memories follow scope rather than creator and hide inaccessible entity links", async () => {
    const memory = await owner.service.memoryService.recordMemory(db, { projectId: project.id, title: "Shared memory", content: "Shared", entityType: "task", entityId: task.id }, owner.actor);
    const updated = await member.service.memoryService.updateMemory(db, memory.id, { content: "Member revision" }, member.actor);
    assert.equal(updated.content, "Member revision");
    await assert.rejects(viewer.service.memoryService.forgetMemory(db, memory.id, viewer.actor), AuthorizationError);
    await assert.rejects(outsider.service.memoryService.getMemory(db, memory.id), NotFoundError);
    await db.insert(memories).values({ projectId: project.id, title: "Legacy poisoned relation", content: "Hidden", createdBy: owner.actor.id, createdByType: "human", entityType: "document", entityId: hiddenDoc.id });
    const items = await member.service.memoryService.listMemories(db, { projectId: project.id, includeGlobal: false, includePersonal: false, includeExpired: false, limit: 100, offset: 0 });
    assert.deepEqual(items.map((m: any) => m.id), [memory.id]);
  });
  await t.test("REST, tRPC and GraphQL share the same resource and nested-field boundary", async () => {
    const memberCaller = await caller(member.headers);
    assert.equal((await memberCaller.task.get({ id: task.id })).id, task.id);
    const foreignCaller = await caller(outsider.headers);
    await assert.rejects(foreignCaller.task.get({ id: task.id }), (e: any) => e.code === "NOT_FOUND");
    const graph = await graphql(member.headers, `{ document(id: "${doc.id}") { id content outgoingLinks { id targetDocId targetDoc { content } } } }`);
    assert.equal(graph.status, 200, JSON.stringify(graph.body));
    assert.deepEqual(graph.body.data.document.outgoingLinks, []);
    const foreign = await graphql(outsider.headers, `{ task(id: "${task.id}") { id title } }`);
    assert.equal(foreign.body.data.task, null);
    for (const path of ["search?q=fixture", `projects/${project.id}/board`, "daemons/events", "mcp/tools"]) assert.equal((await rest(path, owner.headers)).status, 403);
  });
  await t.test("global knowledge excludes unmapped legacy rows and checks write authority", async () => {
    const shared = await admin.service.documentService.createDocument(db, { title: "Global fixture", content: "Shared knowledge" }, admin.actor);
    await db.insert(documents).values({ title: "Unmapped global fixture", content: "Quarantined", createdBy: "anonymous" });
    const list = await owner.service.documentService.listDocuments(db, { includeGlobal: true, includePersonal: false, view: "summary", page: 1, pageSize: 50 });
    assert.ok(list.items.some((row: any) => row.id === shared.id));
    assert.ok(!list.items.some((row: any) => row.title === "Unmapped global fixture"));
    await assert.rejects(owner.service.documentService.updateDocument(db, shared.id, { content: "Forbidden global write" }, owner.actor), AuthorizationError);
    const memory = await admin.service.memoryService.recordMemory(db, { title: "Global memory", content: "Shared", entityType: "document", entityId: shared.id }, admin.actor);
    const results = await owner.service.memoryService.listMemories(db, { includeGlobal: true, includePersonal: false, includeExpired: false, limit: 100, offset: 0 });
    assert.ok(results.some((row: any) => row.id === memory.id));
  });
  await t.test("invalid persisted resource relations are hidden before totals", async () => {
    const [poisoned] = await db.insert(tasks).values({ projectId: project.id, requirementId: otherRequirement.id, title: "Invalid project relation", createdBy: owner.actor.id }).returning();
    await assert.rejects(owner.service.taskService.getTask(db, poisoned.id), NotFoundError);
    const list = await owner.service.taskService.listTasks(db, { projectId: project.id, view: "summary", page: 1, pageSize: 50 });
    assert.ok(!list.items.some((row: any) => row.id === poisoned.id));
    assert.equal(list.total, 1);
    const counts = await owner.service.projectService.getProjectCounts(db, [project.id, other.id]);
    assert.equal(counts.length, 1);
    assert.equal(counts[0].taskCount, 1);
    const nested = await outsider.service.requirementService.getRequirement(db, otherRequirement.id);
    assert.ok(!nested.tasks.some((row: any) => row.id === poisoned.id));
  });
  await t.test("managed agents need explicit human personal scopes; ownership stays human", async () => {
    const agent = await runtime.identity.createAgent(owner.headers, { displayName: "Bound resource agent" });
    await runtime.identity.setMembership(owner.headers, project.id, agent.id, { role: "member" });
    const projectKey = await runtime.identity.issueKey(owner.headers, agent.id, { name: "Agent project only", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read", "resource.write"] }], expiresAt: null });
    const projectServices = createResourceServices(await runtime.verify(new Headers({ authorization: `Bearer ${projectKey.rawKey}` })));
    await assert.rejects(projectServices.documentService.getDocument(db, personal.id), NotFoundError);
    const personalKey = await runtime.identity.issueKey(owner.headers, agent.id, { name: "Explicit human personal scope", grants: [{ scope: "personal", actorId: owner.actor.id, permissions: ["resource.read", "resource.write"] }], expiresAt: null });
    const context = await runtime.verify(new Headers({ authorization: `Bearer ${personalKey.rawKey}` }));
    const services = createResourceServices(context);
    const item = await services.taskService.createPersonalTask(db, { title: "Agent-executed human task" }, { id: agent.id, type: "agent" });
    assert.equal(item.personalOwnerId, owner.actor.id);
    assert.equal(item.personalOwnerType, "human");
    assert.equal(item.createdBy, agent.id);
    const graph = await graphql(owner.headers, `{ task(id: "${item.id}") { id scope personalOwnerId projectId requirementId project { id } requirement { id } } }`);
    assert.equal(graph.body.data.task.personalOwnerId, owner.actor.id);
    assert.equal(graph.body.data.task.project, null);
    await runtime.identity.revokeKey(owner.headers, agent.id, personalKey.id);
    await assert.rejects(services.taskService.getTask(db, item.id), (error: any) => error.code === "credential_revoked");
  });
  await t.test("document moves and unlinks validate destination and owning path", async () => {
    await assert.rejects(owner.service.documentService.updateDocument(db, personal.id, { projectId: other.id, personalOwnerId: null, personalOwnerType: null }, owner.actor), AuthorizationError);
    const link = await owner.service.documentService.linkDocuments(db, personal.id, doc.id, "reference", owner.actor);
    assert.equal((await rest(`documents/${doc.id}/links/${link.id}`, owner.headers, "DELETE")).status, 404);
    const [stored] = await db.select().from(documentLinks).where(eq(documentLinks.id, link.id));
    assert.equal(stored.id, link.id);
    assert.equal((await rest(`documents/${personal.id}/links/${link.id}`, owner.headers, "DELETE")).status, 200);
    const moved = await owner.service.documentService.updateDocument(db, personal.id, { projectId: project.id, personalOwnerId: null, personalOwnerType: null }, owner.actor);
    assert.equal(moved.projectId, project.id);
    assert.equal((await member.service.documentService.getDocumentVersion(db, personal.id, 1)).content, "Private content");
    // Scope rollback for subsequent personal ownership checks, with both scopes authorized.
    await owner.service.documentService.updateDocument(db, personal.id, { projectId: null, personalOwnerId: owner.actor.id, personalOwnerType: "human" }, owner.actor);
  });
  await t.test("scoped keys cannot escape their project and cached contexts lose live membership", async () => {
    const key = await runtime.identity.issueKey(member.headers, member.actor.id, { name: "Read project fixture", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read"] }], expiresAt: null });
    const headers = new Headers({ authorization: `Bearer ${key.rawKey}` });
    const services = createResourceServices(await runtime.verify(headers));
    assert.equal((await services.taskService.getTask(db, task.id)).id, task.id);
    await assert.rejects(services.taskService.updateTask(db, task.id, { title: "Forbidden" }, member.actor), AuthorizationError);
    assert.equal((await rest(`documents/${doc.id}`, headers)).status, 200);
    await runtime.identity.removeMembership(owner.headers, project.id, member.actor.id);
    await assert.rejects(services.taskService.getTask(db, task.id), AuthorizationError);
    assert.equal((await rest(`tasks/${task.id}`, headers)).status, 403);
  });
  await t.test("archive cannot promote documents into shared global scope", async () => {
    await outsider.service.documentService.createDocument(db, { projectId: other.id, title: "Archive content", content: "Private project" }, outsider.actor);
    await outsider.service.projectService.deleteProject(db, other.id, outsider.actor);
    const [stored] = await db.select().from(documents).where(eq(documents.projectId, other.id));
    assert.equal(stored.projectId, other.id);
    await assert.rejects(outsider.service.documentService.getDocument(db, stored.id), NotFoundError);
    const globals = await admin.service.documentService.listDocuments(db, { includeGlobal: true, includePersonal: false });
    assert.ok(!globals.some((row: any) => row.id === stored.id));
  });
});
