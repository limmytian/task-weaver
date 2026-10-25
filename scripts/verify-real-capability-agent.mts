import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resourcePostgresFixture } from '../apps/api/src/resource-postgres-fixture';
import { mcpPool } from '../apps/api/src/mcp-pool';
import { runCommand } from '../apps/cli/src/async-command';
import { CodexUsageCollector } from '../apps/cli/src/agent-usage';
import { buildAiEnvironment } from '../apps/cli/src/repository-credentials';
import { createCapabilityAcceptanceFixture, verifyCapabilityAcceptanceArtifact } from './capability-acceptance-fixture.mjs';

const fixtureOnly = process.argv[2] === '--verify-fixture-only';
assert.deepEqual(process.argv.slice(2), [fixtureOnly ? '--verify-fixture-only' : '--confirm-one-real-external-agent']);
const daemonMode = process.env.TW_ACCEPTANCE_LAUNCH_MODE === 'daemon-codex';
const emptyExternal = process.env.TW_ACCEPTANCE_LAUNCH_MODE === 'external-codex-empty';
assert.ok(!process.env.TW_ACCEPTANCE_LAUNCH_MODE || daemonMode || emptyExternal, 'Unknown launch mode');
const scenario = process.env.TW_ACCEPTANCE_CASE ?? 'useful';
const gitRemote = process.env.TW_ACCEPTANCE_GIT_URL ? new URL(process.env.TW_ACCEPTANCE_GIT_URL) : undefined;
assert.ok(!gitRemote || (daemonMode && scenario === 'useful' && gitRemote.protocol === 'https:' && !gitRemote.username && !gitRemote.password && !gitRemote.search && !gitRemote.hash), 'Remote Git requires explicitly authorized private HTTPS daemon useful case');
const gitMain = process.env.TW_ACCEPTANCE_GIT_MAIN;
if (gitRemote) assert.match(gitMain ?? '', /^[a-f0-9]{40,64}$/);
const gitBranch = `acceptance/worker-${randomUUID()}`;
assert.ok(['useful', 'irrelevant', 'replan'].includes(scenario), 'Unknown acceptance case');
assert.ok(scenario !== 'replan' || daemonMode, 'Replan requires the actual daemon');
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { createDb, runMigrations, authAuditEvents, mcpInvocationAudits, projectMemberships, executionDelegations, executionControls } = requireApi('@task-weaver/db');
const { and, eq } = requireApi('drizzle-orm');
const { createResourceServices, registerSkillPackageSchema, registerMcpServerSchema, skillPackageStorageService } = requireApi('@task-weaver/core');
const { serve } = requireApi('@hono/node-server');
const { Server } = requireApi('@modelcontextprotocol/sdk/server/index.js');
const { WebStandardStreamableHTTPServerTransport } = requireApi('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = requireApi('@modelcontextprotocol/sdk/types.js');
const fixture = process.env.TW_ACCEPTANCE_FIXTURE_FILE
  ? JSON.parse(await readFile(process.env.TW_ACCEPTANCE_FIXTURE_FILE, 'utf8')) : createCapabilityAcceptanceFixture();
const root = await mkdtemp(join(tmpdir(), 'tw-real-capability-agent-'));
const workspace = join(root, 'workspace'), config = join(root, 'config'), bin = join(root, 'bin');
const container = `tw-real-agent-${randomUUID().slice(0, 8)}`;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const receipt: Record<string, unknown> = {
  schemaVersion: 1, mode: fixtureOnly ? 'fixture-validation' : daemonMode ? 'actual-daemon-worker' : 'independent-native-profile-cli-agent',
  provider: daemonMode || emptyExternal ? 'codex' : 'agy', scenario, resolvedModel: null,
  sourceModules: { core: requireApi.resolve('@task-weaver/core'), db: requireApi.resolve('@task-weaver/db') },
  fixtureCanonicalSha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
  artifactCorrect: false, capabilityAdoptionVerified: false, daemonVerified: false,
  emptyWorkspace: true, emptyPersonalSkillDirectory: emptyExternal, slashExpansionDisabled: !daemonMode && !emptyExternal,
  providerAuthenticationCopied: emptyExternal,
  providerProfileState: 'provider_managed_records_may_remain',
  modelCost: null, passed: false, cleanup: { database: false, files: false },
};
let database: ReturnType<typeof createDb> | undefined;
let apiServer: any, toolServer: any, registeredServerId: string | undefined;
let revokeCredential: (() => Promise<void>) | undefined;
let createdContainer = false;
let gitCleanupNeeded = false;
let trustedGitConfig: string | undefined;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const trustedGit = async (args: string[]) => {
  const result = await runCommand('git', args, { env: { ...process.env, ...(trustedGitConfig ? { GIT_CONFIG_GLOBAL: trustedGitConfig, GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '0' } : {}), GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 30_000, maxOutputBytes: 65536 });
  assert.ok(result.ok && !result.outputTruncated, 'Trusted remote Git verification failed');
  return result.stdout.trim();
};
const previousStorage = process.env.SKILL_PACKAGE_STORAGE_DIR;
let stage = 'prepare';
try {
  for (const dir of [workspace, config, bin]) await mkdir(dir, { mode: 0o700 });
  if (gitRemote) {
    const credentialText = execFileSync('git', ['-c', 'credential.useHttpPath=false', 'credential', 'fill'], {
      input: `protocol=https\nhost=${gitRemote.host}\n\n`, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const fields = Object.fromEntries(credentialText.trim().split('\n').map(line => {
      const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
    }));
    assert.ok(fields.username && fields.password, 'Existing Git credential is unavailable');
    const secretPath = join(root, 'trusted-git-credential.json'), helper = join(root, 'trusted-git-helper.cjs');
    await writeFile(secretPath, JSON.stringify({ username: fields.username, password: fields.password }), { mode: 0o600 });
    await writeFile(helper, `const fs=require('node:fs');if(process.argv[2]!=='get')process.exit(0);const input=Object.fromEntries(fs.readFileSync(0,'utf8').trim().split('\\n').map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}));if(input.protocol!=='https'||input.host!==${JSON.stringify(gitRemote.host)}||(input.path||'').toLowerCase()!==${JSON.stringify(gitRemote.pathname.slice(1).toLowerCase())})process.exit(0);const c=JSON.parse(fs.readFileSync(${JSON.stringify(secretPath)},'utf8'));process.stdout.write('username='+c.username+'\\npassword='+c.password+'\\n');\n`, { mode: 0o600 });
    for (const input of [`protocol=https\nhost=${gitRemote.host}\npath=unrelated/repository.git\n\n`,
      `protocol=https\nhost=example.invalid\npath=${gitRemote.pathname.slice(1)}\n\n`,
      `protocol=http\nhost=${gitRemote.host}\npath=${gitRemote.pathname.slice(1)}\n\n`]) {
      assert.equal(execFileSync(process.execPath, [helper, 'get'], { input, encoding: 'utf8', timeout: 5000 }), '');
    }
    for (const action of ['store', 'erase']) {
      assert.equal(execFileSync(process.execPath, [helper, action], { input: '', encoding: 'utf8', timeout: 5000 }), '');
    }
    receipt.credentialBridgeRejectsOtherResources = true;
    receipt.credentialBridgeIgnoresWrites = true;
    const trustedConfig = join(root, 'trusted-gitconfig');
    await writeFile(trustedConfig, `[credential]\nuseHttpPath = true\nhelper = ${JSON.stringify(`!${shellQuote(process.execPath)} ${shellQuote(helper)}`)}\n`, { mode: 0o600 });
    trustedGitConfig = trustedConfig;
    receipt.exactRepositoryCredentialBridge = true;
    assert.equal((await trustedGit(['ls-remote', gitRemote.href, 'refs/heads/main'])).split(/\s/)[0], gitMain);
    receipt.exactCredentialRemoteReadVerified = true;
  }
  process.env.SKILL_PACKAGE_STORAGE_DIR = join(root, 'packages');
  docker('image', 'inspect', 'pgvector/pgvector:0.8.6-pg16-bookworm');
  docker('run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_DB=tw_real_capability_agent_e2e', '-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_PASSWORD=fixture-only', '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.6-pg16-bookworm');
  createdContainer = true;
  for (let i = 0; ; i++) {
    try { docker('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'fixture', '-d', 'tw_real_capability_agent_e2e'); break; }
    catch { assert.ok(i < 100, 'Disposable database did not become ready'); await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  const port = JSON.parse(docker('inspect', container))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const databaseUrl = `postgres://fixture:fixture-only@127.0.0.1:${port}/tw_real_capability_agent_e2e`;
  stage = 'migrate';
  const print = console.log;
  console.log = (...values: unknown[]) => console.error(...values);
  try { await runMigrations(databaseUrl); } finally { console.log = print; }
  database = createDb(databaseUrl);
  let handler: (request: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });
  apiServer = serve({ hostname: '127.0.0.1', port: 0, fetch: (request: Request) => handler(request) });
  await once(apiServer, 'listening');
  const apiUrl = `http://127.0.0.1:${apiServer.address().port}`;
  const f = await resourcePostgresFixture(database, databaseUrl, { apiOrigin: apiUrl });
  let clientKey: string | undefined;
  const observableReads = new Map<string, { kind: string; assetId: string }>();
  const httpObservations: Array<Record<string, unknown>> = [];
  let changeObservedSource: ((token: string) => Promise<void>) | undefined;
  let replanned = false;
  let revisedSourceHash: string | undefined;
  let modelCapabilityRequests = 0;
  handler = async (request: Request) => {
    const response = await f.app.fetch(request);
    const fixtureClient = clientKey && request.headers.get('authorization') === `Bearer ${clientKey}`;
    // A successful API response has already verified the scoped delegation.
    const fixtureChild = daemonMode && stage === 'model' && /^Bearer twd_/.test(request.headers.get('authorization') ?? '');
    if (stage === 'model' && (fixtureClient || fixtureChild)
      && /^\/api\/v1\/(context|memories|mcp|documents)(?:\/|$)/.test(new URL(request.url).pathname)) modelCapabilityRequests++;
    const selected = observableReads.get(new URL(request.url).pathname);
    if (selected && response.ok && request.method === 'GET' && (fixtureClient || fixtureChild)) {
      const value = await response.clone().json() as { content?: unknown; version?: unknown; sourceFreshness?: unknown; items?: Array<{ id?: unknown; content?: unknown; version?: unknown; sourceFreshness?: unknown }> };
      const content = selected.kind === 'memory_search' ? value.items?.find(item => item.id === selected.assetId) : value;
      if (typeof content?.content === 'string' && Buffer.byteLength(content.content) <= 32768) httpObservations.push({
        evidenceSource: 'harness_http_response', ...selected, kind: selected.kind === 'memory_search' ? 'memory' : selected.kind,
        action: selected.kind === 'memory_search' ? 'content_returned_by_search' : 'read',
        contentSha256: createHash('sha256').update(content.content).digest('hex'),
        version: typeof content.version === 'string' || typeof content.version === 'number' ? content.version : null,
        sourceFreshness: ['current', 'changed', 'not_applicable'].includes(String(content.sourceFreshness)) ? content.sourceFreshness : null,
      });
    }
    if (scenario === 'replan' && fixtureChild && response.ok && selected?.kind === 'source_document' && !replanned && changeObservedSource) {
      replanned = true;
      await changeObservedSource(request.headers.get('authorization')!);
    }
    return response;
  };
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await f.app.request(`/api/v1${path}`, { method, headers: f.owner.headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) receipt.rejectedFixtureRequest = { method, path, status: response.status };
    assert.ok(response.ok, `Fixture API rejected ${method} ${path} (${response.status})`);
    return response.json() as Promise<any>;
  };
  stage = 'seed';
  // Seed only this disposable database; the service correctly rejects self-grants.
  await database.update(projectMemberships).set({ explicitPermissions: ['mcp.invoke'] })
    .where(and(eq(projectMemberships.projectId, f.project.id), eq(projectMemberships.actorId, f.owner.context.actor.id)));
  stage = 'seed-source';
  const source = await api('/documents', 'POST', { projectId: f.project.id, ...fixture.source });
  stage = 'seed-skills';
  const skill = await api('/documents', 'POST', { projectId: f.project.id, ...fixture.skill, docType: 'skill' });
  await api('/documents', 'POST', { projectId: f.project.id, ...fixture.distractor, docType: 'skill' });
  stage = 'seed-memory';
  const memory = await api('/memories', 'POST', { projectId: f.project.id, ...fixture.memory,
    entityType: 'document', entityId: source.id, confirmed: true, idempotencyKey: randomUUID(),
    provenance: { origin: 'reviewed_source', sourceUpdatedAt: source.updatedAt } });
  stage = 'seed-package';
  const services = createResourceServices(f.owner.context);
  const pkg = await services.skillPackageService.registerPackage(database, registerSkillPackageSchema.parse({ projectId: f.project.id,
    name: 'Canonical sample quote calculation', version: '1.0.0',
    files: [{ path: 'SKILL.md', contentBase64: Buffer.from(fixture.skill.content).toString('base64') }] }),
    f.owner.context.actor, new skillPackageStorageService.LocalSkillPackageStorageAdapter(process.env.SKILL_PACKAGE_STORAGE_DIR));
  stage = 'seed-mcp';
  let actualCalls = 0;
  toolServer = serve({ hostname: '127.0.0.1', port: 0, fetch: async (request: Request) => {
    const server = new Server({ name: 'sample-quote-price', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: fixture.tool.name, description: fixture.tool.description, inputSchema: fixture.tool.inputSchema }] }));
    server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      assert.equal(request.params.name, fixture.tool.name);
      assert.deepEqual(request.params.arguments, fixture.tool.input);
      actualCalls++;
      return { content: [{ type: 'text', text: JSON.stringify(fixture.tool.result) }] };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try { return await transport.handleRequest(request); } finally { await server.close(); }
  } });
  await once(toolServer, 'listening');
  const registered = await services.mcpRegistryService.registerServer(database, registerMcpServerSchema.parse({ projectId: f.project.id,
    name: 'Sample quote pricing', transport: 'streamable-http', config: { url: `http://127.0.0.1:${toolServer.address().port}/mcp` }, active: true, readOnly: true }), f.owner.context.actor);
  registeredServerId = registered.id;
  const [tool] = await services.mcpRegistryService.syncTools(database, registered.id, mcpPool);
  // Sync never trusts a remote server to grant its tools a read-only declaration.
  await api(`/mcp/tools/${tool.id}/authorization`, 'PATCH', { readOnly: true, targetProjectArgument: null });
  stage = 'seed-agent';
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: 'Independent real agy fixture' });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: daemonMode ? 'maintainer' : 'member', explicitPermissions: ['mcp.invoke'] });
  const key = await f.identity.issueKey(f.owner.headers, agent.id, { name: 'Bounded independent client', expiresAt: new Date(Date.now() + 600_000).toISOString(),
    grants: [{ scope: 'project', projectId: f.project.id, permissions: daemonMode ? ['resource.read', 'resource.write', 'execution.run', 'mcp.invoke'] : ['resource.read', 'mcp.invoke'] },
      ...(gitRemote ? [{ scope: 'personal', actorId: f.owner.context.actor.id, permissions: ['resource.read'] }] : [])] });
  revokeCredential = async () => {
    await f.identity.revokeKey(f.owner.headers, agent.id, key.id);
    const denied = await f.app.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${key.rawKey}` } });
    receipt.revokedCredentialDenied = denied.status === 401;
    assert.equal(denied.status, 401, 'Revoked fixture credential must be rejected');
  };
  clientKey = key.rawKey;
  observableReads.set(`/api/v1/documents/${source.id}`, { kind: 'source_document', assetId: source.id });
  observableReads.set(`/api/v1/context/${skill.id}`, { kind: 'skill', assetId: skill.id });
  observableReads.set(`/api/v1/documents/${skill.id}`, { kind: 'skill', assetId: skill.id });
  if (pkg.primaryDocumentId) {
    observableReads.set(`/api/v1/context/${pkg.primaryDocumentId}`, { kind: 'skill', assetId: pkg.primaryDocumentId });
    observableReads.set(`/api/v1/documents/${pkg.primaryDocumentId}`, { kind: 'skill', assetId: pkg.primaryDocumentId });
  }
  observableReads.set(`/api/v1/memories/${memory.id}`, { kind: 'memory', assetId: memory.id });
  observableReads.set('/api/v1/memories/search', { kind: 'memory_search', assetId: memory.id });
  observableReads.set(`/api/v1/context/packages/${pkg.id}/read`, { kind: 'skill_package', assetId: pkg.id });
  await writeFile(join(config, 'config.json'), JSON.stringify({ apiUrl, apiKey: key.rawKey, actorId: agent.id, clientId: `fixture-${randomUUID()}`, nodeId: `fixture-${randomUUID()}` }), { mode: 0o600 });
  const scopedCli = join(bin, 'tw');
  const tsconfig = process.env.TSX_TSCONFIG_PATH;
  await writeFile(scopedCli, `#!/bin/sh\nunset TW_API_KEY TW_API_URL TW_CLIENT_ID TW_NODE_ID\nexport TW_CONFIG_DIR=${shellQuote(config)}\n${tsconfig ? `export TSX_TSCONFIG_PATH=${shellQuote(tsconfig)}\n` : ''}exec ${shellQuote(fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)))} ${shellQuote(fileURLToPath(new URL('../apps/cli/src/index.ts', import.meta.url)))} "$@"\n`, { mode: 0o700 });
  const env = buildAiEnvironment(process.env, { HOME: homedir(), PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, TW_CONFIG_DIR: config });
  stage = 'verify-cli-subject';
  const whoami = await runCommand(scopedCli, ['auth', 'whoami', '--json'], { cwd: workspace, env, timeoutMs: 15_000 });
  assert.ok(whoami.ok, 'Scoped CLI could not authenticate before model launch');
  assert.equal(JSON.parse(whoami.stdout).actor.id, agent.id, 'Scoped CLI resolved the wrong subject');
  const discovery = await runCommand(scopedCli, ['mcp', 'tools', '--project', f.project.id, '--json'], { cwd: workspace, env, timeoutMs: 15_000 });
  assert.ok(discovery.ok && JSON.parse(discovery.stdout).items.some((item: { id: string }) => item.id === tool.id), 'The exact client must discover the fixture tool before spending on a model');
  receipt.preflightToolDiscoverable = true;
  if (fixtureOnly) {
    if (daemonMode) {
      const requirement = await api(`/projects/${f.project.id}/requirements`, 'POST', { title: 'Bounded input visibility fixture', status: 'approved' });
      const task = await api(`/projects/${f.project.id}/tasks`, 'POST', { requirementId: requirement.id, title: 'Read the declared fixture source' });
      await api(`/requirements/${requirement.id}/document-links`, 'POST', { documentId: source.id, linkType: 'references' });
      const parentHeaders = new Headers({ authorization: `Bearer ${key.rawKey}`, 'content-type': 'application/json' });
      const parentApi = async (path: string, method: string, body?: unknown, headers = parentHeaders) => {
        const response = await f.app.request(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        assert.ok(response.ok, `Bounded fixture prerequisite failed: ${method} ${path} (${response.status})`);
        return response.json() as Promise<any>;
      };
      const daemonId = randomUUID();
      await parentApi('/daemons/register', 'POST', { id: daemonId, nodeId: 'bounded-fixture-node', name: 'Bounded fixture prerequisite',
        role: 'executor', capabilities: ['codex', 'executor:codex', 'live-plan-v1'] });
      const lane = await parentApi(`/daemons/${daemonId}/apply-requirement`, 'POST', { projectId: f.project.id, workerIndex: 0 });
      assert.equal(lane.requirement.id, requirement.id);
      const access = await parentApi(`/daemons/${daemonId}/delegations`, 'POST', { requirementId: requirement.id, taskId: task.id,
        workerIndex: 0, runId: lane.runId, leaseGeneration: lane.leaseGeneration, capabilityExecution: true });
      const child = new Headers({ authorization: `Bearer ${access.token}` });
      assert.equal((await parentApi(`/documents/${source.id}`, 'GET', undefined, child)).id, source.id);
      assert.equal((await parentApi(`/memories/${memory.id}`, 'GET', undefined, child)).id, memory.id);
      const visible = await parentApi(`/mcp/tools/search?intent=*&projectId=${f.project.id}`, 'GET', undefined, child);
      assert.ok(visible.items.some((item: { id: string }) => item.id === tool.id));
      await parentApi(`/daemons/${daemonId}/delegations/${access.delegation.id}`, 'DELETE');
      await parentApi(`/requirements/${requirement.id}/release`, 'POST', { daemonId, runId: lane.runId, leaseGeneration: lane.leaseGeneration });
      receipt.boundedFixtureReady = true;
    }
    receipt.fixtureReady = true;
    receipt.passed = true;
  } else {
    const usefulPrompt = `Create quote.json in the current working directory for the project's current sample quote customer and item, quantity ${fixture.request.quantity}. Obtain current customer/source, relevant project calculation guidance and current external pricing through Task Weaver. Re-read the linked source before relying on a memory. Start with context bootstrap --json; use context search, memory search and mcp search with --project ${f.project.id} only as relevant. Inspect selected content with context get, memory get and doc get; inspect a tool with mcp tool before mcp call with --schema-hash. Use focused subcommand help as needed. Return exactly these JSON fields: customer, sku, quantity, totalCents, currency, sourceRevision. Do not guess missing facts. No memory writes are requested. Verify the produced file. This project contains unrelated shipping guidance; use it only if relevant. Stop and report a blocker after two command failures; do not repeat failing commands.`;
    const work = scenario !== 'irrelevant' ? usefulPrompt : fixture.irrelevant.prompt;
    const clientGuidance = emptyExternal ? 'Personal skill directories start empty; no personal guides, plugins or history were copied.' : 'Local slash commands and skill expansion are disabled.';
    const prompt = `You are an independent CLI client in an isolated disposable test project ${f.project.id}. For every Task Weaver command use the absolute executable ${scopedCli}; do not use a bare tw command, another client or another configuration. That wrapper pins the scoped test configuration even when a login shell changes its environment. Do not read credentials, other projects, home-directory files, or install anything. ${clientGuidance}\n${work}`;
    stage = 'model';
    const requestedModel = process.env.TW_ACCEPTANCE_AGY_MODEL;
    receipt.requestedModel = requestedModel ?? null;
    receipt.freshProviderProjectRequested = !daemonMode && !emptyExternal;
    let daemonRequirement: { id: string } | undefined;
    let daemonTask: { id: string } | undefined;
    let result: Awaited<ReturnType<typeof runCommand>>;
    if (daemonMode) {
      const workerBin = join(root, 'worker-bin');
      await mkdir(workerBin, { mode: 0o700 });
      // This launcher must retain the child's broker environment, never pin the supervisor key.
      await writeFile(join(workerBin, 'tw'), `#!/bin/sh\nexec ${shellQuote(fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)))} ${shellQuote(fileURLToPath(new URL('../apps/cli/src/index.ts', import.meta.url)))} "$@"\n`, { mode: 0o700 });
      daemonRequirement = await api(`/projects/${f.project.id}/requirements`, 'POST', { title: 'Actual daemon capability fixture', status: 'approved', modelTier: 'fast', ...(gitRemote ? { workflowPreset: 'git_branch' } : {}) });
      daemonTask = await api(`/projects/${f.project.id}/tasks`, 'POST', { requirementId: daemonRequirement!.id, title: 'Produce the verified sample quote',
        description: `${work}\nWrite the final ${scenario !== 'irrelevant' ? 'quote.json' : 'arithmetic.json'} artifact at ${workspace}. Use ordinary tw commands with the supplied worker broker, never another configuration. Do not read home-directory files or credentials. Do not install dependencies.` });
      await api(`/requirements/${daemonRequirement!.id}/document-links`, 'POST', { documentId: source.id, linkType: 'references' });
      let repository: { id: string } | undefined;
      if (gitRemote) {
        assert.equal((await trustedGit(['ls-remote', gitRemote.href, 'refs/heads/main'])).split(/\s/)[0], gitMain);
        const path = gitRemote.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
        assert.equal(path.length, 2);
        repository = await api('/repositories', 'POST', { provider: 'generic', host: gitRemote.host, namespace: path[0], name: path[1],
          httpsCloneUrl: gitRemote.href, defaultBranch: 'main', visibility: 'private', ownerId: f.owner.context.actor.id, ownerType: 'human',
          authPolicy: { allowedTransports: ['https'], preferredTransport: 'https', allowedOperations: ['read', 'push'], allowNativeDefault: true } });
        await api(`/requirements/${daemonRequirement!.id}/repositories`, 'POST', { repositoryId: repository!.id, baseBranch: 'main', workingBranch: gitBranch });
        const current = await api(`/tasks/${daemonTask!.id}`);
        await api(`/tasks/${daemonTask!.id}`, 'PATCH', { expectedVersion: current.version, description: `${current.description}\nAlso write the same verified quote.json inside the linked repository worktree. Use the frozen manifest to find its path and use tw execution git fetch/verify for that repository before substantive edits and before completion. Do not push or commit; the trusted daemon owns signed commit and push. Do not change main.` });
        gitCleanupNeeded = true;
      }
      if (scenario === 'replan') changeObservedSource = async authorization => {
        const customer = `${fixture.expected.customer}-replanned`;
        fixture.tool.result.unitCents += 7;
        fixture.expected.customer = customer;
        fixture.expected.totalCents = fixture.expected.quantity * fixture.tool.result.unitCents + fixture.tool.result.feeCents;
        const content = `The current sample quote customer is ${customer}. The requested item is ${fixture.expected.sku}.`;
        revisedSourceHash = createHash('sha256').update(content).digest('hex');
        await api(`/documents/${source.id}`, 'PATCH', { content, expectedVersion: source.version });
        // A reference link grants visibility, not a frozen workflow-input contract.
        // Explicitly revise task acceptance to exercise the existing planning fence.
        const currentTask = await api(`/tasks/${daemonTask!.id}`);
        await api(`/tasks/${daemonTask!.id}`, 'PATCH', { expectedVersion: currentTask.version,
          description: `${currentTask.description}\nReplanned acceptance: the linked source and current pricing changed. Re-read the current source even when the previous memory differs. Verify the new quote before completion; do not update memory automatically.` });
        const headers = new Headers({ authorization, 'content-type': 'application/json' });
        const oldIdentity = await f.app.request('/api/v1/auth/me', { headers });
        receipt.replanOldAuthorityRejected = oldIdentity.status === 401;
        assert.equal(oldIdentity.status, 401);
        const oldCompletion = await f.app.request(`/api/v1/tasks/${daemonTask!.id}/status`, { method: 'PATCH', headers,
          body: JSON.stringify({ status: 'done', reason: 'Stale fixture completion must be rejected' }) });
        receipt.replanStaleCompletionRejected = !oldCompletion.ok;
        assert.ok(!oldCompletion.ok);
        receipt.replannedFixtureCanonicalSha256 = createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
      };
      const daemonHome = join(root, 'daemon-home');
      await mkdir(daemonHome, { mode: 0o700 });
      const daemonEnv = { ...env, HOME: daemonHome, CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
        PATH: `${workerBin}${delimiter}${process.env.PATH ?? ''}`, TW_DAEMON_AGENT_TIMEOUT_MS: '150000', TW_ARTIFACT_ROOT: join(root, 'artifacts') };
      if (gitRemote) {
        // Trusted supervisor only; buildAiEnvironment resets these settings for its child.
        daemonEnv.GIT_CONFIG_GLOBAL = trustedGitConfig!;
        Object.assign(daemonEnv, { GIT_CONFIG_COUNT: '0', GIT_AUTHOR_NAME: 'Task Weaver Acceptance', GIT_AUTHOR_EMAIL: 'acceptance@example.test',
          GIT_COMMITTER_NAME: 'Task Weaver Acceptance', GIT_COMMITTER_EMAIL: 'acceptance@example.test' });
      }
      result = await runCommand(scopedCli, ['daemon', 'start', '--tools', 'codex', '--project', f.project.id,
        '--workers', '1', '--mode', 'polling', '--think', 'fast:low', '--capability-execution', '--once'], { cwd: workspace, env: daemonEnv, timeoutMs: scenario === 'replan' ? 330_000 : 180_000, maxOutputBytes: 256 * 1024 });
      receipt.process = { exitCode: result.status, durationMs: result.durationMs, timedOut: result.timedOut, outputTruncated: result.outputTruncated };
      if (!result.ok) {
        const diagnostic = (result.stdout + result.stderr).toLowerCase();
        receipt.daemonDiagnosticCategories = ['credential', 'permission', 'repository', 'clone', 'fetch', 'git_helper', 'identity', 'worktree', '403', '404']
          .filter(category => diagnostic.includes(category));
      }
      receipt.taskStatus = (await api(`/tasks/${daemonTask!.id}`)).status;
      receipt.daemonUsage = await api(`/agent-usage/summary?projectId=${f.project.id}`);
      if (gitRemote) {
        const remoteTip = (await trustedGit(['ls-remote', gitRemote.href, `refs/heads/${gitBranch}`])).split(/\s/)[0];
        assert.match(remoteTip, /^[a-f0-9]{40,64}$/);
        const clone = join(root, 'remote-verification');
        await trustedGit(['clone', '--no-tags', '--single-branch', '--branch', gitBranch, gitRemote.href, clone]);
        verifyCapabilityAcceptanceArtifact(fixture, JSON.parse(await readFile(join(clone, 'quote.json'), 'utf8')));
        const message = await trustedGit(['-C', clone, 'log', '-1', '--format=%B']);
        receipt.workerRemoteGitVerified = /^Signed-off-by:/m.test(message);
        receipt.remoteHeadCommit = remoteTip;
        const links = await api(`/requirements/${daemonRequirement!.id}/repositories`);
        receipt.repositoryDelivery = (Array.isArray(links) ? links : links.items ?? []).map((entry: any) => {
          const row = entry.link ?? entry;
          return { repositoryId: row.repositoryId, deliveryStatus: row.deliveryStatus, pushStatus: row.pushStatus, headCommit: row.headCommit };
        });
      }
    } else if (emptyExternal) {
      const nativeProfile = process.env.CODEX_HOME ?? join(homedir(), '.codex');
      const profile = join(root, 'empty-codex-profile'), home = join(root, 'external-home');
      await mkdir(profile, { mode: 0o700 });
      await mkdir(home, { mode: 0o700 });
      const auth = await readFile(join(nativeProfile, 'auth.json'));
      assert.equal(JSON.parse(auth.toString('utf8')).auth_mode, 'chatgpt', 'This fixture supports only the existing ChatGPT-authenticated profile');
      await writeFile(join(profile, 'auth.json'), auth, { mode: 0o600 });
      const settings = await readFile(join(nativeProfile, 'config.toml'), 'utf8');
      const provider = settings.match(/^model_provider\s*=\s*"([^"\n]+)"/m)?.[1];
      assert.ok(!provider || provider === 'openai', 'Custom provider configuration is not copied into the empty profile');
      const model = settings.match(/^model\s*=\s*"([^"\n]+)"/m)?.[1];
      assert.ok(model && /^[a-zA-Z0-9._/-]+$/.test(model));
      await writeFile(join(profile, 'config.toml'), `model = ${JSON.stringify(model)}\nmodel_reasoning_effort = "low"\n`, { mode: 0o600 });
      receipt.requestedModel = model;
      const collector = new CodexUsageCollector();
      const diagnosticCodes = new Set<string>();
      let pendingEvents = '';
      result = await runCommand('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', '--color', 'never', '-C', workspace, prompt],
        { cwd: workspace, env: { ...env, HOME: home, CODEX_HOME: profile, XDG_CONFIG_HOME: join(root, 'empty-xdg') },
          timeoutMs: 150_000, maxOutputBytes: 256 * 1024, onStdout: chunk => {
            collector.push(chunk);
            pendingEvents += chunk.toString('utf8');
            const lines = pendingEvents.split('\n'); pendingEvents = lines.pop() ?? '';
            if (pendingEvents.length > 1024 * 1024) pendingEvents = '';
            for (const line of lines) {
              try {
                const event = JSON.parse(line);
                if (event.type === 'error' || event.type === 'turn.failed') {
                  const message = String(event.message ?? event.error?.message ?? '').toLowerCase();
                  diagnosticCodes.add(/unauthorized|authentication|401|token/.test(message) ? 'authentication_error'
                    : /quota|rate limit|429/.test(message) ? 'capacity_error'
                    : /stream|connection|websocket|network/.test(message) ? 'transport_error' : 'provider_error');
                }
              } catch { /* Diagnostics never export raw provider messages. */ }
            }
          } });
      receipt.externalCodexUsage = collector.finish(result.ok);
      receipt.providerDiagnosticCodes = [...diagnosticCodes];
    } else result = await runCommand('agy', ['--new-project', '--dangerously-skip-permissions', '--disable-slash-commands',
      '--log-file', join(root, 'agy.log'), ...(requestedModel ? ['--model', requestedModel] : []),
      '--print-timeout', '150s', '--output-format', 'json', `--print=${prompt}`],
      { cwd: workspace, env, timeoutMs: 155_000, maxOutputBytes: 256 * 1024 });
    receipt.process = { exitCode: result.status, durationMs: result.durationMs, timedOut: result.timedOut, outputTruncated: result.outputTruncated };
    let response: any;
    try { response = JSON.parse(result.stdout); } catch { /* Invalid output is not accepted. */ }
    receipt.providerStatus = ['SUCCESS', 'ERROR', 'TIMEOUT', 'WAITING', 'FAILED'].includes(response?.status) ? response.status : null;
    const usage: Record<string, number | null> = {};
    for (const key of ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens']) {
      const value = response?.usage?.[key];
      usage[key] = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    receipt.reportedUsage = usage;
    stage = 'verify';
    let artifact: unknown;
    try { artifact = JSON.parse(await readFile(join(workspace, scenario !== 'irrelevant' ? fixture.request.output : 'arithmetic.json'), 'utf8')); verifyCapabilityAcceptanceArtifact(fixture, artifact, scenario === 'replan' ? 'useful' : scenario); receipt.artifactCorrect = true; receipt.artifact = artifact; }
    catch { receipt.artifactCorrect = false; }
    const audits = await database.select().from(authAuditEvents);
    const delegations = daemonMode ? await database.select().from(executionDelegations).where(eq(executionDelegations.parentCredentialId, key.id)) : [];
    const delegationIds = new Set(delegations.map((row: { id: string }) => row.id));
    const capabilityAudits = audits.filter((row: any) => row.metadata?.capabilityEvidenceVersion === 1 && (row.metadata?.credentialId === key.id || (daemonMode && row.metadata?.requirementId === daemonRequirement?.id && row.action.startsWith('delegation.'))));
    const invocations = (await database.select().from(mcpInvocationAudits)).filter((row: any) => (row.credentialId === key.id || delegationIds.has(row.credentialId)) && row.toolId === tool.id);
    receipt.observations = capabilityAudits.map((row: any) => ({ auditId: row.id, kind: row.metadata.capabilityKind,
      assetId: row.metadata.assetId, action: row.metadata.capabilityAction, outcome: row.metadata.capabilityOutcome, hash: row.metadata.assetSha256 ?? null }));
    receipt.externalToolCalls = actualCalls;
    receipt.httpReadObservations = httpObservations;
    receipt.modelCapabilityHttpRequests = modelCapabilityRequests;
    receipt.successfulInvocationAudits = invocations.filter((row: any) => row.outcome === 'success').length;
    const read = (id: string) => httpObservations.some(row => row.assetId === id)
      || capabilityAudits.some((row: any) => row.metadata.assetId === id && row.metadata.capabilityAction === 'read' && ['read', 'returned'].includes(row.metadata.capabilityOutcome));
    receipt.capabilityAdoptionVerified = read(source.id) && read(memory.id) && (read(skill.id) || read(pkg.id) || (pkg.primaryDocumentId && read(pkg.primaryDocumentId))) && actualCalls > 0 && invocations.some((row: any) => row.outcome === 'success');
    receipt.noObservedFixtureCapabilityUse = modelCapabilityRequests === 0 && actualCalls === 0 && capabilityAudits.length === 0;
    receipt.daemonVerified = daemonMode && receipt.taskStatus === 'done' && delegations.length > 0 && receipt.artifactCorrect === true && receipt.capabilityAdoptionVerified === true;
    if (scenario === 'replan') {
      const controls = await database.select().from(executionControls).where(eq(executionControls.requirementId, daemonRequirement!.id));
      receipt.recoveryControls = controls.map((row: any) => ({ id: row.id, runId: row.runId, phase: row.phase, revision: row.revision }));
      receipt.executionRunIds = [...new Set(delegations.map((row: any) => row.runId))];
      receipt.replanVerified = replanned && receipt.replanOldAuthorityRejected === true && receipt.replanStaleCompletionRejected === true
        && (receipt.executionRunIds as unknown[]).length === 2 && controls.some((row: any) => row.phase === 'resumed')
        && httpObservations.some(row => row.assetId === source.id && row.contentSha256 === revisedSourceHash)
        && httpObservations.some(row => row.kind === 'memory' && row.sourceFreshness === 'changed');
    }
    receipt.passed = result.ok && receipt.artifactCorrect === true && (scenario !== 'irrelevant' ? receipt.capabilityAdoptionVerified === true : receipt.noObservedFixtureCapabilityUse === true)
      && (!daemonMode || receipt.daemonVerified === true) && (scenario !== 'replan' || receipt.replanVerified === true);
    if (gitRemote && receipt.workerRemoteGitVerified !== true) receipt.passed = false;
    if (!receipt.passed) process.exitCode = 1;
  }
} catch (error) {
  receipt.failedStage = stage;
  // Raw upstream errors can contain credential material or private fixture bodies.
  receipt.failureType = error instanceof Error ? error.name : 'UnknownError';
  const code = (error as { code?: unknown })?.code;
  receipt.failureCode = typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? code : null;
  process.exitCode = 1;
} finally {
  if (gitRemote && gitCleanupNeeded) {
    try {
      const refs = await trustedGit(['ls-remote', gitRemote.href, `refs/heads/${gitBranch}`]);
      if (refs) await trustedGit(['push', gitRemote.href, '--delete', gitBranch]);
      assert.equal(await trustedGit(['ls-remote', gitRemote.href, `refs/heads/${gitBranch}`]), '');
      assert.equal((await trustedGit(['ls-remote', gitRemote.href, 'refs/heads/main'])).split(/\s/)[0], gitMain);
      receipt.remoteBranchRemoved = true; receipt.remoteMainUnchanged = true;
    } catch { receipt.passed = false; process.exitCode = 1; receipt.remoteCleanupFailed = true; }
  }
  if (revokeCredential) {
    try { await revokeCredential(); receipt.credentialRevoked = true; }
    catch { receipt.credentialRevoked = false; receipt.passed = false; process.exitCode = 1; }
  }
  if (registeredServerId) await mcpPool.disconnect(registeredServerId);
  for (const server of [apiServer, toolServer]) if (server) {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  if (database) await database.$client.end();
  if (createdContainer) { docker('rm', '-f', container); (receipt.cleanup as any).database = true; }
  await rm(root, { recursive: true, force: true });
  (receipt.cleanup as any).files = true;
  if (previousStorage === undefined) delete process.env.SKILL_PACKAGE_STORAGE_DIR; else process.env.SKILL_PACKAGE_STORAGE_DIR = previousStorage;
  console.log(JSON.stringify(receipt, null, 2));
}
