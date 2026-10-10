import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
import { createTRPCContextFactory } from "../apps/web/trpc/init";
import { appRouter } from "../apps/web/trpc/routers/_app";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, authRateLimits, repositories, requirementRepositories, taskRepositories } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, NotFoundError, AuthorizationError, listRepositoriesSchema, createRepositorySchema } = apiRequire("@task-weaver/core");
const { eq, like } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("repository catalog separates visibility, relations and readiness", { skip: !databaseUrl, timeout: 150_000 }, async t => {
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
  async function rest(path: string, headers: Headers, method = "GET", body?: unknown) {
    const response = await api.request(`/api/v1/${path}`, { headers: new Headers([...headers, ["content-type", "application/json"]]), method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  async function caller(headers: Headers) {
    return appRouter.createCaller(await createTRPCContextFactory({ db, auth: runtime })({ req: new Request(`${config.trustedOrigins[0]}/api/trpc`, { headers, method: "POST" }) }));
  }

  async function fixture(visibility: string, identity: typeof owner) {
    const name = randomUUID();
    const [row] = await db.insert(repositories).values({
      displayName: name, host: "example.test", namespace: "fixture", name, canonicalKey: "example.test/fixture/" + name,
      visibility, ownerId: visibility === "instance" ? null : identity.actor.id,
      ownerType: visibility === "instance" ? null : "human", createdBy: identity.actor.id,
      httpsCloneUrl: "https://example.test/fixture/" + name + ".git", authPolicy: { credentialProfileRef: "fixture-only-reference", revision: 1 },
    }).returning();
    return row;
  }
  const shared = await fixture("instance", admin);
  const privateRepo = await fixture("private", owner);
  const hidden = await fixture("private", outsider);
  await db.insert(requirementRepositories).values([{ requirementId: requirement.id, repositoryId: shared.id }, { requirementId: otherRequirement.id, repositoryId: shared.id }]);
  await db.insert(taskRepositories).values({ taskId: task.id, repositoryId: shared.id, createdBy: owner.actor.id });
  await t.test("catalog reads intersect credential grants and nested project rights", async () => {
    const detail = await owner.service.repositoryService.getRepository(db, shared.id, owner.actor);
    assert.ok(!JSON.stringify(detail).includes("fixture-only-reference"));
    assert.equal(detail.requirements.length, 1); assert.equal(detail.requirements[0].requirement.id, requirement.id);
    assert.equal(detail.tasks.length, 1);
    const adminDetail = await admin.service.repositoryService.getRepository(db, shared.id, admin.actor);
    assert.equal(adminDetail.requirements.length, 0); assert.equal(adminDetail.tasks.length, 0);
    await assert.rejects(admin.service.repositoryService.getRepository(db, privateRepo.id, admin.actor), NotFoundError);
    await assert.rejects(owner.service.repositoryService.getRepository(db, hidden.id, owner.actor), NotFoundError);
    const input = listRepositoriesSchema.parse({ page: 1, pageSize: 50 });
    const listed = await owner.service.repositoryService.listRepositories(db, input, owner.actor);
    assert.ok(!listed.items.some((row: any) => row.id === hidden.id));
    assert.equal(listed.items.find((row: any) => row.id === shared.id).usageCount, 1);
    const key = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Project-only catalog", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read"] }], expiresAt: null });
    const context = await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` }));
    assert.equal((await createResourceServices(context).repositoryService.listRepositories(db, input, owner.actor)).total, 0);
  });
  await t.test("migrated personal ownership survives legacy creator attribution without opening other catalogs", async () => {
    const legacy = await fixture("private", owner);
    const foreign = await fixture("private", outsider);
    const unowned = await fixture("instance", admin);
    const attribution = "apikey:" + randomUUID();
    for (const row of [legacy, foreign, unowned]) await db.update(repositories).set({ createdBy: attribution }).where(eq(repositories.id, row.id));
    const listed = await owner.service.repositoryService.listRepositories(db, listRepositoriesSchema.parse({ pageSize: 100 }), owner.actor);
    assert.ok(listed.items.some((row: any) => row.id === legacy.id));
    assert.ok(!listed.items.some((row: any) => row.id === foreign.id || row.id === unowned.id));
    assert.equal((await rest(`repositories/${legacy.id}`, owner.headers)).status, 200);
    assert.equal((await (await caller(owner.headers)).repository.get({ id: legacy.id, operation: "read" })).id, legacy.id);
    await owner.service.repositoryService.updateRepository(db, legacy.id, { displayName: "Recovered owned catalog" }, owner.actor);
    await assert.rejects(outsider.service.repositoryService.getRepository(db, legacy.id, outsider.actor), NotFoundError);
    await assert.rejects(admin.service.repositoryService.getRepository(db, legacy.id, admin.actor), NotFoundError);
    const key = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Legacy catalog project-only", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read"] }], expiresAt: null });
    const service = createResourceServices(await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` })));
    await assert.rejects(service.repositoryService.getRepository(db, legacy.id, owner.actor), NotFoundError);
  });
  await t.test("REST and tRPC share the catalog scope and deny unauthorized mutations", async () => {
    assert.equal((await rest(`repositories/${hidden.id}`, owner.headers)).status, 404);
    const response = await rest(`repositories/${shared.id}`, admin.headers);
    assert.equal(response.status, 200); assert.equal(response.body.requirements.length, 0);
    assert.ok(!JSON.stringify(response.body).includes("fixture-only-reference"));
    const web = await caller(owner.headers);
    assert.equal((await web.repository.get({ id: shared.id, operation: "read" })).requirements.length, 1);
    await assert.rejects(web.repository.update({ id: shared.id, data: { displayName: "forged" } }));
    assert.equal((await rest(`repositories/${shared.id}`, owner.headers, "PATCH", { displayName: "forged" })).status, 403);
  });
  await t.test("link traversal and readiness cannot act as content or write oracles", async () => {
    await assert.rejects(outsider.service.repositoryService.listTaskRepositories(db, task.id, outsider.actor), NotFoundError);
    const links = await owner.service.repositoryService.listRequirementRepositories(db, requirement.id, owner.actor);
    assert.equal(links.length, 1);
    const readiness = await owner.service.repositoryService.getRepositoryReadiness(db, shared.id, owner.actor, { operation: "push", nodeId: "untrusted-node" });
    assert.equal(readiness.state, "needs_configuration"); assert.equal(readiness.actorId, owner.actor.id);
    assert.ok(!JSON.stringify(readiness).includes("fixture-only-reference"));
    await assert.rejects(viewer.service.repositoryService.updateRepository(db, shared.id, { displayName: "forged" }, viewer.actor), AuthorizationError);
    await assert.rejects(owner.service.repositoryService.getRepositoryReadiness(db, hidden.id, owner.actor, { operation: "read", nodeId: "forged-node" }), NotFoundError);
  });
  const input = (visibility: string, ownerId?: string) => createRepositorySchema.parse({ host: "example.test", namespace: "fixture", name: randomUUID(), visibility, ...(ownerId ? { ownerId, ownerType: "human" } : {}) });
  await t.test("shared catalog requires administrator and explicit Key management grants", async () => {
    await assert.rejects(owner.service.repositoryService.createRepository(db, input("instance"), owner.actor), AuthorizationError);
    const row = await admin.service.repositoryService.createRepository(db, input("instance"), admin.actor);
    assert.equal((await rest(`repositories/${row.id}`, admin.headers, "PATCH", { displayName: "Updated shared" })).status, 200);
    const key = await runtime.identity.issueKey(admin.headers, admin.actor.id, { name: "Catalog read-only", grants: [{ scope: "global", permissions: ["resource.read"] }], expiresAt: null });
    const context = await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` }));
    await assert.rejects(createResourceServices(context).repositoryService.updateRepository(db, row.id, { displayName: "Denied" }, admin.actor), AuthorizationError);
    assert.equal((await rest(`repositories/${row.id}`, admin.headers, "DELETE")).status, 200);
  });
  await t.test("personal management keeps ownership human and denies administrator content access", async () => {
    const row = await owner.service.repositoryService.createRepository(db, input("private", owner.actor.id), owner.actor);
    assert.equal(row.ownerId, owner.actor.id);
    await assert.rejects(admin.service.repositoryService.archiveRepository(db, row.id, admin.actor), NotFoundError);
    await assert.rejects(owner.service.repositoryService.updateRepository(db, row.id, { visibility: "instance", ownerId: null, ownerType: null }, owner.actor), AuthorizationError);
    await assert.rejects(owner.service.repositoryService.updateRepository(db, row.id, { ownerId: outsider.actor.id }, owner.actor), AuthorizationError);
    await assert.rejects(owner.service.repositoryService.updateRepository(db, row.id, { ownerType: "agent" }, owner.actor));
    const key = await runtime.identity.issueKey(owner.headers, owner.actor.id, { name: "Personal ordinary write", grants: [{ scope: "personal", actorId: owner.actor.id, permissions: ["resource.read", "resource.write"] }], expiresAt: null });
    const service = createResourceServices(await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` })));
    await assert.rejects(service.repositoryService.updateRepository(db, row.id, { displayName: "Denied" }, owner.actor), AuthorizationError);
    assert.equal((await (await caller(owner.headers)).repository.update({ id: row.id, data: { displayName: "Owner update" } })).displayName, "Owner update");
    await owner.service.repositoryService.archiveRepository(db, row.id, owner.actor);
  });
  await t.test("project management links both authorized resources without editing the catalog", async () => {
    const row = await admin.service.repositoryService.createRepository(db, input("instance"), admin.actor);
    await runtime.identity.setMembership(owner.headers, project.id, member.actor.id, { role: "maintainer" });
    await member.service.repositoryService.addRequirementRepository(db, requirement.id, { repositoryId: row.id }, member.actor);
    await member.service.repositoryService.addTaskRepository(db, task.id, { repositoryId: row.id, addToRequirement: false }, member.actor);
    await assert.rejects(member.service.repositoryService.updateRepository(db, row.id, { authPolicy: {} }, member.actor), AuthorizationError);
    await assert.rejects(member.service.repositoryService.addRequirementRepository(db, otherRequirement.id, { repositoryId: row.id }, member.actor), NotFoundError);
    await assert.rejects(member.service.repositoryService.addRequirementRepository(db, requirement.id, { repositoryId: hidden.id }, member.actor), NotFoundError);
    await assert.rejects(viewer.service.repositoryService.removeTaskRepository(db, task.id, row.id, viewer.actor), AuthorizationError);
    await member.service.repositoryService.removeTaskRepository(db, task.id, row.id, member.actor);
    await member.service.repositoryService.removeRequirementRepository(db, requirement.id, row.id, member.actor);
  });
  await t.test("Agent management needs an explicit personal grant and attributes the Agent separately", async () => {
    const agent = await runtime.identity.createAgent(owner.headers, { displayName: "Repository fixture Agent" });
    async function credential(permissions: string[]) {
      const key = await runtime.identity.issueKey(owner.headers, agent.id, { name: "Agent personal catalog", grants: [{ scope: "personal", actorId: owner.actor.id, permissions }], expiresAt: null });
      return { key, service: createResourceServices(await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` }))) };
    }
    const actor = { id: agent.id, type: "agent" };
    const limited = await credential(["resource.read", "resource.write"]);
    await assert.rejects(limited.service.repositoryService.createRepository(db, input("private", owner.actor.id), actor), AuthorizationError);
    const granted = await credential(["resource.read", "repository.manage"]);
    const row = await granted.service.repositoryService.createRepository(db, input("private", owner.actor.id), actor);
    assert.equal(row.ownerId, owner.actor.id); assert.equal(row.ownerType, "human"); assert.equal(row.createdBy, agent.id);
    await granted.service.repositoryService.updateRepository(db, row.id, { displayName: "Agent update" }, actor);
    await runtime.identity.revokeKey(owner.headers, agent.id, granted.key.id);
    await assert.rejects(granted.service.repositoryService.archiveRepository(db, row.id, actor));
  });
  await t.test("nested links exclude foreign catalogs and invalid task workspace pointers", async () => {
    await db.insert(taskRepositories).values({ taskId: task.id, repositoryId: hidden.id, createdBy: outsider.actor.id });
    const detail = await owner.service.taskService.getTaskDetail(db, task.id);
    assert.ok(detail.repositories.some((link: any) => link.repositoryId === shared.id));
    assert.ok(!detail.repositories.some((link: any) => link.repositoryId === hidden.id));
    assert.ok(!JSON.stringify(detail).includes("fixture-only-reference"));
    const row = await admin.service.repositoryService.createRepository(db, input("instance"), admin.actor);
    await db.insert(taskRepositories).values({ taskId: task.id, repositoryId: row.id, createdBy: owner.actor.id });
    assert.ok(!(await owner.service.repositoryService.listTaskRepositories(db, task.id, owner.actor)).some((link: any) => link.repository.id === row.id));
  });

});
