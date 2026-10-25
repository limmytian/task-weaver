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
import { buildAiEnvironment } from '../apps/cli/src/repository-credentials';
import { createCapabilityAcceptanceFixture, verifyCapabilityAcceptanceArtifact } from './capability-acceptance-fixture.mjs';

const fixtureOnly = process.argv[2] === '--verify-fixture-only';
assert.deepEqual(process.argv.slice(2), [fixtureOnly ? '--verify-fixture-only' : '--confirm-one-real-external-agent']);
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { createDb, runMigrations, authAuditEvents, mcpInvocationAudits, projectMemberships } = requireApi('@task-weaver/db');
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
  schemaVersion: 1, mode: fixtureOnly ? 'fixture-validation' : 'independent-native-profile-cli-agent', provider: 'agy', resolvedModel: null,
  sourceModules: { core: requireApi.resolve('@task-weaver/core'), db: requireApi.resolve('@task-weaver/db') },
  fixtureCanonicalSha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
  artifactCorrect: false, capabilityAdoptionVerified: false, daemonVerified: false,
  emptyWorkspace: true, emptyPersonalSkillDirectory: false, slashExpansionDisabled: true,
  providerProfileState: 'provider_managed_records_may_remain',
  modelCost: null, passed: false, cleanup: { database: false, files: false },
};
let database: ReturnType<typeof createDb> | undefined;
let apiServer: any, toolServer: any, registeredServerId: string | undefined;
let revokeCredential: (() => Promise<void>) | undefined;
let createdContainer = false;
const previousStorage = process.env.SKILL_PACKAGE_STORAGE_DIR;
let stage = 'prepare';
try {
  for (const dir of [workspace, config, bin]) await mkdir(dir, { mode: 0o700 });
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
  handler = async (request: Request) => {
    const response = await f.app.fetch(request);
    const selected = observableReads.get(new URL(request.url).pathname);
    if (selected && response.ok && request.method === 'GET' && clientKey && request.headers.get('authorization') === `Bearer ${clientKey}`) {
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
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: 'member', explicitPermissions: ['mcp.invoke'] });
  const key = await f.identity.issueKey(f.owner.headers, agent.id, { name: 'Bounded independent client', expiresAt: new Date(Date.now() + 600_000).toISOString(),
    grants: [{ scope: 'project', projectId: f.project.id, permissions: ['resource.read', 'mcp.invoke'] }] });
  revokeCredential = async () => {
    await f.identity.revokeKey(f.owner.headers, agent.id, key.id);
    const denied = await f.app.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${key.rawKey}` } });
    receipt.revokedCredentialDenied = denied.status === 401;
    assert.equal(denied.status, 401, 'Revoked fixture credential must be rejected');
  };
  clientKey = key.rawKey;
  observableReads.set(`/api/v1/documents/${source.id}`, { kind: 'source_document', assetId: source.id });
  observableReads.set(`/api/v1/context/${skill.id}`, { kind: 'skill', assetId: skill.id });
  observableReads.set(`/api/v1/memories/${memory.id}`, { kind: 'memory', assetId: memory.id });
  observableReads.set('/api/v1/memories/search', { kind: 'memory_search', assetId: memory.id });
  observableReads.set(`/api/v1/context/packages/${pkg.id}/read`, { kind: 'skill_package', assetId: pkg.id });
  await writeFile(join(config, 'config.json'), JSON.stringify({ apiUrl, apiKey: key.rawKey, actorId: agent.id, clientId: `fixture-${randomUUID()}`, nodeId: `fixture-${randomUUID()}` }), { mode: 0o600 });
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
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
    receipt.fixtureReady = true;
    receipt.passed = true;
  } else {
    const prompt = `You are an independent CLI client in an isolated disposable test project ${f.project.id}. For every Task Weaver command use the absolute executable ${scopedCli}; do not use a bare tw command, another client or another configuration. That wrapper pins the scoped test configuration even when a login shell changes its environment. Do not read credentials, other projects, home-directory files, or install anything. Local slash commands and skill expansion are disabled.\nCreate quote.json in the current working directory for the project's current sample quote customer and item, quantity ${fixture.request.quantity}. Obtain current customer/source, relevant project calculation guidance and current external pricing through Task Weaver. Re-read the linked source before relying on a memory. Start with context bootstrap --json; use context search, memory search and mcp search with --project ${f.project.id} only as relevant. Inspect selected content with context get, memory get and doc get; inspect a tool with mcp tool before mcp call with --schema-hash. Use the scoped executable's focused subcommand help as needed. Return exactly these JSON fields: customer, sku, quantity, totalCents, currency, sourceRevision. Do not guess missing facts. No memory writes are requested. Verify the produced file. This project contains unrelated shipping guidance; use it only if relevant. Stop and report a blocker after two command failures; do not repeat failing commands.`;
    stage = 'model';
    const requestedModel = process.env.TW_ACCEPTANCE_AGY_MODEL;
    receipt.requestedModel = requestedModel ?? null;
    receipt.freshProviderProjectRequested = true;
    const result = await runCommand('agy', ['--new-project', '--dangerously-skip-permissions', '--disable-slash-commands',
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
    try { artifact = JSON.parse(await readFile(join(workspace, fixture.request.output), 'utf8')); verifyCapabilityAcceptanceArtifact(fixture, artifact); receipt.artifactCorrect = true; receipt.artifact = artifact; }
    catch { receipt.artifactCorrect = false; }
    const audits = await database.select().from(authAuditEvents);
    const capabilityAudits = audits.filter((row: any) => row.metadata?.credentialId === key.id && row.metadata?.capabilityEvidenceVersion === 1);
    const invocations = (await database.select().from(mcpInvocationAudits)).filter((row: any) => row.credentialId === key.id && row.toolId === tool.id);
    receipt.observations = capabilityAudits.map((row: any) => ({ auditId: row.id, kind: row.metadata.capabilityKind,
      assetId: row.metadata.assetId, action: row.metadata.capabilityAction, outcome: row.metadata.capabilityOutcome, hash: row.metadata.assetSha256 ?? null }));
    receipt.externalToolCalls = actualCalls;
    receipt.httpReadObservations = httpObservations;
    receipt.successfulInvocationAudits = invocations.filter((row: any) => row.outcome === 'success').length;
    const read = (id: string) => httpObservations.some(row => row.assetId === id)
      || capabilityAudits.some((row: any) => row.metadata.assetId === id && row.metadata.capabilityAction === 'read' && ['read', 'returned'].includes(row.metadata.capabilityOutcome));
    receipt.capabilityAdoptionVerified = read(source.id) && read(memory.id) && (read(skill.id) || read(pkg.id)) && actualCalls > 0 && invocations.some((row: any) => row.outcome === 'success');
    receipt.passed = result.ok && receipt.artifactCorrect === true && receipt.capabilityAdoptionVerified === true;
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
