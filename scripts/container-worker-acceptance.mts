import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runCommand } from '../apps/cli/src/async-command';
import { verifyCapabilityAcceptanceArtifact } from './capability-acceptance-fixture.mjs';

/** Opt-in model/runtime test only; the caller owns all disposable API/database state. */
export async function verifyContainerWorkers(options: {
  root: string; runtime: string; apiUrl: string; projectId: string; sourceId: string;
  fixture: any; toolId: string; sourceObserved: () => boolean; key: string; db: any; api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const req = createRequire(new URL('../apps/api/package.json', import.meta.url));
  const { daemons, requirementClaims, executionDelegations, mcpInvocationAudits, authAuditEvents } = req('@task-weaver/db');
  const { eq } = req('drizzle-orm');
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const image = JSON.parse(docker('image', 'inspect', 'task-weaver-api:ce-candidate-arm64'))[0].Id;
  const auth = await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'));
  assert.equal(JSON.parse(auth.toString()).auth_mode, 'chatgpt');
  const settings = await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), 'utf8');
  const model = settings.match(/^model\s*=\s*"([a-zA-Z0-9._/-]+)"/m)?.[1];
  assert.ok(model);
  const names: string[] = [], directories: string[] = [], ids = [randomUUID(), randomUUID()];
  const receipt: Record<string, unknown> = { passed: false, samePhysicalHost: true, fixtureClockAccelerated: true,
    image, modelRequested: model, actualModelOnContainerNodes: false, runtimeVersion: '0.164.0',
    runtimeSha256: createHash('sha256').update(await readFile(join(options.runtime, 'bin/codex'))).digest('hex') };
  receipt.codeModeHostSha256 = createHash('sha256').update(await readFile(join(options.runtime, 'bin/codex-code-mode-host'))).digest('hex');
  receipt.candidateCliBundleSha256 = createHash('sha256').update(await readFile(join(options.runtime, 'tw.mjs'))).digest('hex');
  const nodeCall = async (name: string, path: string, method: string, body: unknown) => {
    const text = await new Promise<string>((resolve, reject) => {
      const child = execFile('docker', ['exec', '-i', name, 'node', '-e', "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',async()=>{const x=JSON.parse(s);const r=await fetch(x.url,{method:x.method,headers:{authorization:'Bearer '+x.key,'content-type':'application/json'},body:JSON.stringify(x.body),redirect:'error'});process.stdout.write(JSON.stringify({status:r.status}))})"],
      { encoding: 'utf8', timeout: 15_000 }, (error, stdout) => error ? reject(new Error('Container protocol request failed')) : resolve(stdout));
      child.stdin!.end(JSON.stringify({ url: options.apiUrl.replace('127.0.0.1', 'host.docker.internal') + '/api/v1' + path, method, body, key: options.key }));
    });
    return JSON.parse(text);
  };
  const runDaemon = (index: number) => runCommand('docker', ['exec', names[index]!, 'node', '/runtime/tw.mjs', 'daemon', 'start',
    '--id', ids[index]!, '--project', options.projectId, '--tools', 'codex', '--workers', '1', '--think', 'fast:low', '--mode', 'polling', '--capability-execution', '--once'],
  { timeoutMs: 180_000, maxOutputBytes: 128 * 1024 });
  let first: ReturnType<typeof runDaemon> | undefined;
  let firstResult: Awaited<ReturnType<typeof runDaemon>> | undefined;
  let stage = 'prepare-nodes';
  try {
    for (let i = 0; i < 2; i++) {
      const directory = join(options.root, `full-node-${i}`);
      for (const folder of ['config', 'profile', 'output', 'home']) await mkdir(join(directory, folder), { recursive: true, mode: 0o700 });
      await writeFile(join(directory, 'profile/auth.json'), auth, { mode: 0o600 });
      await writeFile(join(directory, 'profile/config.toml'), `model = ${JSON.stringify(model)}\nmodel_reasoning_effort = "low"\n`, { mode: 0o600 });
      await writeFile(join(directory, 'config/config.json'), JSON.stringify({ apiUrl: options.apiUrl.replace('127.0.0.1', 'host.docker.internal'),
        apiKey: options.key, nodeId: `full-container-${i}`, clientId: `full-container-${i}` }), { mode: 0o600 });
      const name = `tw-full-node-${randomUUID().slice(0, 8)}`;
      docker('run', '--pull', 'never', '-d', '--name', name, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--tmpfs', '/tmp:rw,nosuid,size=256m', '--mount', `type=bind,src=${options.runtime},dst=/runtime,readonly`,
        '--mount', `type=bind,src=${directory},dst=/node`, '-e', 'HOME=/node/home', '-e', 'CODEX_HOME=/node/profile',
        '-e', 'TW_CONFIG_DIR=/node/config', '-e', 'TW_DAEMON_AGENT_TIMEOUT_MS=150000',
        '-e', 'PATH=/runtime/bin:/usr/local/bin:/usr/bin:/bin', '--entrypoint', 'node', image, '-e', 'setInterval(()=>{},1000)');
      names.push(name); directories.push(directory);
      assert.match(docker('exec', name, 'codex', '--version'), /0\.164\.0/);
      assert.match(docker('exec', name, 'node', '/runtime/tw.mjs', '--version'), /^\d+\.\d+\.\d+$/);
    }
    const requirement = await options.api(`/projects/${options.projectId}/requirements`, 'POST', { title: 'Full container worker takeover', status: 'approved',
      modelTier: 'fast', recoveryPolicy: { retrySafe: true, graceMs: 1000, maxAttempts: 1 } });
    await options.api(`/requirements/${requirement.id}/document-links`, 'POST', { documentId: options.sourceId, linkType: 'references' });
    const task = await options.api(`/projects/${options.projectId}/tasks`, 'POST', { requirementId: requirement.id, title: 'Reconstruct a source-backed quote after node loss',
      description: `Always invoke /runtime/bin/tw by its absolute path, preserving the supplied broker environment; container login shells can replace PATH. First write /node/output/worker-started.txt with the word started, then run sleep 15 before continuing. This is a disposable node-loss fixture; do not install anything or read credential files. Discover current project ${options.projectId} quote calculation Skill, customer memory and linked source; re-read the source, inspect pricing MCP schema then invoke with its exact hash. Produce /node/output/quote.json for quantity ${options.fixture.request.quantity}, exactly customer,sku,quantity,totalCents,currency,sourceRevision. Do not guess missing facts or save memories. Verify the output, then complete the task. No Git repository is linked for this case.` });
    stage = 'first-model-barrier';
    first = runDaemon(0).then(result => {
      firstResult = result;
      receipt.firstProcess = { exitCode: result.status, durationMs: result.durationMs, timedOut: result.timedOut };
      const reports: string[] = [];
      for (const line of result.stdout.split('\n')) {
        const start = line.indexOf('{');
        if (start < 0) continue;
        try {
          const event = JSON.parse(line.slice(start));
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
            reports.push(event.item.text.split(options.key).join('[redacted]').replace(/\b(?:tw[a-z]*_[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_.-]{20,})/g, '[redacted]').slice(0, 1200));
          }
        } catch { /* Only structured final messages, never reasoning or raw tools. */ }
      }
      if (reports.length) receipt.firstAgentReports = reports.slice(-1);
      if (!result.ok) {
        const diagnostic = (result.stdout + result.stderr).toLowerCase();
        receipt.firstDiagnosticCategories = ['module', 'package', 'permission', 'credential', 'network', 'git', 'unavailable', 'not found', 'invalid', 'exec']
          .filter(category => diagnostic.includes(category));
      }
      return result;
    });
    let started = false;
    for (let i = 0; i < 300; i++) {
      if (firstResult) break;
      try { await access(join(directories[0]!, 'output/worker-started.txt')); started = true; break; } catch { /* Bounded readiness poll. */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!started) {
      const current = await options.api(`/tasks/${task.id}`);
      receipt.firstTaskStatus = current.status;
      const reports = JSON.stringify([...(current.comments ?? []), ...(current.statusLogs ?? [])]).toLowerCase();
      receipt.firstTaskDiagnosticCategories = ['not found', 'permission', 'read-only', 'broker', 'unavailable', 'path', 'no such file', 'authentication', 'unauthorized', 'network']
        .filter(category => reports.includes(category));
    }
    assert.ok(started, 'First actual model worker did not reach its process barrier');
    receipt.firstActualModelBarrierObserved = true;
    const oldLane = await options.db.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, requirement.id) });
    assert.equal(oldLane.daemonId, ids[0]);
    stage = 'stop-first-node';
    docker('stop', '--time', '1', names[0]!);
    await first; first = undefined;
    await options.db.update(daemons).set({ lastHeartbeatAt: new Date(Date.now() - 5000) }).where(eq(daemons.id, ids[0]));
    await options.db.update(requirementClaims).set({ heartbeatAt: new Date(Date.now() - 5000), expiresAt: new Date(Date.now() - 1000) }).where(eq(requirementClaims.id, oldLane.id));
    await options.api(`/requirements/${requirement.id}/claim`);
    stage = 'replacement-worker';
    const second = await runDaemon(1);
    receipt.replacementProcess = { exitCode: second.status, durationMs: second.durationMs, timedOut: second.timedOut };
    assert.ok(second.ok, 'Replacement actual daemon did not complete');
    stage = 'verify-replacement-artifact';
    const artifact = JSON.parse(await readFile(join(directories[1]!, 'output/quote.json'), 'utf8'));
    verifyCapabilityAcceptanceArtifact(options.fixture, artifact);
    receipt.actualModelOnContainerNodes = true;
    assert.equal((await options.api(`/tasks/${task.id}`)).status, 'done');
    const runs = await options.db.select().from(executionDelegations).where(eq(executionDelegations.requirementId, requirement.id));
    assert.ok(runs.some((row: any) => row.daemonId === ids[1] || row.runId !== oldLane.id));
    assert.ok(runs.some((row: any) => row.runId === oldLane.id && row.revokedAt));
    const replacementDelegations = new Set(runs.filter((row: any) => row.runId !== oldLane.id).map((row: any) => row.id));
    const calls = (await options.db.select().from(mcpInvocationAudits)).filter((row: any) => replacementDelegations.has(row.credentialId) && row.toolId === options.toolId && row.outcome === 'success');
    assert.ok(calls.length > 0, 'Replacement must actually invoke the current fixture tool');
    const reads = (await options.db.select().from(authAuditEvents)).filter((row: any) => row.metadata?.requirementId === requirement.id && row.metadata?.runId !== oldLane.id && row.metadata?.capabilityAction === 'read');
    assert.ok(reads.some((row: any) => row.metadata.capabilityKind === 'memory'));
    assert.ok(reads.some((row: any) => ['skill', 'skill_package'].includes(row.metadata.capabilityKind)));
    assert.ok(options.sourceObserved(), 'Replacement source document read must be observed');
    receipt.replacementInvocationAuditIds = calls.map((row: any) => row.id);
    receipt.replacementCapabilityReadAuditIds = reads.map((row: any) => row.id);
    stage = 'old-node-return';
    docker('start', names[0]!);
    const stale = await nodeCall(names[0]!, `/daemons/${ids[0]}/execution-authority`, 'POST', { requirementId: requirement.id, runId: oldLane.id, leaseGeneration: oldLane.generation });
    assert.notEqual(stale.status, 200);
    assert.notEqual((await nodeCall(names[0]!, `/tasks/${task.id}/status`, 'PATCH', { status: 'todo', reason: 'Old node must not overwrite replacement', daemonId: ids[0], runId: oldLane.id, leaseGeneration: oldLane.generation })).status, 200);
    assert.equal((await options.api(`/tasks/${task.id}`)).status, 'done');
    receipt.passed = true; receipt.artifact = artifact; receipt.oldNodeWritesRejected = true;
    delete receipt.firstAgentReports;
    receipt.unsharedNodeDirectories = true; receipt.localWorkWasNotCopied = true;
    receipt.usage = await options.api(`/agent-usage/summary?projectId=${options.projectId}`);
  } catch (error) {
    receipt.failedStage = stage;
    receipt.failureType = error instanceof Error ? error.name : 'UnknownError';
  } finally {
    for (const name of names) docker('rm', '-f', name);
    if (first) await first;
    receipt.containersRemoved = true;
  }
  return receipt;
}
