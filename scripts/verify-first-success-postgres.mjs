import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const name = `tw-first-success-${randomUUID().slice(0, 8)}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
docker("run", "--rm", "-d", "--name", name, "-e", "POSTGRES_DB=tw_first_success_e2e", "-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_PASSWORD=fixture-only", "-p", "127.0.0.1::5432", "pgvector/pgvector:0.8.6-pg16-bookworm");
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnSync("docker", ["exec", name, "pg_isready", "-U", "fixture", "-d", "tw_first_success_e2e"], { stdio: "ignore" }).status === 0) { ready = true; break; }
    await delay(200);
  }
  assert.ok(ready, "Disposable PostgreSQL did not become ready");
  const port = JSON.parse(docker("inspect", name))[0].NetworkSettings.Ports["5432/tcp"][0].HostPort;
  const result = spawnSync("pnpm", ["exec", "tsx", "--test", "scripts/first-success.postgres-e2e.test.ts"], {
    encoding: "utf8", timeout: 150_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning", TW_FIRST_SUCCESS_E2E_DATABASE_URL: `postgres://fixture:fixture-only@127.0.0.1:${port}/tw_first_success_e2e` },
  });
  process.stdout.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  assert.equal(result.status, 0, "First success PostgreSQL verification failed");
} finally { docker("rm", "-f", name); }
