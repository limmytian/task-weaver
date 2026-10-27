import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resourcePostgresFixture } from '../apps/api/src/resource-postgres-fixture';
import { createTRPCContextFactory, router } from '../apps/web/trpc/init';
import { requirementRouter } from '../apps/web/trpc/routers/requirement';
const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createDb, runMigrations, requirements, requirementClaims, executionControls, activityLog } = apiRequire('@task-weaver/db');
const { createAuthenticationRuntime } = apiRequire('@task-weaver/core');
const { eq } = apiRequire('drizzle-orm');
const { createTRPCClient, httpLink } = webRequire('@trpc/client');
const { fetchRequestHandler } = webRequire('@trpc/server/adapters/fetch');
const superjson = webRequire('superjson').default;
const databaseUrl = process.env.TW_EXECUTION_RECOVERY_E2E_DATABASE_URL;

test('Web recovery HTTP protocol enforces live scopes, current observations and single operator decisions', { skip: !databaseUrl, timeout: 120_000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/tw_execution_recovery_e2e');
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const runtime = createAuthenticationRuntime(db, f.configuration);
  const routes = router({ requirement: requirementRouter });
  const client = (headers: Headers) => createTRPCClient({ links: [httpLink({
    url: `${f.configuration.trustedOrigins[0]}/api/trpc`, transformer: superjson,
    headers: () => Object.fromEntries(headers.entries()),
    fetch: (input: string, init: RequestInit) => fetchRequestHandler({
      endpoint: '/api/trpc', router: routes, req: new Request(input, init),
      createContext: ({ req, resHeaders }: { req: Request; resHeaders: Headers }) => createTRPCContextFactory({ db, auth: runtime })({ req, resHeaders }),
    }),
  })] });
  const owner = client(f.owner.headers);
  const api = async (path: string, body: unknown) => {
    const response = await f.app.request(`/api/v1${path}`, { method: 'POST', headers: f.owner.headers, body: JSON.stringify(body) });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const requirement = await api(`/projects/${f.project.id}/requirements`, { title: 'Web recovery operator fixture', status: 'approved' });
  await db.update(requirements).set({ evidenceNeedsReview: true, planRevision: requirement.planRevision + 1 }).where(eq(requirements.id, requirement.id));
  const runId = randomUUID();
  const [control] = await db.insert(executionControls).values({ requirementId: requirement.id, projectId: f.project.id, runId, daemonId: randomUUID(), revision: requirement.planRevision + 1, reason: 'Outcome requires operator inspection', phase: 'manual', deadline: new Date(Date.now() + 60_000), workspace: { nodeId: 'fixture-node', state: 'dirty', path: '/private/fixture', secret: 'must-not-project' } }).returning();
  const fails = (code: string) => (error: any) => { assert.equal(error.data?.code, code); return true; };
  const observed = await owner.requirement.recoveryState.query({ id: requirement.id });
  assert.equal(observed.actions.recover.allowed, true);
  assert.equal(observed.controls[0].id, control.id);
  assert.doesNotMatch(JSON.stringify(observed), /private\/fixture|must-not-project/);
  await assert.rejects(client(f.outsider.headers).requirement.recoveryState.query({ id: requirement.id }), fails('NOT_FOUND'));
  await f.identity.setMembership(f.owner.headers, f.project.id, f.outsider.context.actor.id, { role: 'viewer', explicitPermissions: [] });
  const viewer = client(f.outsider.headers);
  assert.equal((await viewer.requirement.recoveryState.query({ id: requirement.id })).actions.recover.blockedReason, 'management_permission_required');
  const decision = { controlId: control.id, expectedPlanRevision: observed.planRevision, expectedControlUpdatedAt: new Date(observed.controls[0].updatedAt), expectedControlPhase: observed.controls[0].phase, reason: 'Inspected external outcome and available durable inputs; preserved files remain candidate evidence' };
  await assert.rejects(viewer.requirement.authorizeRecovery.mutate({ requirementId: requirement.id, data: decision }), fails('FORBIDDEN'));
  const humanKey = await f.identity.issueKey(f.owner.headers, f.owner.context.actor.id, { name: 'Read-only recovery fixture', expiresAt: null, grants: [{ scope: 'project', projectId: f.project.id, permissions: ['resource.read'] }] });
  const keyClient = client(new Headers({ authorization: `Bearer ${humanKey.rawKey}` }));
  assert.equal((await keyClient.requirement.recoveryState.query({ id: requirement.id })).actions.revalidate.blockedReason, 'write_permission_required');
  await assert.rejects(keyClient.requirement.revalidateExecution.mutate({ requirementId: requirement.id, data: { reason: 'Not authorized', expectedPlanRevision: observed.planRevision } }), fails('FORBIDDEN'));
  await f.identity.revokeKey(f.owner.headers, f.owner.context.actor.id, humanKey.id);
  await assert.rejects(keyClient.requirement.recoveryState.query({ id: requirement.id }), fails('UNAUTHORIZED'));
  await assert.rejects(owner.requirement.authorizeRecovery.mutate({ requirementId: requirement.id, data: { controlId: control.id, reason: 'Guard omitted', expectedPlanRevision: observed.planRevision } }), fails('BAD_REQUEST'));
  await assert.rejects(owner.requirement.authorizeRecovery.mutate({ requirementId: requirement.id, data: { ...decision, expectedPlanRevision: observed.planRevision - 1 } }), fails('CONFLICT'));
  await assert.rejects(owner.requirement.authorizeRecovery.mutate({ requirementId: requirement.id, data: { ...decision, expectedControlPhase: 'stopping' } }), fails('CONFLICT'));
  const historical = await db.insert(executionControls).values({ requirementId: requirement.id, projectId: f.project.id, runId: randomUUID(), daemonId: randomUUID(), revision: observed.planRevision, phase: 'manual', reason: 'Historical fixture', deadline: new Date(), createdAt: new Date(Date.now() - 10_000) }).returning();
  await assert.rejects(owner.requirement.authorizeRecovery.mutate({ requirementId: requirement.id, data: { ...decision, controlId: historical[0].id, expectedControlUpdatedAt: historical[0].updatedAt } }), fails('CONFLICT'));
  const replacementId = randomUUID();
  await db.insert(requirementClaims).values({ id: replacementId, requirementId: requirement.id, claimedBy: f.owner.context.actor.id, claimedByType: 'human', expiresAt: new Date(Date.now() + 60_000) });
  assert.equal((await owner.requirement.recoveryState.query({ id: requirement.id })).actions.recover.blockedReason, 'replacement_owns_lane');
  await assert.rejects(owner.requirement.authorizeRecovery.mutate({ requirementId: requirement.id, data: decision }), fails('BAD_REQUEST'));
  await db.delete(requirementClaims).where(eq(requirementClaims.id, replacementId));
  const decisions = await Promise.allSettled([0, 1].map(() => owner.requirement.authorizeRecovery.mutate({ requirementId: requirement.id, data: decision })));
  assert.equal(decisions.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = decisions.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.data.code, 'CONFLICT');
  const after = await owner.requirement.recoveryState.query({ id: requirement.id });
  assert.equal(after.actions.recover.blockedReason, 'already_decided');
  assert.equal(after.controls[0].stopObservation, 'not_established');
  assert.equal(after.lane.state, 'not_held');
  const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, requirement.id));
  assert.equal(audit.filter((row: any) => row.action === 'execution_recovery_authorized').length, 1);
  await assert.rejects(owner.requirement.revalidateExecution.mutate({ requirementId: requirement.id, data: { reason: 'Stale inspection', expectedPlanRevision: after.planRevision - 1 } }), fails('CONFLICT'));
  await owner.requirement.revalidateExecution.mutate({ requirementId: requirement.id, data: { reason: 'Reviewed historical evidence against the current plan', expectedPlanRevision: after.planRevision } });
  assert.equal((await owner.requirement.recoveryState.query({ id: requirement.id })).evidenceNeedsReview, false);
});
