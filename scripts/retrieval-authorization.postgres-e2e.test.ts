import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
import { createTRPCContextFactory } from "../apps/web/trpc/init";
import { appRouter } from "../apps/web/trpc/routers/_app";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, documents, memories, tasks, documentLinks, taskDependencies, embeddingProfiles, embeddingGenerations, embeddingDocumentChunks, documentEmbeddings, documentEmbeddingStates } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, NotFoundError, AuthorizationError, ValidationError } = apiRequire("@task-weaver/core");
const { eq } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("retrieval authorization filters before ranking, aggregates and relation expansion", { skip: !databaseUrl, timeout: 150_000 }, async t => {
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

  await t.test("keyword/fulltext/title resolution exclude hidden resources before limits", async () => {
    await owner.service.documentService.updateDocument(db, doc.id, { content: "Retrieval needle", docType: "skill" }, owner.actor);
    await outsider.service.documentService.updateDocument(db, hiddenDoc.id, { title: "Retrieval needle", content: "Secret needle", docType: "skill" }, outsider.actor);
    for (const mode of ["keyword", "fulltext", "hybrid"]) {
      const result = await owner.service.documentService.searchDocumentsWithMetadata(db, { query: "needle", projectId: project.id, mode, includeGlobal: false, limit: 1 });
      assert.equal(result.items[0].id, doc.id);
      assert.ok(!JSON.stringify(result).includes(hiddenDoc.id));
    }
    const resolved = await owner.service.documentService.resolveDocumentTitles(db, ["Retrieval needle", "Private note"]);
    assert.ok(!resolved.some((row: any) => row.id === hiddenDoc.id));
    assert.equal(await member.service.documentService.getDocumentByTitle(db, "Private note"), undefined);
    await assert.rejects(outsider.service.documentService.searchDocuments(db, { query: "needle", projectId: project.id, limit: 1 }), NotFoundError);
    await assert.rejects(owner.service.documentService.searchDocuments(db, { query: "needle", includePersonal: true, personalOwnerId: outsider.actor.id, personalOwnerType: "human", limit: 1 }), AuthorizationError);
  });
  await t.test("task/requirement/memory discovery honors project and entity access", async () => {
    const foreignTask = await outsider.service.taskService.createTask(db, { projectId: other.id, requirementId: otherRequirement.id, title: "Task foreign" }, outsider.actor);
    const list = await owner.service.taskService.searchTasks(db, { query: "Task", scope: "project", limit: 1 });
    assert.deepEqual(list.map((row: any) => row.id), [task.id]);
    const requirements = await owner.service.requirementService.searchRequirements(db, { query: "Work", limit: 10 });
    assert.deepEqual(requirements.map((row: any) => row.id), [requirement.id]);
    await db.insert(memories).values({ title: "needle memory", content: "hidden relationship", projectId: project.id, entityId: foreignTask.id, entityType: "task", createdBy: owner.actor.id, createdByType: "human" });
    const memory = await owner.service.memoryService.recordMemory(db, { title: "needle memory", content: "Visible", projectId: project.id, entityType: "task", entityId: task.id, expiresAt: new Date(Date.now() + 60000) }, owner.actor);
    const found = await member.service.memoryService.searchMemories(db, { query: "needle", projectId: project.id, includeGlobal: false, includeExpired: false, limit: 1 });
    assert.deepEqual(found.map((row: any) => row.id), [memory.id]);
    assert.equal((await owner.service.memoryService.getMemory(db, memory.id)).expiresAt.getTime(), memory.expiresAt.getTime());
  });
  await t.test("graphs, boards and statistics use scoped nodes and both visible endpoints", async () => {
    await db.insert(tasks).values({ projectId: project.id, requirementId: otherRequirement.id, title: "Poisoned relation", createdBy: owner.actor.id });
    const external = await outsider.service.taskService.createTask(db, { projectId: other.id, requirementId: otherRequirement.id, title: "External task" }, outsider.actor);
    await db.insert(taskDependencies).values({ taskId: task.id, dependsOnTaskId: external.id, type: "blocks" });
    await owner.service.documentService.linkDocuments(db, doc.id, personal.id, "reference", owner.actor);
    const graph = await member.service.projectService.getKnowledgeGraph(db, project.id);
    assert.ok(!graph.edges.some((edge: any) => edge.target === personal.id || edge.source === personal.id));
    assert.ok(!graph.nodes.some((node: any) => node.label === "Poisoned relation"));
    const dependency = await member.service.taskService.getRequirementTaskDependencyGraph(db, requirement.id);
    assert.ok(!JSON.stringify(dependency).includes(external.id));
    const gantt = await member.service.taskService.getGanttChart(db, project.id);
    assert.equal(gantt.tasks.length, 1);
    assert.deepEqual(gantt.tasks[0].dependencies, []);
    const board = await member.service.taskService.getKanbanBoard(db, project.id);
    assert.equal(board.columns.reduce((total: number, column: any) => total + column.count, 0), 1);
    const stats = await member.service.projectService.getProjectStats(db, project.id);
    assert.equal(stats.totalTasks, 1);
    assert.equal(stats.blockedTasks, 0);
    assert.equal((await member.service.projectService.getProjectHealthDashboard(db, project.id)).documentCount, 1);
    assert.equal((await member.service.requirementService.getRequirementBurndown(db, requirement.id)).totalTasks, 1);
    assert.equal((await member.service.requirementService.getRequirementHeatmap(db, project.id)).requirements.length, 1);
    await assert.rejects(admin.service.projectService.getProjectStats(db, project.id), NotFoundError);
  });
  await t.test("recommendations and skill context never expand private linked content", async () => {
    const result = await member.service.recommendationService.getDocumentRecommendations(db, doc.id, { threshold: 0, limit: 20 });
    assert.ok(!result.recommendations.some((row: any) => row.id === personal.id || row.id === hiddenDoc.id));
    const skills = await member.service.contextService.searchContext(db, { intent: "needle", projectId: project.id, mode: "full", includeGlobal: false, limit: 1 });
    assert.deepEqual(skills.map((row: any) => row.id), [doc.id]);
    const listing = await owner.service.contextService.listSkills(db, { allProjects: true, includeGlobal: false });
    assert.ok(!listing.some((row: any) => row.id === hiddenDoc.id));
  });
  await t.test("REST, tRPC and GraphQL expose retrieval through identical live rules", async () => {
    assert.equal((await rest(`search/documents?query=needle&projectId=${project.id}`, member.headers)).status, 200);
    assert.equal((await rest(`projects/${project.id}/stats`, admin.headers)).status, 404);
    const transport = await caller(member.headers);
    assert.equal((await transport.search.all({ query: "needle", projectId: project.id, limit: 1 })).documents[0].id, doc.id);
    const graph = await graphql(member.headers, `{ project(id: "${project.id}") { stats { totalTasks byStatus { status count } requirementProgress { id title totalTasks } } } document(id: "${doc.id}") { recommendations { id title type } } searchDocuments(query: "needle", projectId: "${project.id}") { id title } }`);
    assert.ok(!graph.body.errors, JSON.stringify(graph.body));
    assert.equal(graph.body.data.project.stats.totalTasks, 1);
    assert.equal(graph.body.data.searchDocuments[0].id, doc.id);
    assert.equal((await rest("search/repositories?q=fixture", owner.headers)).status, 200);
    assert.equal((await rest("daemons/events", owner.headers)).status, 404);
  });
  await t.test("semantic candidates exclude invisible vectors before the candidate limit", async () => {
    process.env.TW_RETRIEVAL_FIXTURE_SECRET = "fixture-only";
    let requests = 0;
    const server = createServer(async (request, response) => {
      requests++;
      for await (const chunk of request) { void chunk; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }], model: "fixture" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { delete process.env.TW_RETRIEVAL_FIXTURE_SECRET; await new Promise<void>(resolve => server.close(() => resolve())); });
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    const [profile] = await db.insert(embeddingProfiles).values({ name: "Visible retrieval", scope: "project", projectId: project.id, status: "enabled", baseUrl, model: "fixture", dimensions: 2, secretRef: "env:TW_RETRIEVAL_FIXTURE_SECRET", configurationHash: "fixture", createdBy: owner.actor.id, createdByType: "human", updatedBy: owner.actor.id, updatedByType: "human" }).returning();
    const [generation] = await db.insert(embeddingGenerations).values({ profileId: profile.id, generationNumber: 1, status: "active", provider: "openai_compatible", baseUrl, model: "fixture", dimensions: 2, chunkSize: 1200, chunkOverlap: 120, chunkingVersion: "text-v1", configurationHash: "fixture", createdBy: owner.actor.id, createdByType: "human" }).returning();
    await db.update(embeddingProfiles).set({ activeGenerationId: generation.id }).where(eq(embeddingProfiles.id, profile.id));
    for (const [item, count] of [[doc, 1], [hiddenDoc, 20]] as const) {
      await db.insert(documentEmbeddingStates).values({ profileId: profile.id, generationId: generation.id, documentId: item.id, documentVersion: 1, state: "complete", contentHash: "fixture" });
      for (let index = 0; index < count; index++) {
        const [chunk] = await db.insert(embeddingDocumentChunks).values({ generationId: generation.id, documentId: item.id, documentVersion: 1, chunkIndex: index, content: "needle", contentHash: "fixture", characterStart: 0, characterEnd: 6, scope: "project", projectId: project.id }).returning();
        await db.insert(documentEmbeddings).values({ generationId: generation.id, chunkId: chunk.id, embedding: item.id === doc.id ? [0.9, 0.1] : [1, 0], dimensions: 2, contentHash: "fixture" });
      }
    }
    const result = await member.service.documentService.searchDocumentsWithMetadata(db, { query: "needle", projectId: project.id, includeGlobal: false, mode: "semantic", limit: 1 });
    assert.equal(result.metadata.effectiveMode, "semantic", JSON.stringify(result));
    assert.deepEqual(result.items.map((row: any) => row.id), [doc.id]);
    assert.equal(result.metadata.coverage.totalDocuments, 1);
    assert.equal(requests, 1);
    const outsiderResults = await outsider.service.documentService.searchDocumentsWithMetadata(db, { query: "needle", includeGlobal: true, mode: "semantic", limit: 1 });
    assert.notEqual(outsiderResults.metadata.profileId, profile.id);
    assert.equal(requests, 1);
  });
  await t.test("read-only keys and revoked cached contexts cannot broaden retrieval", async () => {
    const key = await runtime.identity.issueKey(member.headers, member.actor.id, { name: "Retrieval read", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read"] }], expiresAt: null });
    const services = createResourceServices(await runtime.verify(new Headers({ authorization: `Bearer ${key.rawKey}` })));
    assert.equal((await services.taskService.searchTasks(db, { query: "Task", scope: "project", limit: 10 })).length, 1);
    await runtime.identity.removeMembership(owner.headers, project.id, member.actor.id);
    await assert.rejects(services.taskService.searchTasks(db, { query: "Task", scope: "project", limit: 10 }), AuthorizationError);
    await assert.rejects(member.service.contextService.listSkills(db, { projectId: project.id }), NotFoundError);
  });
});
