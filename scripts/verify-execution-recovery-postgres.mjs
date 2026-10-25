import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const name = `tw-execution-recovery-e2e-${randomUUID().slice(0, 8)}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
docker("run", "--rm", "-d", "--name", name, "-e", "POSTGRES_DB=tw_execution_recovery_e2e", "-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_PASSWORD=fixture-only", "-p", "127.0.0.1::5432", "pgvector/pgvector:0.8.6-pg16-bookworm");
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnSync("docker", ["exec", name, "pg_isready", "-U", "fixture", "-d", "tw_execution_recovery_e2e"], { stdio: "ignore" }).status === 0) { ready = true; break; }
    await delay(200);
  }
  assert.ok(ready, "Disposable PostgreSQL did not become ready");
  const port = JSON.parse(docker("inspect", name))[0].NetworkSettings.Ports["5432/tcp"][0].HostPort;
  for (const args of [["--filter", "@task-weaver/api", "exec", "tsx", "--test", "src/execution-recovery.postgres-e2e.test.ts"], ["exec", "tsx", "--test", "scripts/recovery-operator.postgres-e2e.test.ts"]]) {
    const result = spawnSync("pnpm", args, {
      encoding: "utf8", timeout: 150_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TW_DAEMON_MODE: "sse", PGOPTIONS: "-c client_min_messages=warning", TW_EXECUTION_RECOVERY_E2E_DATABASE_URL: `postgres://fixture:fixture-only@127.0.0.1:${port}/tw_execution_recovery_e2e` },
    });
    process.stdout.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    assert.equal(result.status, 0, "Execution recovery PostgreSQL verification failed");
  }
} finally { docker("rm", "-f", name); }
