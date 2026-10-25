import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resourcePostgresFixture } from '../apps/api/src/resource-postgres-fixture';
import { createTRPCContextFactory, router } from '../apps/web/trpc/init';
import { skillRouter } from '../apps/web/trpc/routers/skill';
const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createDb, runMigrations, documents, memories, skillPackages, skillPackageVersions, skillPackageFiles, mcpServers, mcpTools, projectMemberships, authAuditEvents, mcpInvocationAudits, requirements, tasks, taskNotes } = apiRequire('@task-weaver/db');
const { createAuthenticationRuntime } = apiRequire('@task-weaver/core');
const { and, eq } = apiRequire('drizzle-orm');
const { createTRPCClient, httpLink } = webRequire('@trpc/client');
const { fetchRequestHandler } = webRequire('@trpc/server/adapters/fetch');
const superjson = webRequire('superjson').default;
const databaseUrl = process.env.TW_CAPABILITY_DIAGNOSTICS_E2E_DATABASE_URL;

test('project readiness separates current permission, content candidates and API runtime without payload leakage', { skip: !databaseUrl, timeout: 120_000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/tw_capability_diagnostics_e2e');
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const api = async (headers = f.owner.headers) => f.app.request(`/api/v1/context/readiness?projectId=${f.project.id}`, { headers });
  const read = async (headers = f.owner.headers) => { const response = await api(headers); assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<any>; };
  const empty = await read();
  assert.ok(empty.inventory.every((item: any) => item.access === 'missing' || item.registered === 0));
  assert.equal(empty.runtimeSource, 'api');
  assert.equal(empty.hostedExecution, null);
  assert.equal(empty.runtimeObservation, 'not_observed_for_current_permissions');
  assert.ok([403, 404].includes((await api(f.outsider.headers)).status));
  const actorId = f.owner.context.actor.id;
  // Only the disposable fixture receives invocation authority; no live credentials change.
  await db.update(projectMemberships).set({ explicitPermissions: ['mcp.invoke'] }).where(and(eq(projectMemberships.projectId, f.project.id), eq(projectMemberships.actorId, actorId)));
  const foreign = await f.identity.createProject(f.outsider.headers, { name: 'Inaccessible diagnostics fixture' });
  const seededDocuments = await db.insert(documents).values([
    { projectId: f.project.id, docType: 'skill', title: 'Selected skill', content: 'private-skill-body', createdBy: actorId },
    { projectId: f.project.id, docType: 'guide', title: 'Not a skill', content: 'ordinary-body', createdBy: actorId },
    { projectId: foreign.id, docType: 'skill', title: 'Foreign skill', content: 'foreign-body', createdBy: f.outsider.context.actor.id },
    { projectId: null, personalOwnerId: actorId, personalOwnerType: 'human', docType: 'skill', title: 'Personal skill', content: 'personal-body', createdBy: actorId },
    { projectId: null, docType: 'skill', title: 'Shared skill', content: 'shared-body', createdBy: actorId },
  ]).returning();
  const seededMemories = await db.insert(memories).values([
    { projectId: f.project.id, entityType: 'document', entityId: seededDocuments[2].id, title: 'Inaccessible linked entity', content: 'hidden-linked-memory', createdBy: actorId, createdByType: 'human' },
    { projectId: f.project.id, title: 'Fresh memory', content: 'private-memory-body', createdBy: actorId, createdByType: 'human' },
    { projectId: f.project.id, title: 'Expired memory', content: 'expired-body', createdBy: actorId, createdByType: 'human', expiresAt: new Date(Date.now() - 1000) },
  ]).returning();
  const [pkg] = await db.insert(skillPackages).values({ projectId: f.project.id, name: 'Metadata-only fixture', createdBy: actorId }).returning();
  const [version] = await db.insert(skillPackageVersions).values({ packageId: pkg.id, version: '1.0.0', createdBy: actorId }).returning();
  await db.insert(skillPackageFiles).values({ packageVersionId: version.id, path: 'SKILL.md', kind: 'entry', sizeBytes: 100, sha256: 'a'.repeat(64), isReadableText: true });
  const [server] = await db.insert(mcpServers).values({ projectId: f.project.id, name: 'Public transport fixture', transport: 'streamable-http', config: { url: 'https://example.invalid/never-contact' }, registeredBy: actorId, status: 'connected' }).returning();
  const [tool] = await db.insert(mcpTools).values({ serverId: server.id, name: 'Selected tool', inputSchema: { secret: 'private-schema-body' } }).returning();
  const [privateServer] = await db.insert(mcpServers).values({ projectId: f.project.id, name: 'Another credential local bridge', transport: 'stdio', config: {}, registeredBy: f.outsider.context.actor.id, registeredCredentialId: `${f.outsider.context.credential.kind}:${f.outsider.context.credential.id}`, status: 'connected' }).returning();
  await db.insert(mcpTools).values({ serverId: privateServer.id, name: 'Invisible tool' });
  const populated = await read();
  assert.deepEqual(populated.inventory.map((item: any) => [item.kind, item.registered, item.contentCandidates]), [['skill', 1, 1], ['skill_package', 1, 1], ['memory', 2, 1], ['mcp_tool', 1, 1]]);
  assert.ok(populated.inventory.every((item: any) => item.inspectionRequired));
  assert.doesNotMatch(JSON.stringify(populated), /private-skill-body|private-memory-body|private-schema-body|foreign-body|personal-body|shared-body|never-contact|hidden-linked-memory/);
  const key = await f.identity.issueKey(f.owner.headers, actorId, { name: 'Read-only diagnostics fixture', expiresAt: null, grants: [{ scope: 'project', projectId: f.project.id, permissions: ['resource.read'] }] });
  const headers = new Headers({ authorization: `Bearer ${key.rawKey}` });
  const keyView = await read(headers);
  assert.equal(keyView.invokePermission, 'missing');
  assert.equal(keyView.inventory.find((item: any) => item.kind === 'mcp_tool').access, 'missing');
  assert.equal(keyView.inventory.find((item: any) => item.kind === 'mcp_tool').registered, null);
  assert.equal(keyView.hostedExecution, null);
  assert.equal(keyView.runtimeObservation, 'not_observed_for_current_permissions');
  const previousApi = process.env.TW_API_URL;
  const previousRuntime = process.env.TW_SKILL_RUNTIME_PROFILES;
  process.env.TW_API_URL = f.configuration.baseURL;
  process.env.TW_SKILL_RUNTIME_PROFILES = 'Web runtime configuration must never be substituted';
  t.after(() => { if (previousApi === undefined) delete process.env.TW_API_URL; else process.env.TW_API_URL = previousApi; if (previousRuntime === undefined) delete process.env.TW_SKILL_RUNTIME_PROFILES; else process.env.TW_SKILL_RUNTIME_PROFILES = previousRuntime; });
  const proxy = t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    assert.ok(String(input).startsWith(`${f.configuration.baseURL}/api/v1/context/readiness?projectId=`));
    return f.app.request(new Request(input, init));
  });
  const runtime = createAuthenticationRuntime(db, f.configuration);
  const routes = router({ skill: skillRouter });
  const clientFor = (requestHeaders: Headers) => createTRPCClient({ links: [httpLink({ url: `${f.configuration.trustedOrigins[0]}/api/trpc`, transformer: superjson, headers: () => Object.fromEntries(requestHeaders.entries()),
    fetch: (input: string, init: RequestInit) => fetchRequestHandler({ endpoint: '/api/trpc', router: routes, req: new Request(input, init), createContext: ({ req, resHeaders }: { req: Request; resHeaders: Headers }) => createTRPCContextFactory({ db, auth: runtime })({ req, resHeaders }) }),
  })] });
  const client = clientFor(headers);
  const forwarded = await client.skill.readiness.query({ projectId: f.project.id });
  assert.deepEqual(forwarded.hostedExecution, keyView.hostedExecution);
  assert.equal(forwarded.invokePermission, 'missing');
  assert.equal(proxy.mock.callCount(), 1);
  await f.identity.revokeKey(f.owner.headers, actorId, key.id);
  assert.equal((await api(headers)).status, 401);
  await assert.rejects(client.skill.readiness.query({ projectId: f.project.id }), (error: any) => { assert.equal(error.data.code, 'UNAUTHORIZED'); return true; });
  const ownerClient = clientFor(f.owner.headers);
  const noAuditKey = await f.identity.issueKey(f.owner.headers, actorId, { name: 'No audit fixture', expiresAt: null, grants: [{ scope: 'project', projectId: f.project.id, permissions: ['resource.read'] }] });
  await assert.rejects(clientFor(new Headers({ authorization: `Bearer ${noAuditKey.rawKey}` })).skill.evidence.query({ projectId: f.project.id }), (error: any) => { assert.equal(error.data.code, 'FORBIDDEN'); return true; });
  const runId = randomUUID();
  const credentialId = f.owner.context.credential.id;
  const base = { capabilityEvidenceVersion: 1, evidenceSource: 'api', projectId: f.project.id, credentialId, capabilityAction: 'read', capabilityOutcome: 'read' };
  const record = (metadata: Record<string, string | number | boolean>, action = 'capability.operation') => ({ actorId, subjectActorId: actorId, entityId: credentialId, action, metadata });
  const [invocation] = await db.insert(mcpInvocationAudits).values({ actorId, credentialId, scopeKey: `project:${f.project.id}`, serverId: server.id, toolId: tool.id, durationMs: 37, outcome: 'error', errorCode: 'upstream_error' }).returning();
  await db.insert(authAuditEvents).values([
    record({ ...base, runId, capabilityKind: 'skill', assetId: seededDocuments[0].id, assetVersion: '1', assetSha256: 'a'.repeat(64), assetHashKind: 'content', privateBody: 'must-not-project', parentCredentialId: 'must-not-project-parent' }, 'delegation.operation'),
    record({ ...base, runId, capabilityKind: 'skill', assetId: seededDocuments[0].id, assetVersion: '1', assetSha256: 'a'.repeat(64), assetHashKind: 'content', capabilityOutcome: 'returned' }, 'delegation.capability_invocation'),
    record({ ...base, runId, capabilityKind: 'skill', assetId: seededDocuments[2].id }),
    record({ ...base, capabilityKind: 'memory', assetId: seededMemories[0].id }),
    record({ ...base, capabilityKind: 'memory', assetId: seededMemories[1].id, sourceFreshness: 'changed', runId: randomUUID(), attribution: 'credential' }),
    record({ ...base, capabilityKind: 'memory', assetId: seededMemories[2].id }),
    record({ ...base, capabilityKind: 'skill_package', assetId: pkg.id, assetVersion: '1.0.0', assetSha256: 'b'.repeat(64), assetHashKind: 'file' }),
    record({ ...base, capabilityKind: 'mcp_tool', assetId: tool.id, capabilityAction: 'invoke', capabilityOutcome: 'upstream_error', assetSha256: 'c'.repeat(64), assetHashKind: 'tool_schema', invocationAuditId: invocation.id }),
    record({ ...base, capabilityKind: 'skill', capabilityAction: 'discover', capabilityOutcome: 'discovered', resultCount: 20 }),
  ]);
  const [reportRequirement] = await db.insert(requirements).values({ projectId: f.project.id, title: 'Report reference fixture', createdBy: actorId }).returning();
  const [reportTask] = await db.insert(tasks).values({ projectId: f.project.id, requirementId: reportRequirement.id, title: 'Report fixture', createdBy: actorId }).returning();
  const [note] = await db.insert(taskNotes).values({ taskId: reportTask.id, content: 'Raw report must not be projected', authorId: actorId, authorType: 'human' }).returning();
  await db.insert(authAuditEvents).values(record({ ...base, evidenceSource: 'agent_report', reportId: note.id, capabilityAction: 'report', capabilityOutcome: 'reported' }, 'delegation.operation'));
  const evidence = await ownerClient.skill.evidence.query({ projectId: f.project.id, limit: 1 });
  assert.equal(evidence.totalVisibleReferences, 4, 'private/expired references are filtered before counts and nested success layers collapse');
  assert.equal(evidence.items.length, 1);
  assert.equal(evidence.reportedProgressReferences, 1);
  assert.equal(evidence.coverage.complete, false);
  assert.equal(evidence.coverage.discovery, 'unknown');
  assert.equal(evidence.coverage.modelCost, null);
  const allEvidence = await ownerClient.skill.evidence.query({ projectId: f.project.id, limit: 20 });
  assert.equal(allEvidence.items.filter((item: any) => item.assetId === seededDocuments[0].id).length, 1);
  assert.equal(allEvidence.items.find((item: any) => item.assetId === seededMemories[1].id).runId, null, 'independent credential cannot acquire a fabricated daemon run');
  assert.equal(allEvidence.items.find((item: any) => item.assetId === tool.id).durationMs, 37);
  assert.equal(allEvidence.items.find((item: any) => item.assetId === tool.id).outcome, 'error');
  assert.doesNotMatch(JSON.stringify(allEvidence), /must-not-project|Raw report|private-skill-body|private-memory-body|private-schema-body|foreign-body|parentCredentialId/);
  await db.update(skillPackageVersions).set({ status: 'archived' }).where(eq(skillPackageVersions.id, version.id));
  const afterRevoke = await ownerClient.skill.evidence.query({ projectId: f.project.id, limit: 1, offset: 1 });
  assert.equal(afterRevoke.totalVisibleReferences, 3);
  assert.equal(afterRevoke.items.length, 1, 'pagination applies after current version visibility');
  assert.ok(afterRevoke.items.every((item: any) => item.assetId !== pkg.id));

});
