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
import { createDb, runMigrations, requirements, requirementRepositories, repositories, tasks, taskDependencies, thinGitDeliveries, workerAcceptanceSnapshots, workerAttempts } from '../packages/db/src/index';
import { BASIC_WORKFLOW } from '../packages/contracts/src/index';
import { createThinWorkerService } from '../packages/core/src/services/thin-worker';
import { resourcePostgresFixture } from '../apps/api/src/resource-postgres-fixture';
import { runThinOnce, type ThinExecutor } from '../apps/cli/src/thin-worker';
const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const cliRequire = createRequire(new URL('../apps/cli/package.json', import.meta.url));
const { serve } = await import(apiRequire.resolve('@hono/node-server'));
const { eq } = await import(apiRequire.resolve('drizzle-orm'));
const url = process.env.TW_EXECUTION_RECOVERY_E2E_DATABASE_URL ?? process.env.TW_AUTH_E2E_DATABASE_URL;

test('once worker runs a bounded deterministic executor and parks empty results', { skip: !url, timeout: 120000 }, async t => {
  const parsed = new URL(url!); assert.equal(parsed.hostname, '127.0.0.1'); assert.ok(['/tw_execution_recovery_e2e', '/tw_auth_e2e'].includes(parsed.pathname));
  await runMigrations(url!); const db = createDb(url!); t.after(() => db.$client.end());
  const root = await mkdtemp(join(tmpdir(), 'tw-thin-runner-')), oldHome = process.env.HOME, oldStorage = process.env.TW_ATTACHMENT_STORAGE_DIR, oldConfig = process.env.TW_CONFIG_DIR, oldGitGlobal = process.env.GIT_CONFIG_GLOBAL, oldGitSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.HOME = root; process.env.TW_CONFIG_DIR = join(root, 'cli'); process.env.TW_ATTACHMENT_STORAGE_DIR = join(root, 'storage');
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig'); process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  await writeFile(process.env.GIT_CONFIG_GLOBAL, '[credential]\n\thelper = store --file /dev/null\n', { mode: 0o600 });
  t.after(async () => { for (const [key, value] of [['HOME', oldHome], ['TW_ATTACHMENT_STORAGE_DIR', oldStorage], ['TW_CONFIG_DIR', oldConfig], ['GIT_CONFIG_GLOBAL', oldGitGlobal], ['GIT_CONFIG_SYSTEM', oldGitSystem]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(root, { recursive: true, force: true }); });
  const f = await resourcePostgresFixture(db, url!);
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: 'Deterministic executor' });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: 'maintainer', explicitPermissions: [] });
  const issue = (id: string, manage: boolean) => f.identity.issueKey(f.owner.headers, id, { name: 'Runner fixture', expiresAt: null, grants: [{ scope: 'project', projectId: f.project.id, permissions: ['resource.read', 'resource.write', 'execution.run', ...(manage ? ['project.manage' as const] : [])] }, { scope: 'global', permissions: ['resource.read'] }] });
  const owner = await issue(f.owner.context.actor.id, true), key = await issue(agent.id, true);
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 }); t.after(() => server.close()); if (!server.listening) await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const apiUrl = `http://127.0.0.1:${address.port}`;
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
  const [gitReq] = await db.insert(requirements).values({ projectId: f.project.id, title: 'Git delivery fixture', status: 'approved', workflow: BASIC_WORKFLOW, createdBy: f.owner.context.actor.id }).returning();
  const [gitRepo] = await db.insert(repositories).values({ displayName: 'Git runner fixture', provider: 'github', host: 'github.com', namespace: 'fixture', name: 'git-runner', canonicalKey: `fixture-${gitReq!.id}`, httpsCloneUrl: pathToFileURL(bare).href, defaultBranch: 'main', authPolicy: { allowedTransports: ['https'], preferredTransport: 'https', allowedOperations: ['read', 'push'], allowNativeDefault: true }, createdBy: f.owner.context.actor.id }).returning();
  await db.insert(requirementRepositories).values({ requirementId: gitReq!.id, repositoryId: gitRepo!.id, workingBranch: 'main', baseBranch: 'release' });
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
    const branch = decodeURIComponent(endpoint); return new Response(JSON.stringify({ name: branch, commit: { sha: git(bare, 'rev-parse', `refs/heads/${branch}`) } }), { status: 200 });
  }) as typeof fetch;
  try {
    const gitExecutor: ThinExecutor = { ...executor, async execute(input) { const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(input.cwd, 'repository-manifest.json'), 'utf8')); await writeFile(join(input.cwd, manifest.repositories[0].relativePath, input.prompt.includes('Git task B') ? 'worker-b.txt' : 'worker.txt'), 'delivered\n'); await writeFile(join(input.cwd, 'result.md'), 'Git delivery verified\n'); return { ok: true, reason: 'Fixture Git work', quotaBlocked: false }; } };
    const errors: string[] = [];
    const gitRuns = await Promise.all(['git-fixture-a', 'git-fixture-b'].map(nodeId => runThinOnce({ ...opts, requirementId: gitReq!.id, gitIdentity: { name: 'Fixture', email: 'fixture@example.test' }, executor: gitExecutor, config: { ...config, nodeId }, onError: error => { errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error)) } })));
    assert.deepEqual(new Set(gitRuns.map(run => run.taskId)), new Set([gitTask!.id, gitTaskB!.id]));
    assert.ok(gitRuns.every(run => run.state === 'completed'), JSON.stringify({ gitRuns, errors }));
    const tip = git(bare, 'rev-parse', 'refs/heads/main');
    for (const run of gitRuns) { const rows = await db.select().from(thinGitDeliveries).where(eq(thinGitDeliveries.attemptId, run.attemptId!)); const stored = rows.find(row => row.state === 'confirmed'); assert.ok(stored, JSON.stringify(rows.map(row => row.state))); git(bare, 'merge-base', '--is-ancestor', stored.proposedHead, tip); }
    assert.equal(git(bare, 'show', `${tip}:worker.txt`), 'delivered'); assert.equal(git(bare, 'show', `${tip}:worker-b.txt`), 'delivered');
    const conflictTasks = await db.insert(tasks).values(['Conflict A', 'Conflict B'].map(title => ({ projectId: f.project.id, requirementId: gitReq!.id, title, createdBy: f.owner.context.actor.id }))).returning();
    await db.insert(taskDependencies).values(conflictTasks.map(item => ({ taskId: gitAcceptance!.id, dependsOnTaskId: item.id, type: 'blocks' as const })));
    let entered = 0; let release!: () => void; const bothReady = new Promise<void>(resolve => { release = resolve; }); let resolutions = 0;
    const conflictExecutor: ThinExecutor = { ...executor, async execute(input) {
      if (input.prompt.startsWith('Resolve the current Git merge conflicts')) { resolutions++; await writeFile(join(input.cwd, 'base.txt'), 'resolved both changes\n'); git(input.cwd, 'add', 'base.txt'); return { ok: true, reason: 'Fixture conflict resolved', quotaBlocked: false }; }
      const fs = await import('node:fs/promises'); const manifest = JSON.parse(await fs.readFile(join(input.cwd, 'repository-manifest.json'), 'utf8'));
      await writeFile(join(input.cwd, manifest.repositories[0].relativePath, 'base.txt'), input.prompt.includes('Conflict A') ? 'change A\n' : 'change B\n');
      await writeFile(join(input.cwd, 'result.md'), 'Conflict fixture evidence\n'); if (++entered === 2) release(); await bothReady;
      return { ok: true, reason: 'Fixture conflict work', quotaBlocked: false };
    } };
    const conflictRuns = await Promise.all(['conflict-a', 'conflict-b'].map(nodeId => runThinOnce({ ...opts, requirementId: gitReq!.id, gitIdentity: { name: 'Fixture', email: 'fixture@example.test' }, executor: conflictExecutor, config: { ...config, nodeId } })));
    assert.ok(conflictRuns.every(run => run.state === 'completed'), JSON.stringify(conflictRuns)); assert.equal(resolutions, 1);
    assert.equal(git(bare, 'show', 'refs/heads/main:base.txt'), 'resolved both changes');

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
    const [acceptedSnapshot] = await db.select().from(workerAcceptanceSnapshots).where(eq(workerAcceptanceSnapshots.attemptId, gitReviewed.attemptId!));
    assert.equal(acceptedSnapshot?.repositoryId, gitRepo!.id); assert.equal(acceptedSnapshot?.commit, git(bare, 'rev-parse', 'refs/heads/main'));
    const [integration] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: gitReq!.id, title: 'Integrate version', tags: ['worker:integration'], createdBy: f.owner.context.actor.id }).returning();
    await db.insert(taskDependencies).values({ taskId: integration!.id, dependsOnTaskId: gitAcceptance!.id, type: 'blocks' });
    const integrationWorker = crypto.randomUUID();
    const integrationResponse = await fetch(`${apiUrl}/api/v1/thin-workers/acquire`, { method: 'POST', headers: { authorization: `Bearer ${key.rawKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: f.project.id, requirementId: gitReq!.id, workerId: integrationWorker, nodeId: 'integration-fixture', executor: 'codex', model: 'fixture', durationSeconds: 120 }) });
    assert.equal(integrationResponse.status, 200); const lane = await integrationResponse.json() as any; assert.equal(lane.task.id, integration!.id);
    const inputResponse = await fetch(`${apiUrl}/api/v1/thin-workers/integration/inputs`, { method: 'POST', headers: { authorization: `Bearer ${key.rawKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: lane.attempt.id, workerId: integrationWorker, token: lane.token }) });
    assert.equal(inputResponse.status, 200, await inputResponse.clone().text()); const integrationInputs = await inputResponse.json() as any;
    assert.equal(integrationInputs.acceptanceAttemptId, gitReviewed.attemptId); assert.equal(integrationInputs.sources[0].sourceCommit, acceptedSnapshot!.commit); assert.equal(integrationInputs.sources[0].targetBranch, 'release');
    const premature = await fetch(`${apiUrl}/api/v1/thin-workers/result`, { method: 'POST', headers: { authorization: `Bearer ${key.rawKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: lane.attempt.id, workerId: integrationWorker, token: lane.token, resultKey: crypto.randomUUID(), outcome: 'done', summary: 'Premature integration', outputId: crypto.randomUUID() }) });
    assert.equal(premature.status, 409); assert.match((await premature.json() as any).error, /confirmed version delivery/);
    const integrationFence = { attemptId: lane.attempt.id, workerId: integrationWorker, token: lane.token };
    const readIntegration = () => fetch(`${apiUrl}/api/v1/thin-workers/integration/inputs`, { method: 'POST', headers: { authorization: `Bearer ${key.rawKey}`, 'content-type': 'application/json' }, body: JSON.stringify(integrationFence) });
    await db.update(requirementRepositories).set({ baseBranch: 'main' }).where(eq(requirementRepositories.repositoryId, gitRepo!.id));
    assert.equal((await readIntegration()).status, 409, 'source and target must remain distinct');
    await db.update(requirementRepositories).set({ baseBranch: 'release', workingBranch: 'changed' }).where(eq(requirementRepositories.repositoryId, gitRepo!.id));
    assert.equal((await readIntegration()).status, 409, 'changed source branch invalidates acceptance');
    await db.update(requirementRepositories).set({ workingBranch: 'main' }).where(eq(requirementRepositories.repositoryId, gitRepo!.id));
    const reviewedTip = git(bare, 'rev-parse', 'refs/heads/main');
    git(bare, 'update-ref', 'refs/heads/main', git(bare, 'rev-parse', `${reviewedTip}^`));
    assert.equal((await readIntegration()).status, 409, 'remote branch movement after acceptance must be rejected');
    git(bare, 'update-ref', 'refs/heads/main', reviewedTip);
    await db.update(tasks).set({ status: 'in_review' }).where(eq(tasks.id, gitAcceptance!.id));
    assert.equal((await readIntegration()).status, 409, 'acceptance must remain completed');
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, gitAcceptance!.id));
    assert.equal((await readIntegration()).status, 409, 'cancelled acceptance cannot authorize integration');
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, gitAcceptance!.id));
    const [unfinished] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: gitReq!.id, title: 'Unfinished requirement work', createdBy: f.owner.context.actor.id }).returning();
    assert.equal((await readIntegration()).status, 409, 'integration must wait for all requirement tasks');
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, unfinished!.id));
    assert.equal((await readIntegration()).status, 409, 'acceptance must cover completed work even without a declared edge');
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, unfinished!.id));
    assert.equal((await readIntegration()).status, 200);
    const integrationService = createThinWorkerService(await f.auth.resolve(new Headers({ authorization: `Bearer ${key.rawKey}` })));
    const prepareVersion = { ...integrationFence, operationKey: crypto.randomUUID(), repositoryId: gitRepo!.id, expectedHead: 'a'.repeat(40), proposedHead: 'b'.repeat(40) };
    await assert.rejects(integrationService.prepareGitDelivery(db, { ...prepareVersion, targetBranch: 'main' }), /cannot prepare task-branch deliveries/);
    const versionDelivery = await integrationService.prepareIntegrationDelivery(db, prepareVersion);
    assert.equal(versionDelivery.purpose, 'integration'); assert.equal(versionDelivery.acceptanceAttemptId, gitReviewed.attemptId); assert.equal(versionDelivery.acceptedCommit, acceptedSnapshot!.commit); assert.equal(versionDelivery.targetBranch, 'release');
    assert.equal((await integrationService.prepareIntegrationDelivery(db, prepareVersion)).id, versionDelivery.id);
    await assert.rejects(integrationService.prepareIntegrationDelivery(db, { ...prepareVersion, proposedHead: 'c'.repeat(40) }), /already used/);
    await assert.rejects(integrationService.transitionGitDelivery(db, { ...integrationFence, deliveryId: versionDelivery.id, event: 'start_push' }), /not yet available/);
    assert.equal((await integrationService.transitionGitDelivery(db, { ...integrationFence, deliveryId: versionDelivery.id, event: 'definitely_not_started' })).delivery.state, 'abandoned');
    const targetBefore = git(bare, 'rev-parse', `${reviewedTip}^`);
    git(bare, 'update-ref', 'refs/heads/release', targetBefore);
    const nextVersion = await integrationService.prepareIntegrationDelivery(db, { ...prepareVersion, operationKey: crypto.randomUUID(), expectedHead: targetBefore, proposedHead: reviewedTip });
    git(bare, 'update-ref', 'refs/heads/main', git(bare, 'rev-parse', `${reviewedTip}^`));
    await assert.rejects(integrationService.authorizeIntegrationPush(db, { ...integrationFence, deliveryId: nextVersion.id }), /changed after acceptance/);
    git(bare, 'update-ref', 'refs/heads/main', reviewedTip);
    const authorization = await integrationService.authorizeIntegrationPush(db, { ...integrationFence, deliveryId: nextVersion.id });
    assert.equal(authorization.shouldPush, true);
    assert.equal((await integrationService.authorizeIntegrationPush(db, { ...integrationFence, deliveryId: nextVersion.id })).shouldPush, false);
    assert.equal((await integrationService.transitionGitDelivery(db, { ...integrationFence, deliveryId: nextVersion.id, event: 'response_lost' })).delivery.state, 'uncertain');
    git(bare, 'update-ref', 'refs/heads/release', reviewedTip);
    git(bare, 'update-ref', 'refs/heads/main', targetBefore);
    await assert.rejects(integrationService.confirmGitDelivery(db, { ...integrationFence, deliveryId: nextVersion.id }), /changed after acceptance/);
    git(bare, 'update-ref', 'refs/heads/main', reviewedTip);
    assert.equal((await integrationService.confirmGitDelivery(db, { ...integrationFence, deliveryId: nextVersion.id })).state, 'confirmed');
    const recoveryVersion = await integrationService.prepareIntegrationDelivery(db, { ...prepareVersion, operationKey: crypto.randomUUID(), expectedHead: targetBefore, proposedHead: reviewedTip });
    assert.equal((await integrationService.authorizeIntegrationPush(db, { ...integrationFence, deliveryId: recoveryVersion.id })).shouldPush, true);
    await integrationService.transitionGitDelivery(db, { ...integrationFence, deliveryId: recoveryVersion.id, event: 'response_lost' });
    await db.update(workerAttempts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(workerAttempts.id, lane.attempt.id));
    const ownerService = createThinWorkerService(await f.auth.resolve(new Headers({ authorization: `Bearer ${owner.rawKey}` })));
    assert.equal((await ownerService.reconcileGitDelivery(db, { deliveryId: recoveryVersion.id, reason: 'Checked remote version branch after lost response' })).state, 'confirmed');
    await ownerService.resolve(db, { attemptId: lane.attempt.id, disposition: 'retry', retrySafe: true, reason: 'Verified remote version delivery before retry' });
    git(bare, 'update-ref', 'refs/heads/release', targetBefore);
    const versionCheckout = join(root, 'version-concurrent'); git(root, 'clone', bare, versionCheckout); git(versionCheckout, 'checkout', '-b', 'release', 'origin/release');
    git(versionCheckout, 'config', 'user.name', 'Version fixture'); git(versionCheckout, 'config', 'user.email', 'version@example.test');
    await writeFile(join(versionCheckout, 'version-only.txt'), 'version work\n'); await writeFile(join(versionCheckout, 'base.txt'), 'concurrent version change\n'); git(versionCheckout, 'add', '.'); git(versionCheckout, 'commit', '-m', 'Concurrent version work');
    const concurrentVersion = git(versionCheckout, 'rev-parse', 'HEAD'); git(versionCheckout, 'push', 'origin', 'release');
    let versionResolutions = 0;
    const versionExecutor: ThinExecutor = { ...executor, async execute(input) {
      assert.match(input.prompt, /Resolve the current Git merge conflicts/); versionResolutions++;
      await writeFile(join(input.cwd, 'base.txt'), 'resolved version and requirement\n'); git(input.cwd, 'add', 'base.txt');
      return { ok: true, reason: 'Version conflict resolved', quotaBlocked: false };
    } };
    const integrated = await runThinOnce({ ...opts, requirementId: gitReq!.id, gitIdentity: { name: 'Fixture', email: 'fixture@example.test' }, executor: versionExecutor, config: { ...config, nodeId: 'version-retry-fixture' } });
    assert.equal(versionResolutions, 1);
    assert.equal(integrated.taskId, integration!.id); assert.equal(integrated.state, 'completed', integrated.reason);
    assert.equal((await db.query.requirements.findFirst({ where: eq(requirements.id, gitReq!.id) }))!.status, 'done');
    const versionTip = git(bare, 'rev-parse', 'refs/heads/release');
    git(bare, 'merge-base', '--is-ancestor', acceptedSnapshot!.commit, versionTip);
    git(bare, 'merge-base', '--is-ancestor', concurrentVersion, versionTip);
    assert.equal(git(bare, 'show', `${versionTip}:version-only.txt`), 'version work');
    assert.equal(git(bare, 'show', `${versionTip}:base.txt`), 'resolved version and requirement');
    const versionRows = await db.select().from(thinGitDeliveries).where(eq(thinGitDeliveries.attemptId, integrated.attemptId!));
    assert.ok(versionRows.some(row => row.purpose === 'integration' && row.state === 'confirmed' && row.acceptedCommit === acceptedSnapshot!.commit));
    const [plannedGitReq] = await db.insert(requirements).values({ projectId: f.project.id, title: 'Code planner fixture', status: 'approved', createdBy: f.owner.context.actor.id }).returning();
    await db.insert(requirementRepositories).values({ requirementId: plannedGitReq!.id, repositoryId: gitRepo!.id, workingBranch: 'main', baseBranch: 'release' });
    const [gitCoordinator] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: plannedGitReq!.id, title: 'Plan code work', tags: ['worker:coordinator'], createdBy: f.owner.context.actor.id }).returning();
    const gitPlanner: ThinExecutor = { ...executor, async execute(input) {
      assert.match(input.prompt, /final integration task tagged worker:integration/);
      await writeFile(join(input.cwd, 'result.md'), 'Code plan and evidence.\n');
      await writeFile(join(input.cwd, 'plan.json'), JSON.stringify({ projectId: f.project.id, requirements: [{ key: 'current', existingId: plannedGitReq!.id, tasks: [{ key: 'work', title: 'Implement' }, { key: 'accept', title: 'Accept', tags: ['worker:acceptance'], dependsOn: ['work'] }, { key: 'integrate', title: 'Integrate', tags: ['worker:integration'], dependsOn: ['accept'] }] }] }));
      return { ok: true, reason: 'Code plan', quotaBlocked: false };
    } };
    const codePlanned = await runThinOnce({ ...opts, requirementId: plannedGitReq!.id, executor: gitPlanner, config: { ...config, nodeId: 'code-planner' } });
    assert.equal(codePlanned.taskId, gitCoordinator!.id); assert.equal(codePlanned.state, 'completed', codePlanned.reason);
    const plannedTasks = await db.select().from(tasks).where(eq(tasks.requirementId, plannedGitReq!.id));
    const planAccept = plannedTasks.find(row => row.tags?.includes('worker:acceptance'))!, planIntegration = plannedTasks.find(row => row.tags?.includes('worker:integration'))!;
    const planEdges = await db.select().from(taskDependencies).where(eq(taskDependencies.taskId, planIntegration.id));
    assert.ok(planEdges.some(edge => edge.dependsOnTaskId === planAccept.id && edge.type === 'blocks'));












  } finally { globalThis.fetch = actualFetch; }
  const [networkTask] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: req!.id, title: 'Network interruption', createdBy: f.owner.context.actor.id }).returning();
  const interrupted = await runThinOnce({ ...opts, requirementId: req!.id, config: { ...config, nodeId: 'other-node' }, executor: { ...executor, async execute(input) { await writeFile(join(input.cwd, 'result.md'), 'Local work\n'); server.close(); server.closeAllConnections(); return { ok: true, reason: 'Fixture', quotaBlocked: false } } } });
  assert.equal(interrupted.taskId, networkTask!.id);
  assert.equal(interrupted.state, 'attention');
  assert.equal((await db.query.tasks.findFirst({ where: eq(tasks.id, networkTask!.id) }))!.status, 'in_progress');
});
