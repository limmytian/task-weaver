import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createDb, runMigrations, requirements, requirementRepositories, repositories, tasks, taskDependencies, thinGitDeliveries, workerAttempts } from '../packages/db/src/index';
import { resourcePostgresFixture } from '../apps/api/src/resource-postgres-fixture';
import { runThinOnce, type ThinExecutor } from '../apps/cli/src/thin-worker';
const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const cliRequire = createRequire(new URL('../apps/cli/package.json', import.meta.url));
const { serve } = await import(apiRequire.resolve('@hono/node-server'));
const { eq } = await import(apiRequire.resolve('drizzle-orm'));
const url = process.env.TW_EXECUTION_RECOVERY_E2E_DATABASE_URL;

test('once worker runs a bounded deterministic executor and parks empty results', { skip: !url, timeout: 120000 }, async t => {
  const parsed = new URL(url!); assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.pathname, '/tw_execution_recovery_e2e');
  await runMigrations(url!); const db = createDb(url!); t.after(() => db.$client.end());
  const root = await mkdtemp(join(tmpdir(), 'tw-thin-runner-')), oldHome = process.env.HOME, oldStorage = process.env.TW_ATTACHMENT_STORAGE_DIR, oldConfig = process.env.TW_CONFIG_DIR;
  process.env.HOME = root; process.env.TW_CONFIG_DIR = join(root, 'cli'); process.env.TW_ATTACHMENT_STORAGE_DIR = join(root, 'storage');
  t.after(async () => { for (const [key, value] of [['HOME', oldHome], ['TW_ATTACHMENT_STORAGE_DIR', oldStorage], ['TW_CONFIG_DIR', oldConfig]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(root, { recursive: true, force: true }); });
  const f = await resourcePostgresFixture(db, url!);
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: 'Deterministic executor' });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: 'maintainer', explicitPermissions: [] });
  const issue = (id: string, manage: boolean) => f.identity.issueKey(f.owner.headers, id, { name: 'Runner fixture', expiresAt: null, grants: [{ scope: 'project', projectId: f.project.id, permissions: ['resource.read', 'resource.write', 'execution.run', ...(manage ? ['project.manage' as const] : [])] }, { scope: 'global', permissions: ['resource.read'] }] });
  const owner = await issue(f.owner.context.actor.id, true), key = await issue(agent.id, true);
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 }); t.after(() => server.close()); if (!server.listening) await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const apiUrl = `http://127.0.0.1:${address.port}`;
  const mode = await fetch(`${apiUrl}/api/v1/thin-workers/mode`, { method: 'POST', headers: { authorization: `Bearer ${owner.rawKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: f.project.id, mode: 'thin', inspection: 'Disposable fixture is empty' }) }); assert.equal(mode.status, 200);
  const [req] = await db.insert(requirements).values({ projectId: f.project.id, title: 'Runner fixture', status: 'approved', createdBy: f.owner.context.actor.id }).returning();
  const children = await db.insert(tasks).values(['A', 'B'].map(title => ({ projectId: f.project.id, requirementId: req!.id, title, createdBy: f.owner.context.actor.id }))).returning();
  const [accept] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: req!.id, title: 'Acceptance', createdBy: f.owner.context.actor.id }).returning();
  await db.insert(taskDependencies).values(children.map(child => ({ taskId: accept!.id, dependsOnTaskId: child.id, type: 'blocks' as const })));
  const config = { apiUrl, apiKey: key.rawKey, nodeId: 'fixture-node' };
  const executor: ThinExecutor = { async preflight() { return { blocked: false, reason: 'Fixture', retryAt: null } }, async execute(input) { assert.equal(input.environment.TW_API_KEY, undefined); assert.ok(!Object.values(input.environment).includes(key.rawKey)); await new Promise(resolve => setTimeout(resolve, 300)); await writeFile(join(input.cwd, 'result.md'), 'Deterministic evidence\n'); return { ok: true, reason: 'Fixture', quotaBlocked: false } } };
  const phases: string[] = [];
  const opts = { config, projectId: f.project.id, model: 'fixture', effort: 'low', timeoutMs: 10000, heartbeatIntervalMs: 100, executor, onPhase: async (phase: string) => { phases.push(phase) } };
  const runs = await Promise.all([runThinOnce(opts), runThinOnce(opts)]);
  assert.deepEqual(new Set(runs.map(run => run.taskId)), new Set(children.map(child => child.id)));
  assert.ok(runs.every(run => run.state === 'completed'));
  assert.ok(runs.every(run => run.usage === 'unknown'));
  assert.deepEqual(new Set(phases), new Set(['preflight', 'acquiring', 'preparing', 'executing', 'publishing']));
  for (const run of runs) {
    const attempt = await db.query.workerAttempts.findFirst({ where: eq(workerAttempts.id, run.attemptId!) });
    assert.ok(attempt!.heartbeatAt.getTime() > attempt!.createdAt.getTime());
  }
  const emptyExecutor: ThinExecutor = { ...executor, async execute() { return { ok: true, reason: 'Fixture', quotaBlocked: false } } };
  const parked = await runThinOnce({ ...opts, executor: emptyExecutor });
  assert.equal(parked.taskId, accept!.id); assert.equal(parked.state, 'attention');
  assert.equal((await db.query.tasks.findFirst({ where: eq(tasks.id, accept!.id) }))!.status, 'in_review');
  const before = (await db.select().from(workerAttempts)).length;
  const quota = await runThinOnce({ ...opts, executor: { ...executor, async preflight() { return { blocked: true, reason: 'Quota exhausted', retryAt: null } } } });
  assert.equal(quota.state, 'cooldown'); assert.equal((await db.select().from(workerAttempts)).length, before);
  const repeated = await runThinOnce({ ...opts, executor: { ...executor, async preflight() { throw new Error('Cooldown must avoid a new probe') } } });
  assert.equal(repeated.state, 'cooldown');
  const [cliTask] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: req!.id, title: 'CLI executor', createdBy: f.owner.context.actor.id }).returning();
  const bin = join(root, 'bin'); await mkdir(bin);
  const fakeCodex = join(bin, 'codex');
  await writeFile(fakeCodex, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'); if(process.argv.includes('--version')) { console.log('fixture-codex'); } else if(process.argv.includes('app-server')) { readline.createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line); if(v.id===1) console.log(JSON.stringify({id:1,result:{}})); if(v.id===2) console.log(JSON.stringify({id:2,result:{rateLimits:{limitId:'fixture',primary:{usedPercent:5}}}}));}); } else { const i=process.argv.indexOf('-C'); fs.writeFileSync(path.join(process.argv[i+1],'result.md'),'CLI fixture evidence\\n'); }\n`);
  await chmod(fakeCodex, 0o700);
  const cli = await promisify(execFile)(process.execPath, ['--import', cliRequire.resolve('tsx'), 'src/index.ts', 'worker', 'start', '--project', f.project.id, '--requirement', req!.id, '--model', 'fixture', '--think', 'low', '--once'], { cwd: resolve('apps/cli'), timeout: 30000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, TW_CONFIG_DIR: join(root, 'cli-process'), TW_API_URL: apiUrl, TW_API_KEY: key.rawKey, TW_NODE_ID: 'cli-fixture', TW_CODEX_HOME: join(root, 'codex-home') } });
  const cliOutcome = JSON.parse(cli.stdout);
  assert.equal(cliOutcome.taskId, cliTask!.id); assert.equal(cliOutcome.state, 'completed');
  const presenceResponse = await fetch(`${apiUrl}/api/v1/thin-workers/presence?${new URLSearchParams({ projectId: f.project.id })}`, { headers: { authorization: `Bearer ${key.rawKey}` } });
  assert.equal(presenceResponse.status, 200);
  const presenceRows = await presenceResponse.json() as Array<{ nodeId: string; status: string }>;
  assert.equal(presenceRows.find(row => row.nodeId === 'cli-fixture')?.status, 'offline');
  const residentEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, TW_CONFIG_DIR: join(root, 'resident-process'), TW_API_URL: apiUrl, TW_API_KEY: key.rawKey, TW_NODE_ID: 'resident-fixture', TW_CODEX_HOME: join(root, 'resident-codex-home') };
  const resident = spawn(process.execPath, ['--import', cliRequire.resolve('tsx'), 'src/index.ts', 'worker', 'start', '--project', f.project.id, '--model', 'fixture', '--think', 'low', '--poll-seconds', '30'], { cwd: resolve('apps/cli'), env: residentEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { if (resident.pid) process.kill(-resident.pid, 'SIGKILL'); } catch {} });
  let residentOutput = '', residentError = '';
  resident.stdout.on('data', chunk => { residentOutput += chunk.toString() });
  resident.stderr.on('data', chunk => { residentError += chunk.toString() });
  const until = async (condition: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`${label}; stdout=${residentOutput.slice(0, 1000)} stderr=${residentError.slice(0, 1000)}`);
  };
  await until(() => /"state":\s*"empty"/.test(residentOutput), 'Resident worker did not perform its initial queue query');
  const create = await fetch(`${apiUrl}/api/v1/projects/${f.project.id}/tasks`, { method: 'POST', headers: { authorization: `Bearer ${owner.rawKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ requirementId: req!.id, title: 'SSE wake task' }) });
  assert.equal(create.status, 201, await create.clone().text());
  const wakeTask = await create.json() as { id: string };
  await until(async () => (await db.query.tasks.findFirst({ where: eq(tasks.id, wakeTask.id) }))?.status === 'done', 'SSE did not wake the resident worker');
  if (resident.pid) process.kill(resident.pid, 'SIGTERM');
  await until(() => resident.exitCode !== null || resident.signalCode !== null, 'Resident worker did not stop');
  await until(async () => {
    const rows = await (await fetch(`${apiUrl}/api/v1/thin-workers/presence?${new URLSearchParams({ projectId: f.project.id })}`, { headers: { authorization: `Bearer ${key.rawKey}` } })).json() as Array<{ nodeId: string; status: string }>;
    return rows.find(row => row.nodeId === 'resident-fixture')?.status === 'offline';
  }, 'Resident presence did not report a clean stop');
  const [coordinator] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: req!.id, title: 'Coordinator', tags: ['worker:coordinator'], createdBy: f.owner.context.actor.id }).returning();
  const planner: ThinExecutor = { ...executor, async execute(input) {
    await writeFile(join(input.cwd, 'result.md'), 'Plan and acceptance criteria recorded.\n');
    await writeFile(join(input.cwd, 'plan.json'), JSON.stringify({ projectId: f.project.id, requirements: [{ key: 'current', existingId: req!.id, tasks: [{ key: 'one', title: 'Planned A' }, { key: 'two', title: 'Planned B' }, { key: 'accept', title: 'Planned acceptance', tags: ['worker:acceptance'], dependsOn: ['one', 'two'] }] }] }));
    return { ok: true, reason: 'Fixture plan', quotaBlocked: false };
  } };
  const planned = await runThinOnce({ ...opts, config: { ...config, nodeId: 'planner-node' }, executor: planner });
  assert.equal(planned.taskId, coordinator!.id); assert.equal(planned.state, 'completed');
  const implementations = await Promise.all(['child-node-a', 'child-node-b'].map(nodeId => runThinOnce({ ...opts, config: { ...config, nodeId } })));
  assert.ok(implementations.every(result => result.state === 'completed'));
  const reviewer: ThinExecutor = { ...executor, async execute(input) {
    assert.equal((await readdir(join(input.cwd, 'inputs'))).length, 3);
    await writeFile(join(input.cwd, 'result.md'), 'Both task artifacts reviewed.\n');
    await writeFile(join(input.cwd, 'decision.json'), JSON.stringify({ decision: 'accept', summary: 'Both artifacts verified' }));
    return { ok: true, reason: 'Fixture review', quotaBlocked: false };
  } };
  const reviewed = await runThinOnce({ ...opts, config: { ...config, nodeId: 'review-node' }, executor: reviewer });
  assert.equal(reviewed.state, 'completed');
  const reviewedTask = await db.query.tasks.findFirst({ where: eq(tasks.id, reviewed.taskId!) });
  assert.equal(reviewedTask!.title, 'Planned acceptance');
  const [needsWork] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: req!.id, title: 'Requires follow-up', createdBy: f.owner.context.actor.id }).returning();
  const [rejectTask] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: req!.id, title: 'Review findings', tags: ['worker:acceptance'], createdBy: f.owner.context.actor.id }).returning();
  await db.insert(taskDependencies).values({ taskId: rejectTask!.id, dependsOnTaskId: needsWork!.id, type: 'blocks' });
  assert.equal((await runThinOnce({ ...opts, config: { ...config, nodeId: 'work-node' } })).taskId, needsWork!.id);
  const findingReviewer: ThinExecutor = { ...reviewer, async execute(input) {
    await writeFile(join(input.cwd, 'result.md'), 'A required check is missing.\n');
    await writeFile(join(input.cwd, 'decision.json'), JSON.stringify({ decision: 'changes_requested', summary: 'Required check missing' }));
    return { ok: true, reason: 'Fixture review', quotaBlocked: false };
  } };
  const finding = await runThinOnce({ ...opts, config: { ...config, nodeId: 'finding-node' }, executor: findingReviewer });
  assert.equal(finding.taskId, rejectTask!.id); assert.equal(finding.state, 'attention');
  assert.equal((await db.query.tasks.findFirst({ where: eq(tasks.id, rejectTask!.id) }))!.status, 'in_review');
  const findingAttempt = await db.query.workerAttempts.findFirst({ where: eq(workerAttempts.id, finding.attemptId!) });
  assert.equal(findingAttempt!.result!.acceptanceDecision, 'changes_requested');
  assert.ok(findingAttempt!.result!.outputId);
  const seed = join(root, 'git-seed'), bare = join(root, 'git-remote.git'); await mkdir(seed);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(seed, 'init'); git(seed, 'checkout', '-b', 'main'); git(seed, 'config', 'user.name', 'Fixture'); git(seed, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(seed, 'base.txt'), 'base\n'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'base');
  git(root, 'init', '--bare', bare); git(seed, 'remote', 'add', 'origin', bare); git(seed, 'push', 'origin', 'main'); git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const [gitReq] = await db.insert(requirements).values({ projectId: f.project.id, title: 'Git delivery fixture', status: 'approved', createdBy: f.owner.context.actor.id }).returning();
  const [gitRepo] = await db.insert(repositories).values({ displayName: 'Git runner fixture', provider: 'github', host: 'github.com', namespace: 'fixture', name: 'git-runner', canonicalKey: `fixture-${gitReq!.id}`, httpsCloneUrl: pathToFileURL(bare).href, defaultBranch: 'main', authPolicy: { allowedTransports: ['https'], preferredTransport: 'https', allowedOperations: ['read', 'push'], allowNativeDefault: true }, createdBy: f.owner.context.actor.id }).returning();
  await db.insert(requirementRepositories).values({ requirementId: gitReq!.id, repositoryId: gitRepo!.id, workingBranch: 'main' });
  const [gitTask] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: gitReq!.id, title: 'Git task', createdBy: f.owner.context.actor.id }).returning();
  const [gitTaskB] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: gitReq!.id, title: 'Git task B', createdBy: f.owner.context.actor.id }).returning();
  const [gitAcceptance] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: gitReq!.id, title: 'Git acceptance', tags: ['worker:acceptance'], createdBy: f.owner.context.actor.id }).returning();
  await db.insert(taskDependencies).values([gitTask!, gitTaskB!].map(item => ({ taskId: gitAcceptance!.id, dependsOnTaskId: item.id, type: 'blocks' as const })));
  const actualFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input);
    if (!target.startsWith('https://api.github.com/repos/fixture/git-runner/')) return actualFetch(input, init);
    const endpoint = target.split('/').at(-1)!;
    if (target.includes('/compare/')) { const [base, head] = endpoint.split('...'); const ancestor = git(bare, 'merge-base', base!, head!); return new Response(JSON.stringify({ status: ancestor === base ? 'ahead' : 'diverged', base_commit: { sha: base }, merge_base_commit: { sha: ancestor } }), { status: 200 }); }
    return new Response(JSON.stringify({ name: 'main', commit: { sha: git(bare, 'rev-parse', 'refs/heads/main') } }), { status: 200 });
  }) as typeof fetch;
  try {
    const gitExecutor: ThinExecutor = { ...executor, async execute(input) { const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(input.cwd, 'repository-manifest.json'), 'utf8')); await writeFile(join(input.cwd, manifest.repositories[0].relativePath, input.prompt.includes('Git task B') ? 'worker-b.txt' : 'worker.txt'), 'delivered\n'); await writeFile(join(input.cwd, 'result.md'), 'Git delivery verified\n'); return { ok: true, reason: 'Fixture Git work', quotaBlocked: false }; } };
    const gitRuns = await Promise.all(['git-fixture-a', 'git-fixture-b'].map(nodeId => runThinOnce({ ...opts, requirementId: gitReq!.id, gitIdentity: { name: 'Fixture', email: 'fixture@example.test' }, executor: gitExecutor, config: { ...config, nodeId } })));
    assert.deepEqual(new Set(gitRuns.map(run => run.taskId)), new Set([gitTask!.id, gitTaskB!.id]));
    assert.ok(gitRuns.every(run => run.state === 'completed'), JSON.stringify(gitRuns));
    const tip = git(bare, 'rev-parse', 'refs/heads/main');
    for (const run of gitRuns) { const rows = await db.select().from(thinGitDeliveries).where(eq(thinGitDeliveries.attemptId, run.attemptId!)); const stored = rows.find(row => row.state === 'confirmed'); assert.ok(stored, JSON.stringify(rows.map(row => row.state))); git(bare, 'merge-base', '--is-ancestor', stored.proposedHead, tip); }
    assert.equal(git(bare, 'show', `${tip}:worker.txt`), 'delivered'); assert.equal(git(bare, 'show', `${tip}:worker-b.txt`), 'delivered');
    const gitReviewer: ThinExecutor = { ...executor, async execute(input) {
      const fs = await import('node:fs/promises'); const manifest = JSON.parse(await fs.readFile(join(input.cwd, 'repository-manifest.json'), 'utf8'));
      assert.equal(await fs.readFile(join(input.cwd, manifest.repositories[0].relativePath, 'worker.txt'), 'utf8'), 'delivered\n');
      assert.equal(await fs.readFile(join(input.cwd, manifest.repositories[0].relativePath, 'worker-b.txt'), 'utf8'), 'delivered\n');
      await writeFile(join(input.cwd, 'result.md'), 'Reviewed the delivered branch and evidence.\n');
      await writeFile(join(input.cwd, 'decision.json'), JSON.stringify({ decision: 'accept', summary: 'Git delivery reviewed' }));
      return { ok: true, reason: 'Fixture Git acceptance', quotaBlocked: false };
    } };
    const gitReviewed = await runThinOnce({ ...opts, requirementId: gitReq!.id, executor: gitReviewer, config: { ...config, nodeId: 'git-review-fixture' } });
    assert.equal(gitReviewed.taskId, gitAcceptance!.id); assert.equal(gitReviewed.state, 'completed', gitReviewed.reason);

  } finally { globalThis.fetch = actualFetch; }
  const [networkTask] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: req!.id, title: 'Network interruption', createdBy: f.owner.context.actor.id }).returning();
  const interrupted = await runThinOnce({ ...opts, config: { ...config, nodeId: 'other-node' }, executor: { ...executor, async execute(input) { await writeFile(join(input.cwd, 'result.md'), 'Local work\n'); server.close(); server.closeAllConnections(); return { ok: true, reason: 'Fixture', quotaBlocked: false } } } });
  assert.equal(interrupted.taskId, networkTask!.id);
  assert.equal(interrupted.state, 'attention');
  assert.equal((await db.query.tasks.findFirst({ where: eq(tasks.id, networkTask!.id) }))!.status, 'in_progress');
});
