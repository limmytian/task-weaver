import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
import { createTRPCContextFactory } from "../apps/web/trpc/init";
import { appRouter } from "../apps/web/trpc/routers/_app";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, documents, skillPackages, skillPackageFiles, embeddingProfiles, embeddingGenerations, embeddingJobItems } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, NotFoundError, AuthorizationError, skillPackageStorageService, registerSkillPackageSchema, listSkillPackagesSchema, createEmbeddingProfileSchema } = apiRequire("@task-weaver/core");
const { eq } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("asset authorization protects skill storage and embedding configuration", { skip: !databaseUrl, timeout: 150_000 }, async t => {
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

  const storageDir = await mkdtemp(join(tmpdir(), "tw-asset-e2e-"));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const storage = new skillPackageStorageService.LocalSkillPackageStorageAdapter(storageDir);
  const packageInput = (scope: any, name = "Package needle") => registerSkillPackageSchema.parse({
    ...scope, name, files: [{ path: "SKILL.md", contentBase64: Buffer.from("# Package needle\nPrivate package content").toString("base64") }],
  });
  const pkg = await owner.service.skillPackageService.registerPackage(db, packageInput({ projectId: project.id }), owner.actor, storage);
  const privatePkg = await outsider.service.skillPackageService.registerPackage(db, packageInput({ personalOwnerId: outsider.actor.id, personalOwnerType: "human" }), outsider.actor, storage);
  const pkgId = pkg.id;
  const privateId = privatePkg.id;
  let profile: any, generation: any, job: any;

  await t.test("package metadata, files, storage reads and mutation require live scope rights", async () => {
    const found = await viewer.service.skillPackageService.getPackage(db, pkgId);
    assert.equal(found.id, pkgId);
    assert.ok(!JSON.stringify(found).includes("objectKey"));
    const listed = await owner.service.skillPackageService.listPackages(db, listSkillPackagesSchema.parse({ allProjects: true, includeGlobal: false, limit: 1 }));
    assert.equal(listed.items[0].id, pkgId);
    const text = await viewer.service.skillPackageService.readPackageTextFile(db, { packageId: pkgId, path: "SKILL.md" }, storage);
    assert.ok(JSON.stringify(text).includes("Private package content"));
    await assert.rejects(admin.service.skillPackageService.getPackage(db, pkgId), NotFoundError);
    const globalPkg = await admin.service.skillPackageService.registerPackage(db, packageInput({}, "Shared fixture"), admin.actor, storage);
    assert.equal((await outsider.service.skillPackageService.getPackage(db, globalPkg.id)).id, globalPkg.id);
    await assert.rejects(owner.service.skillPackageService.updatePackageMetadata(db, { packageId: globalPkg.id, status: "archived" }, owner.actor), AuthorizationError);

    await assert.rejects(owner.service.skillPackageService.getPackage(db, privateId), NotFoundError);
    await assert.rejects(owner.service.skillPackageService.downloadPackage(db, { packageId: privateId }, storage), NotFoundError);
    await assert.rejects(viewer.service.skillPackageService.updatePackageMetadata(db, { packageId: pkgId, status: "archived" }, viewer.actor), AuthorizationError);
    const health = await owner.service.skillPackageService.verifyPackageStorage(db, { packageId: pkgId }, storage);
    assert.equal(health.failed, 0);
    const skills = await owner.service.contextService.searchContext(db, { intent: "needle", projectId: project.id, includeGlobal: false, limit: 1, mode: "summary" });
    assert.equal(skills.length, 1); assert.equal(skills[0].skillPackage.packageId, pkgId);
    await owner.service.skillPackageService.updatePackageVersionStatus(db, { packageId: pkgId, version: "1.0.0", status: "archived" }, owner.actor);
    assert.equal((await owner.service.contextService.searchContext(db, { intent: "needle", projectId: project.id, includeGlobal: false, limit: 1, mode: "summary" })).length, 0);
    await owner.service.skillPackageService.updatePackageVersionStatus(db, { packageId: pkgId, version: "1.0.0", status: "active" }, owner.actor);
  });

  await t.test("forged indexed documents and storage relationships quarantine packages", async () => {
    const file = (await db.select().from(skillPackageFiles).where(eq(skillPackageFiles.packageVersionId, pkg.versions[0].id)))[0];
    await db.update(skillPackageFiles).set({ storageObjectId: privatePkg.versions[0].files[0].storageObjectId }).where(eq(skillPackageFiles.id, file.id));
    await assert.rejects(owner.service.skillPackageService.downloadPackage(db, { packageId: pkgId }, storage), NotFoundError);
    await assert.rejects(owner.service.skillPackageService.reindexPackageTextFiles(db, { packageId: pkgId }, owner.actor, storage), NotFoundError);
    await db.update(skillPackageFiles).set({ storageObjectId: file.storageObjectId }).where(eq(skillPackageFiles.id, file.id));
    await db.update(skillPackageFiles).set({ indexedDocumentId: hiddenDoc.id }).where(eq(skillPackageFiles.id, file.id));
    await assert.rejects(owner.service.skillPackageService.getPackage(db, pkgId), NotFoundError);
    await assert.rejects(owner.service.skillPackageService.reindexPackageTextFiles(db, { packageId: pkgId }, owner.actor, storage), NotFoundError);
    assert.equal((await owner.service.skillPackageService.listPackages(db, listSkillPackagesSchema.parse({ projectId: project.id, includeGlobal: false }))).items.length, 0);
    await db.update(skillPackageFiles).set({ indexedDocumentId: file.indexedDocumentId }).where(eq(skillPackageFiles.id, file.id));
    await db.update(skillPackages).set({ primaryDocumentId: hiddenDoc.id }).where(eq(skillPackages.id, pkgId));
    await assert.rejects(owner.service.skillPackageService.getPackage(db, pkgId), NotFoundError);
    await db.update(skillPackages).set({ primaryDocumentId: pkg.primaryDocumentId }).where(eq(skillPackages.id, pkgId));
  });

  await t.test("provider configuration needs administrator AND explicit resource management grants", async () => {
    const input = createEmbeddingProfileSchema.parse({ name: "Provider boundary", scope: "project", projectId: project.id, baseUrl: "http://127.0.0.1:1/v1", model: "fixture", dimensions: 2, secretRef: "env:FIXTURE_ONLY" });
    await assert.rejects(owner.service.embeddingService.createEmbeddingProfile(db, input, owner.actor), AuthorizationError);
    await assert.rejects(admin.service.embeddingService.createEmbeddingProfile(db, input, admin.actor), AuthorizationError);
    await runtime.identity.setMembership(owner.headers, project.id, admin.actor.id, { role: "maintainer" });
    profile = await admin.service.embeddingService.createEmbeddingProfile(db, input, admin.actor);
    const read = await viewer.service.embeddingService.getEmbeddingProfile(db, profile.id);
    assert.equal(read.secretRef, ""); assert.equal(read.baseUrl, "");
    assert.equal((await admin.service.embeddingService.getEmbeddingProfile(db, profile.id)).secretRef, "env:FIXTURE_ONLY");
    await assert.rejects(owner.service.embeddingService.testEmbeddingProfile(db, profile.id), AuthorizationError);
    await assert.rejects(owner.service.embeddingService.updateEmbeddingProfile(db, profile.id, { baseUrl: "http://127.0.0.1:2/v1" }, owner.actor), AuthorizationError);
    await assert.rejects(owner.service.embeddingService.setEmbeddingProfileStatus(db, profile.id, "enabled", owner.actor), AuthorizationError);
    await assert.rejects(member.service.embeddingService.startEmbeddingRebuild(db, profile.id, "full", member.actor), AuthorizationError);
    job = await owner.service.embeddingService.startEmbeddingRebuild(db, profile.id, "full", owner.actor);
    generation = (await owner.service.embeddingService.listEmbeddingGenerations(db, profile.id))[0];
    assert.ok(job.id); assert.equal(generation.baseUrl, "");
    await assert.rejects(outsider.service.embeddingService.getEmbeddingJob(db, job.id), NotFoundError);
    await owner.service.embeddingService.requestEmbeddingJobCancellation(db, job.id, owner.actor.id);
    await assert.rejects(owner.service.embeddingService.processEmbeddingJob(db, job.id, {}), AuthorizationError);
  });

  await t.test("job/generation foreign pointers are rejected before counts or mutation", async () => {
    await db.insert(embeddingJobItems).values({ jobId: job.id, documentId: hiddenDoc.id, action: "upsert", documentVersion: 1 });
    await assert.rejects(owner.service.embeddingService.getEmbeddingJob(db, job.id), NotFoundError);
    await assert.rejects(owner.service.embeddingService.getEmbeddingUsage(db, profile.id), NotFoundError);
    assert.ok(!(await owner.service.embeddingService.listEmbeddingProfiles(db)).some((p: any) => p.id === profile.id));
    await db.delete(embeddingJobItems).where(eq(embeddingJobItems.documentId, hiddenDoc.id));
    const [foreignProfile] = await db.insert(embeddingProfiles).values({ ...profile, id: randomUUID(), name: "Foreign pointer", scope: "personal", projectId: null, personalOwnerId: outsider.actor.id, personalOwnerType: "human", createdBy: outsider.actor.id, updatedBy: outsider.actor.id }).returning();
    await assert.rejects(db.update(embeddingGenerations).set({ profileId: foreignProfile.id }).where(eq(embeddingGenerations.id, generation.id)));
    const [foreignGeneration] = await db.insert(embeddingGenerations).values({ ...generation, id: randomUUID(), profileId: foreignProfile.id }).returning();
    await assert.rejects(owner.service.embeddingService.markEmbeddingGenerationActive(db, foreignGeneration.id, owner.actor), NotFoundError);
    await assert.rejects(db.update(embeddingProfiles).set({ activeGenerationId: foreignGeneration.id }).where(eq(embeddingProfiles.id, profile.id)));
    assert.equal((await owner.service.embeddingService.getEmbeddingProfile(db, profile.id)).id, profile.id);
  });

  await t.test("REST and tRPC use the same asset policy and scoped keys cannot invoke provider validation", async () => {
    assert.equal((await rest(`context/packages/${pkgId}`, viewer.headers)).status, 200);
    assert.equal((await rest(`context/packages/${privateId}`, owner.headers)).status, 404);
    assert.equal((await rest(`embeddings/profiles/${profile.id}/test`, owner.headers, "POST")).status, 403);
    assert.equal((await rest(`embeddings/jobs/${job.id}`, outsider.headers)).status, 404);
    const web = await caller(viewer.headers);
    assert.equal((await web.skill.packageGet({ packageId: pkgId })).id, pkgId);
    await assert.rejects(web.embedding.test({ id: profile.id }));
    const key = await runtime.identity.issueKey(admin.headers, admin.actor.id, { name: "Project only provider key", grants: [{ scope: "project", projectId: project.id, permissions: ["resource.read", "project.manage"] }], expiresAt: null });
    const headers = new Headers({ authorization: `Bearer ${key.rawKey}` });
    assert.equal((await rest(`embeddings/profiles/${profile.id}/test`, headers, "POST")).status, 403);
    const scoped = createResourceServices(await runtime.verify(headers));
    await assert.rejects(scoped.skillPackageService.updatePackageMetadata(db, { packageId: pkgId, status: "archived" }, admin.actor), AuthorizationError);

    assert.equal((await scoped.embeddingService.getEmbeddingProfile(db, profile.id)).secretRef, "");
    await assert.rejects(scoped.embeddingService.testEmbeddingProfile(db, profile.id), AuthorizationError);
    await runtime.identity.removeMembership(owner.headers, project.id, viewer.actor.id);
    await assert.rejects(viewer.service.skillPackageService.getPackage(db, pkgId), NotFoundError);
    await assert.rejects(viewer.service.embeddingService.getEmbeddingProfile(db, profile.id), NotFoundError);
  });
});
