import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resourcePostgresFixture } from '../apps/api/src/resource-postgres-fixture';

const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { createDb, runMigrations } = apiRequire('@task-weaver/db');
const { apiKeyService } = apiRequire('@task-weaver/core');
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test('legacy daemon routes cannot schedule work with any credential', { skip: !databaseUrl, timeout: 150_000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/tw_auth_e2e');
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: 'Legacy route test' });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: 'member', explicitPermissions: ['execution.run'] });
  const key = await apiKeyService.issueScopedApiKey(db, f.owner.context, agent.id, { name: 'Worker fixture', grants: [{ scope: 'project', projectId: f.project.id, permissions: ['resource.read', 'resource.write', 'execution.run'] }], expiresAt: null });
  const workerHeaders = new Headers({ authorization: `Bearer ${key.rawKey}`, 'content-type': 'application/json' });
  const id = randomUUID();
  for (const path of ['register', `${id}/apply-requirement`, `${id}/apply-review`, `${id}/apply-merge`, `${id}/heartbeat`, `${id}/progress`, `${id}/control`]) {
    for (const headers of [workerHeaders, f.owner.headers]) {
      const response = await f.app.request(`/api/v1/daemons/${path}`, { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 404, `${path} must not be available`);
    }
  }
});
