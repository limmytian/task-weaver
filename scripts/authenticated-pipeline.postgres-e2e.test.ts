import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb, runMigrations, authInstanceState, authSessions, authActors, authRateLimits, daemons, daemonWorkerProgress, apiKeys, requirements, requirementClaims, requirementRepositories, repositories, agentUsageRuns, reviewRuns, tasks } = apiRequire("@task-weaver/db");
const { createAuthenticationRuntime, createResourceServices, apiKeyService, reviewPolicyInputSchema } = apiRequire("@task-weaver/core");
const { eq, like } = apiRequire("drizzle-orm");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test("authenticated disposable CLI pipeline preserves real roles, delivery and usage fences", { skip: !databaseUrl, timeout: 170_000 }, async t => {
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
  const owner = await human(), outsider = await human();
  const project = await owner.service.projectService.createProject(db, { name: "Authorized work" }, owner.actor);
  const other = await outsider.service.projectService.createProject(db, { name: "Private work" }, outsider.actor);
  await runtime.identity.setMembership(owner.headers, project.id, outsider.actor.id, { role: "owner" });
  await runtime.identity.setMembership(outsider.headers, project.id, owner.actor.id, { role: "owner", explicitPermissions: ["execution.review", "execution.merge"] });
  const agent = await runtime.identity.createAgent(owner.headers, { displayName: "Executor fixture" });
  const otherAgent = await runtime.identity.createAgent(outsider.headers, { displayName: "Other fixture" });
  const permissions = ["resource.read", "resource.write", "execution.run", "execution.review", "execution.merge"];
  await runtime.identity.setMembership(owner.headers, project.id, agent.id, { role: "member", explicitPermissions: ["execution.run", "execution.review", "execution.merge"] });
  await runtime.identity.setMembership(outsider.headers, other.id, otherAgent.id, { role: "member", explicitPermissions: ["execution.run"] });
  async function key(actorId: string, human: any, projectId: string, actions = permissions) {
    const issued = await apiKeyService.issueScopedApiKey(db, human.context, actorId, { name: "Daemon fixture", grants: [{ scope: "project", projectId, permissions: actions }, { scope: "global", permissions: ["resource.read"] }], expiresAt: null });
    const headers = new Headers({ authorization: `Bearer ${issued.rawKey}` });
    const context = await runtime.verify(headers);
    return { headers, context, issued, service: createResourceServices(context), actor: { id: context.actor.id, type: context.actor.type } };
  }
  await owner.service.reviewService.upsertProjectReviewPolicy(db, project.id, reviewPolicyInputSchema.parse({ baseBranch: "0.3.3" }), owner.actor);
  const credentials = await key(agent.id, owner, project.id);
  const roleKeys = {
    start: await key(agent.id, owner, project.id, ["resource.read", "resource.write", "execution.run"]),
    review: await key(agent.id, owner, project.id, ["resource.read", "resource.write", "execution.review"]),
    merge: await key(agent.id, owner, project.id, ["resource.read", "resource.write", "execution.merge"]),
  };
  const supervisorKeys = [credentials, ...Object.values(roleKeys)].map(value => value.issued.rawKey);
  const root = await mkdtemp(join(tmpdir(), "tw-auth-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), bin = join(root, "bin"), seed = join(root, "seed"), remote = join(root, "remote.git");
  for (const path of [home, bin, seed]) await mkdir(path, { recursive: true });
  function git(args: string[], cwd?: string) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(["init", "--bare", "--initial-branch=0.3.3", remote]);
  git(["init", "--initial-branch=0.3.3"], seed);
  git(["config", "user.name", "Fixture"], seed); git(["config", "user.email", "fixture@example.test"], seed);
  await writeFile(join(seed, "README.md"), "Disposable repository\n");
  git(["add", "."], seed); git(["commit", "-s", "-m", "Seed disposable repository"], seed);
  git(["remote", "add", "origin", remote], seed); git(["push", "origin", "0.3.3"], seed);
  const [repository] = await db.insert(repositories).values({ displayName: "Disposable auth fixture", host: "fixture.test", namespace: "fixture", name: randomUUID(), canonicalKey: `fixture.test/fixture/${randomUUID()}`, visibility: "instance", createdBy: admin.actor.id, httpsCloneUrl: pathToFileURL(remote).href, authPolicy: { allowedTransports: ["https"], preferredTransport: "https", allowedOperations: ["read", "push"], allowNativeDefault: true, revision: 1 } }).returning();
  const requirement = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: "Authenticated pipeline", branchName: "req/auth-fixture", status: "approved" }, owner.actor);
  const task = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: requirement.id, title: "Disposable task", tags: ["executor:fake-agent"] }, owner.actor);
  const [link] = await db.insert(requirementRepositories).values({ requirementId: requirement.id, repositoryId: repository.id, baseBranch: "0.3.3", workingBranch: "req/auth-fixture" }).returning();
  const app = createApiApplication({ db, databaseUrl: databaseUrl!, env: { TW_AUTH_SECRET: config.secret, TW_AUTH_BOOTSTRAP_SECRET: config.bootstrapSecret, TW_AUTH_BASE_URL: config.baseURL, TW_AUTH_TRUSTED_ORIGINS: config.trustedOrigins[0], TW_PRESET_SKILLS_SYNC: "disabled" } }).app;
  const { serve } = apiRequire("@hono/node-server");
  let sseConnections = 0;
  const server = serve({ fetch: async (request: Request) => {
    const response = await app.fetch(request);
    if (new URL(request.url).pathname === "/api/v1/daemons/events" && response.status === 200 && response.headers.get("content-type")?.includes("text/event-stream")) sseConnections++;
    if (response.status >= 400) console.error('Fixture HTTP failure', request.method, new URL(request.url).pathname, response.status, await response.clone().text());
    return response;
  }, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const apiUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const canary = `supervisor-canary-${randomUUID()}`;
  await writeFile(join(bin, "fake-agent"), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
(async () => {
 if (process.argv.includes('--version')) { console.log('fake-agent 1.0'); return; }
 if (!/^twb_[0-9a-f]{64}$/.test(process.env.TW_API_KEY || '')) throw new Error('Expected broker capability');
 if (Object.values(process.env).some(v => v.includes('supervisor-canary-'))) throw new Error('Inherited supervisor canary');
 if (!process.env.TW_TASK_ID) {
   const base = process.env.TW_API_URL, headers = { authorization: 'Bearer ' + process.env.TW_API_KEY, 'Content-Type': 'application/json' };
   const response = await fetch(base + '/api/v1/requirements/' + ${JSON.stringify(requirement.id)}, { headers });
   if (!response.ok) throw new Error('Review read failed: ' + response.status);
   const blocked = await fetch(base + '/api/v1/tasks/' + ${JSON.stringify(task.id)} + '/status', { method: 'PATCH', headers, body: JSON.stringify({status:'in_progress',reason:'Review mutation must fail'}) });
   if (blocked.status !== 403) throw new Error('Review child acquired write authority');
   console.log('REVIEW_DECISION: approve'); return;
 }
 const manifest = JSON.parse(fs.readFileSync('repository-manifest.json', 'utf8'));
 fs.writeFileSync('child-environment.json', JSON.stringify({ ...process.env, TW_API_KEY: '[REDACTED]' }));
 for (const repository of manifest.repositories) fs.writeFileSync(path.join(repository.relativePath, 'result.txt'), 'Authenticated fixture\\n');
 const response = await fetch(process.env.TW_API_URL + '/api/v1/tasks/' + process.env.TW_TASK_ID + '/status', { method: 'PATCH', headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + process.env.TW_API_KEY }, body: JSON.stringify({status:'done',reason:'Disposable authenticated child'}) });
 if (!response.ok) throw new Error('Task mutation failed: ' + response.status);
})().catch(error => { console.error(error); process.exit(1); });
`, { mode: 0o755 });
  await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  async function cli(role: string, extra: string[]) {
    const id = randomUUID();
    const child = spawn(process.execPath, ["--import", "tsx/esm", "src/index.ts", "daemon", role, "--id", id, "--project", project.id, "--once", ...extra], {
      cwd: join(process.cwd(), "apps/cli"), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, TW_API_URL: apiUrl, TW_API_KEY: roleKeys[role as keyof typeof roleKeys].issued.rawKey, TW_NODE_ID: "disposable-auth-node", TW_PROVIDER_SECRET: canary,
        GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" },
    });
    let output = "";
    child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    clearTimeout(timeout);
    assert.equal(code, 0, output);
    assert.ok(supervisorKeys.every(key => !output.includes(key))); assert.ok(!output.includes(canary));
    return { id, output };
  }
  await t.test("polling executor runs a brokered task and pushes a disposable branch with real auth", async () => {
    const executed = await cli("start", ["--tools", "fake-agent", "--mode", "polling"]);
    const stored = await db.query.requirements.findFirst({ where: eq(requirements.id, requirement.id) });
    assert.equal(stored.status, "in_review", executed.output);
    assert.equal((await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) })).status, "done");
    const delivery = await db.query.requirementRepositories.findFirst({ where: eq(requirementRepositories.id, link.id) });
    assert.equal(delivery.executorActorId, agent.id); assert.equal(delivery.executorDaemonId, executed.id);
    assert.equal(delivery.reviewerActorId, null);
    assert.equal(git(["--git-dir", remote, "show", "req/auth-fixture:result.txt"]), "Authenticated fixture");
    const usage = await db.select().from(agentUsageRuns).where(eq(agentUsageRuns.requirementId, requirement.id));
    assert.equal(usage.length, 1); assert.equal(usage[0].reportedBy, agent.id); assert.ok(usage[0].leaseRunId); assert.ok(usage[0].leaseGeneration);
  });
  await t.test("reviewer records its current head and original lease before advancing delivery", async () => {
    const reviewed = await cli("review", ["--tools", "fake-agent", "--base", "0.3.3", "--check", "git diff --check"]);
    const stored = await db.query.requirements.findFirst({ where: eq(requirements.id, requirement.id) });
    assert.equal(stored.status, "ready_to_merge", reviewed.output);
    const review = await db.query.reviewRuns.findFirst({ where: eq(reviewRuns.requirementId, requirement.id) });
    assert.equal(review.status, "approved"); assert.equal(review.reviewerActorId, agent.id); assert.equal(review.reviewerDaemonId, reviewed.id); assert.ok(review.leaseRunId); assert.ok(review.leaseGeneration);
  });
  await t.test("reacquisition cannot authorize stale review callbacks, role confusion or old usage processes", async () => {
    const review = await db.query.reviewRuns.findFirst({ where: eq(reviewRuns.requirementId, requirement.id) });
    await db.update(requirements).set({ status: "in_review" }).where(eq(requirements.id, requirement.id));
    const daemonId = randomUUID();
    async function request(path: string, body: unknown, method = "POST", headers = credentials.headers) {
      const response = await app.request(`/api/v1/${path}`, { method, headers, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    }
    assert.equal((await request("daemons/register", { id: daemonId, name: "Reacquired reviewer", role: "reviewer", capabilities: ["review"] })).status, 201);
    const lane = await request(`daemons/${daemonId}/apply-review`, { projectId: project.id, workerIndex: 1 });
    assert.equal(lane.status, 200); assert.equal(lane.body.requirement.id, requirement.id);
    const fence = { daemonId, leaseGeneration: lane.body.leaseGeneration };
    assert.notEqual(lane.body.runId, review.leaseRunId);
    assert.equal((await request(`review-runs/${review.id}/checks`, { ...fence, name: "stale-check", status: "passed" }, "PUT")).status, 403);
    assert.equal((await request(`requirement-repositories/${link.id}/delivery`, { ...fence, deliveryStatus: "merged", mergeStatus: "merged" }, "PATCH")).status, 403);
    assert.equal((await request(`requirements/${requirement.id}/review-runs`, { ...fence, requirementRepositoryId: link.id, headCommit: review.headCommit, baseCommit: review.baseCommit, executorActorId: outsider.actor.id, executorActorType: "human" })).status, 403);
    assert.equal((await request(`requirement-repositories/${link.id}/forge-sync`, { ...fence, idempotencyKey: randomUUID(), snapshot: { provider: "fixture", externalId: "1", url: "https://fixture.test/pulls/1", state: "merged", headCommit: review.headCommit, baseCommit: review.baseCommit, mergeable: true, mergeState: null, checks: [], approvals: [] } })).status, 403);
    const freshReview = await request(`requirements/${requirement.id}/review-runs`, { ...fence, requirementRepositoryId: link.id, headCommit: review.headCommit, baseCommit: review.baseCommit });
    assert.equal(freshReview.status, 201, JSON.stringify(freshReview.body));
    assert.notEqual(freshReview.body.id, review.id);
    assert.equal((await request(`review-runs/${freshReview.body.id}/checks`, { ...fence, name: "git diff --check", status: "passed" }, "PUT")).status, 200);
    assert.equal((await request(`review-runs/${freshReview.body.id}/evaluate`, fence)).status, 200);
    await owner.service.reviewService.upsertProjectReviewPolicy(db, project.id, reviewPolicyInputSchema.parse({ baseBranch: "0.3.3", requireIndependentReviewer: true }), owner.actor);
    assert.equal((await request(`requirement-repositories/${link.id}/delivery`, { ...fence, reviewStatus: "approved" }, "PATCH")).status, 400);
    await owner.service.reviewService.upsertProjectReviewPolicy(db, project.id, reviewPolicyInputSchema.parse({ baseBranch: "0.3.3" }), owner.actor);
    await owner.service.reviewService.upsertProjectReviewPolicy(db, project.id, reviewPolicyInputSchema.parse({ baseBranch: "0.3.3", requiredChecks: ["new-required-check"] }), owner.actor);
    assert.equal((await request(`requirement-repositories/${link.id}/delivery`, { ...fence, deliveryStatus: "ready_to_merge", reviewStatus: "approved" }, "PATCH")).status, 400);
    await owner.service.reviewService.upsertProjectReviewPolicy(db, project.id, reviewPolicyInputSchema.parse({ baseBranch: "0.3.3" }), owner.actor);
    const restricted = await key(agent.id, owner, project.id, ["resource.read", "resource.write", "execution.run"]);
    assert.equal((await request(`requirement-repositories/${link.id}/delivery`, { ...fence, reviewStatus: "approved" }, "PATCH", restricted.headers)).status, 403);
    const priorUsage = (await db.select().from(agentUsageRuns).where(eq(agentUsageRuns.requirementId, requirement.id)))[0];
    const usage = { processId: priorUsage.processId, daemonId, runId: lane.body.runId, workerIndex: 1, leaseGeneration: lane.body.leaseGeneration, projectId: project.id, requirementId: requirement.id, agent: priorUsage.agent, phase: "review", startedAt: priorUsage.startedAt.toISOString(), endedAt: priorUsage.endedAt?.toISOString() ?? null, outcome: priorUsage.outcome, summary: priorUsage.summary, revision: priorUsage.revision + 1 };
    assert.equal((await request("agent-usage/runs", usage)).status, 400);
    assert.equal((await request("agent-usage/runs", { ...usage, processId: randomUUID(), leaseGeneration: lane.body.leaseGeneration - 1 })).status, 403);
    const synced = await request(`requirement-repositories/${link.id}/forge-sync`, { ...fence, idempotencyKey: randomUUID(), snapshot: { provider: "fixture", externalId: "1", url: "https://fixture.test/pulls/1", state: "open", headCommit: review.headCommit, baseCommit: review.baseCommit, mergeable: true, mergeState: null, checks: [], approvals: [] } });
    assert.equal(synced.status, 200, JSON.stringify(synced.body));
    assert.equal(synced.body.link.reviewerActorId, agent.id); assert.equal(synced.body.link.reviewerDaemonId, daemonId);
    const [claim] = await db.select().from(requirementClaims).where(eq(requirementClaims.requirementId, requirement.id));
    await db.update(requirementClaims).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(requirementClaims.id, claim.id));
    assert.equal((await request(`requirement-repositories/${link.id}/delivery`, { ...fence, reviewStatus: "approved" }, "PATCH")).status, 403);
    await db.delete(requirementClaims).where(eq(requirementClaims.id, claim.id));
    await db.update(requirements).set({ status: "ready_to_merge" }).where(eq(requirements.id, requirement.id));
  });
  await t.test("merger publishes only to the disposable remote and preserves recorded identities", async () => {
    const merged = await cli("merge", ["--base", "0.3.3", "--mode", "direct"]);
    assert.equal((await db.query.requirements.findFirst({ where: eq(requirements.id, requirement.id) })).status, "done", merged.output);
    const delivery = await db.query.requirementRepositories.findFirst({ where: eq(requirementRepositories.id, link.id) });
    assert.equal(delivery.mergerActorId, agent.id); assert.equal(delivery.mergerDaemonId, merged.id);
    assert.equal(git(["--git-dir", remote, "show", "0.3.3:result.txt"]), "Authenticated fixture");
  });
  await t.test("enabled SSE path acquires authenticated work without restoring completed lanes", async () => {
    const candidate = await owner.service.requirementService.createRequirement(db, { projectId: project.id, title: "SSE authenticated task", status: "approved" }, owner.actor);
    const selected = await owner.service.taskService.createTask(db, { projectId: project.id, requirementId: candidate.id, title: "SSE disposable task", tags: ["executor:fake-agent"] }, owner.actor);
    const previousMode = process.env.TW_DAEMON_MODE;
    process.env.TW_DAEMON_MODE = "sse";
    let executed;
    try { executed = await cli("start", ["--tools", "fake-agent", "--mode", "sse"]); }
    finally { if (previousMode === undefined) delete process.env.TW_DAEMON_MODE; else process.env.TW_DAEMON_MODE = previousMode; }
    assert.equal((await db.query.tasks.findFirst({ where: eq(tasks.id, selected.id) })).status, "done", executed.output);
    assert.equal((await db.query.requirements.findFirst({ where: eq(requirements.id, candidate.id) })).status, "in_review");
    assert.ok(sseConnections > 0, executed.output);
  });
  await t.test("persisted execution artifacts contain no supervisor or provider credentials", async () => {
    async function inspect(path: string) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "objects") await inspect(full);
        else if (entry.isFile()) {
          const content = await readFile(full, "utf8");
          assert.ok(supervisorKeys.every(key => !content.includes(key)), full); assert.ok(!content.includes(canary), full);
        }
      }
    }
    await inspect(home);
    const persisted = JSON.stringify(await db.select().from(agentUsageRuns).where(eq(agentUsageRuns.requirementId, requirement.id)));
    assert.ok(supervisorKeys.every(key => !persisted.includes(key))); assert.ok(!persisted.includes(canary));
  });
});
