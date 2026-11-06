import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.TW_EXECUTION_RECOVERY_E2E_DATABASE_URL;

async function exerciseDisconnectedReservation() {
  const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const postgres = process.env.TW_POSTGRES_FORMAT === 'esm'
    ? (await import('../packages/db/node_modules/postgres/src/index.js')).default
    : require('postgres');
  const pool = postgres(databaseUrl, { max: 2 });
  const killer = postgres(databaseUrl, { max: 1 });
  const reserved = await pool.reserve();
  try {
    const [{ pid }] = await reserved`select pg_backend_pid() as pid`;
    await killer`select pg_terminate_backend(${pid})`;
    await assert.rejects(reserved`select 1`, { code: 'CONNECTION_CLOSED' });
    await assert.rejects(reserved`select 1`, { code: 'CONNECTION_CLOSED' });
    reserved.release();
  } finally {
    await Promise.all([pool.end({ timeout: 2 }), killer.end({ timeout: 2 })]);
  }
}

if (process.env.TW_RESERVED_DISCONNECT_CHILD === '1') {
  await exerciseDisconnectedReservation();
} else {
  for (const format of ['cjs', 'esm']) test(`a terminated ${format} reserved database connection rejects without crashing`, { skip: !databaseUrl, timeout: 20000 }, () => {
    const parsed = new URL(databaseUrl);
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.equal(parsed.pathname, '/tw_execution_recovery_e2e');
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, TW_RESERVED_DISCONNECT_CHILD: '1', TW_POSTGRES_FORMAT: format },
    });
    assert.equal(child.status, 0, `Disconnect probe failed: ${child.stderr || child.error?.message || child.signal}`);
  });
}
