import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resourcePostgresFixture } from '../apps/api/src/resource-postgres-fixture';
import { runCommand } from '../apps/cli/src/async-command';
import { buildAiEnvironment } from '../apps/cli/src/repository-credentials';

const synthetic = process.argv[2] === '--verify-synthetic-daemon';
assert.deepEqual(process.argv.slice(2), [synthetic ? '--verify-synthetic-daemon' : '--confirm-one-local-model-turn']);
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { createDb, runMigrations, requirementClaims } = requireApi('@task-weaver/db');
const { eq } = requireApi('drizzle-orm');
const { serve } = requireApi('@hono/node-server');
const root = await mkdtemp(join(tmpdir(), 'tw-real-console-'));
const container = `tw-real-console-${randomUUID().slice(0, 8)}`;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
let database: any, server: any, created = false, revoke: (() => Promise<void>) | undefined;
let daemon: Promise<Awaited<ReturnType<typeof runCommand>>> | undefined;
const stop = new AbortController();
const receipt: Record<string, unknown> = { schemaVersion: 1, scope: synthetic ? 'actual daemon with a synthetic executor; no model spend' : 'one existing host-native Codex daemon/model; disposable database; no Git, downloads or deployment', passed: false, modelTurns: 0, money: null };
let stage = 'prepare';
try {
  const workspace = join(root, 'workspace'), config = join(root, 'config'), bin = join(root, 'bin'), profile = join(root, 'provider'), home = join(root, 'home');
  for (const dir of [workspace, config, bin, profile, home]) await mkdir(dir, { mode: 0o700 });
  let model = 'fixture';
  if (!synthetic) {
    const native = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const authentication = await readFile(join(native, 'auth.json'));
    assert.equal(JSON.parse(authentication.toString('utf8')).auth_mode, 'chatgpt');
    const settings = await readFile(join(native, 'config.toml'), 'utf8');
    const provider = settings.match(/^model_provider\s*=\s*"([^"\n]+)"/m)?.[1];
    assert(!provider || provider === 'openai');
    model = settings.match(/^model\s*=\s*"([^"\n]+)"/m)?.[1] ?? '';
    assert(model && /^[a-zA-Z0-9._/-]+$/.test(model));
    await writeFile(join(profile, 'auth.json'), authentication, { mode: 0o600 });
    await writeFile(join(profile, 'config.toml'), `model = ${JSON.stringify(model)}\nmodel_reasoning_effort = "low"\n`, { mode: 0o600 });
    receipt.requestedModel = model;
    const version = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(version.status, 0); assert.match(version.stdout, /^codex-cli [0-9.]+/); receipt.clientVersion = version.stdout.trim();
  }
  docker('image', 'inspect', 'pgvector/pgvector:0.8.6-pg16-bookworm');
  docker('run', '--pull=never', '--rm', '-d', '--name', container, '-e', 'POSTGRES_DB=tw_console_real', '-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_PASSWORD=fixture-only', '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.6-pg16-bookworm'); created = true;
  for (let i = 0; ; i++) {
    if (spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'fixture', '-d', 'tw_console_real'], { stdio: 'ignore' }).status === 0) break;
    assert(i < 100); await pause(200);
  }
  const port = JSON.parse(docker('inspect', container))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const databaseUrl = `postgres://fixture:fixture-only@127.0.0.1:${port}/tw_console_real`;
  stage = 'migrate'; await runMigrations(databaseUrl); database = createDb(databaseUrl);
  let handler: (r: Request) => Promise<Response> | Response = () => new Response(null, { status: 503 });
  server = serve({ hostname: '127.0.0.1', port: 0, fetch: (r: Request) => handler(r) }); await once(server, 'listening');
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  stage = 'identity-fixture'; const f = await resourcePostgresFixture(database, databaseUrl, { apiOrigin: apiUrl });
  let uploads = 0; let rejected = 0; let accepted = 0;
  handler = async r => {
    const output = /\/worker-console\/[^/]+\/[^/]+\/response$/.test(new URL(r.url).pathname);
    if (output) uploads++;
    const response = await f.app.fetch(r);
    if (output) { if (response.ok) accepted++; else rejected++; }
    return response;
  };
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await f.app.request(`/api/v1${path}`, { method, headers: f.owner.headers, body: body === undefined ? undefined : JSON.stringify(body) });
    assert(response.ok, `Fixture request failed: ${method} ${path} (${response.status})`); return response.json() as Promise<any>;
  };
  stage = 'agent-fixture'; const agent = await f.identity.createAgent(f.owner.headers, { displayName: 'Console model fixture' });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: 'maintainer', explicitPermissions: [] });
  const key = await f.identity.issueKey(f.owner.headers, agent.id, { name: 'One console model turn', expiresAt: null, grants: [{ scope: 'project', projectId: f.project.id, permissions: ['resource.read', 'resource.write', 'execution.run'] }] });
  revoke = async () => { await f.identity.revokeKey(f.owner.headers, agent.id, key.id); const response = await f.app.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${key.rawKey}` } }); assert.equal(response.status, 401); receipt.revokedCredentialDenied = true; };
  await writeFile(join(config, 'config.json'), JSON.stringify({ apiUrl, apiKey: key.rawKey, actorId: agent.id, clientId: randomUUID(), nodeId: randomUUID() }), { mode: 0o600 });
  const cli = fileURLToPath(new URL('../apps/cli/src/index.ts', import.meta.url));
  const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
  await writeFile(join(bin, 'tw'), `#!/bin/sh\nexec ${quote(tsx)} ${quote(cli)} "$@"\n`, { mode: 0o700 });
  stage = 'requirement-fixture'; const requirement = await api(`/projects/${f.project.id}/requirements`, 'POST', { title: 'One actual console process', status: 'approved', modelTier: 'fast' });
  const script = join(workspace, 'emit.cjs');
  // Runtime-generated values stay out of task descriptions and durable platform records.
  await writeFile(script, `const fs=require('node:fs'),crypto=require('node:crypto');const a='before-'+crypto.randomUUID(),b='live-'+crypto.randomUUID();console.log(a);console.error('stderr diagnostic');fs.writeFileSync(${JSON.stringify(join(workspace, 'ready.json'))},JSON.stringify({a,b}));\n`, { mode: 0o600 });
  const liveScript = join(workspace, 'emit-live.cjs');
  await writeFile(liveScript, `const fs=require('node:fs');const {b}=JSON.parse(fs.readFileSync(${JSON.stringify(join(workspace, 'ready.json'))},'utf8'));fs.writeFileSync(${JSON.stringify(join(workspace, 'live-started'))},'ready');setTimeout(()=>console.log(b),8000);\n`, { mode: 0o600 });
  const task = await api(`/projects/${f.project.id}/tasks`, 'POST', { requirementId: requirement.id, title: 'Emit synthetic console diagnostics', description: `Run node ${script} once, letting it finish, then run node ${liveScript} once and let it finish. Then run node -e 'setTimeout(()=>{},12000)' to leave a bounded observation window, and mark this task done. Do not read the script or ready.json, inspect credentials, install anything, or copy emitted text into Task Weaver comments/status reasons. No other work is needed.` });
  if (synthetic) {
    const fake = join(bin, 'codex');
    await writeFile(fake, `#!/usr/bin/env node
const {spawnSync,execFileSync}=require('node:child_process');
if(process.argv.includes('--version')){console.log('codex-cli 0.164.0-fixture');process.exit(0)}
if(!process.argv.includes('exec')||process.argv.includes('--help'))process.exit(0);
console.error('fixture stderr diagnostic');
for(const script of ${JSON.stringify([script, liveScript])}){
 const p=spawnSync(process.execPath,[script],{encoding:'utf8'});if(p.status!==0)process.exit(1);
 console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:p.stdout+p.stderr}}));
}
setTimeout(()=>{execFileSync('tw',['task','status',process.env.TW_TASK_ID,'done','--reason','Synthetic console fixture completed'],{stdio:'ignore'});},12000);
`, { mode: 0o700 });
  }
  stage = synthetic ? 'synthetic-daemon' : 'model'; receipt.modelTurns = synthetic ? 0 : 1;
  const env = buildAiEnvironment(process.env, { HOME: home, CODEX_HOME: profile, TW_CODEX_HOME: profile, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, TW_CONFIG_DIR: config, TW_ARTIFACT_ROOT: join(root, 'artifacts'), TW_DAEMON_AGENT_TIMEOUT_MS: '120000' });
  // Supervisor configuration is isolated; the child launcher preserves its delegated broker env.
  daemon = runCommand(tsx, [cli, 'daemon', 'start', '--tools', 'codex', '--project', f.project.id, '--workers', '1', '--mode', 'polling', '--model', `fast:${model}`, '--think', 'fast:low', '--once'], { cwd: workspace, env, timeoutMs: 150_000, maxOutputBytes: 64 * 1024, signal: stop.signal });
  let markers: { a: string; b: string } | undefined;
  for (let i = 0; i < 180; i++) {
    try { markers = JSON.parse(await readFile(join(workspace, 'ready.json'), 'utf8')); await readFile(join(workspace, 'live-started')); break; } catch { await pause(500); }
  }
  assert(markers, 'Executor did not start the synthetic command within deadline');
  await readFile(join(workspace, 'live-started'));
  assert.equal(uploads, 0); receipt.bodyUploadsWithoutDemand = uploads;
  // Codex emits command output when its command completes, not as nested process bytes arrive.
  await pause(300);
  const claim = await database.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, requirement.id) });
  assert(claim?.id && claim.generation != null, 'Actual worker is no longer current');
  const target = { requirementId: requirement.id, taskId: task.id, runId: claim.id, leaseGeneration: claim.generation, workerIndex: Number(claim.workerIndex) };
  const open = await api('/worker-console/open', 'POST', target);
  const sessionPath = (id: string, action: string) => `/worker-console/${id.split('.')[0]}/${id}/${action}`;
  let snapshotText = '';
  for (let i = 0; i < 12; i++) {
    const read = await api(sessionPath(open.id, 'read'), 'POST', { follow: false });
    if (read.batch) { snapshotText = read.batch.frames.map((x: any) => x.text).join(''); break; }
    await pause(300);
  }
  assert(snapshotText.includes(markers!.a), 'Recent actual model command output was not captured');
  receipt.recentSnapshotVerified = true;
  const following = await api('/worker-console/open', 'POST', { ...target, follow: true });
  let followed = false;
  for (let i = 0; i < 35; i++) {
    const read = await api(sessionPath(following.id, 'read'), 'POST', { follow: true });
    if (read.batch?.frames.some((x: any) => x.text.includes(markers!.b))) { followed = true; break; }
    await pause(300);
  }
  assert(followed); receipt.followResponseVerified = true;
  await api(sessionPath(following.id, 'cancel'), 'POST', {});
  await pause(3000); const afterCancellation = uploads; await pause(2500);
  assert.equal(uploads, afterCancellation); receipt.noFurtherUploadsAfterLastCancellation = true;
  const result = await daemon; daemon = undefined;
  receipt.process = { ok: result.ok, durationMs: result.durationMs, timedOut: result.timedOut, exitCode: result.status };
  assert(!result.stdout.includes(markers!.a) && !result.stdout.includes(markers!.b) && !result.stderr.includes(markers!.a) && !result.stderr.includes(markers!.b), 'Console bodies entered daemon operational output');
  receipt.daemonOperationalOutputAbsent = true;
  receipt.taskStatus = (await api(`/tasks/${task.id}`)).status;
  assert(result.ok && receipt.taskStatus === 'done', 'Observation must not prevent task completion');
  const tables = await database.$client`SELECT tablename FROM pg_tables WHERE schemaname = 'task_weaver'`;
  assert(tables.length > 20);
  for (const { tablename } of tables) {
    const rows = await database.$client.unsafe(`SELECT row_to_json(t)::text AS body FROM "task_weaver"."${tablename.replaceAll('"', '""')}" t`);
    assert(!rows.some((row: any) => String(row.body).includes(markers!.a) || String(row.body).includes(markers!.b)), 'Output sentinel entered a durable table');
  }
  receipt.durableOutputAbsent = true; receipt.outputUploadRequests = uploads; receipt.acceptedBatches = accepted; receipt.rejectedBatches = rejected;
  receipt.usage = await api(`/agent-usage/summary?projectId=${f.project.id}`);
  receipt.passed = true;
} catch (error) {
  receipt.failedStage = stage; receipt.failureType = error instanceof Error ? error.name : 'UnknownError';
  const code = (error as { code?: unknown })?.code; if (typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code)) receipt.failureCode = code;
  // Only our fixed assertion messages are exported; provider/HTTP output is never printed.
  if (error instanceof assert.AssertionError) receipt.assertion = error.message.slice(0, 250);
  process.exitCode = 1;
} finally {
  const cleanupFailure = () => { receipt.cleanupFailed = true; receipt.passed = false; process.exitCode = 1; };
  stop.abort(); if (daemon) await daemon.catch(() => undefined);
  if (revoke) await revoke().catch(cleanupFailure);
  if (server) try { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } catch { cleanupFailure(); }
  if (database) try { await database.$client.end(); } catch { cleanupFailure(); }
  if (created) try { docker('rm', '-f', container); receipt.databaseRemoved = true; } catch { cleanupFailure(); }
  try { await rm(root, { recursive: true, force: true }); receipt.temporaryProfileAndFilesRemoved = true; } catch { cleanupFailure(); }
  console.log(JSON.stringify(receipt, null, 2));
}
