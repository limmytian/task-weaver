import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const image = "pgvector/pgvector@sha256:c8483555ce48101872f888c1df8a895ff689d6c7c7a5f7ac266475f9dfe89e0b";
const live = process.argv.includes("--live");
if (live) {
  assert.ok(process.env.TW_GATEWAY_LIVE_URL && process.env.TW_GATEWAY_LIVE_TOKEN,
    "Live verification requires TW_GATEWAY_LIVE_URL and TW_GATEWAY_LIVE_TOKEN");
}
const name = `tw-gateway-e2e-${randomUUID().slice(0, 8)}`;
const output = resolve(live ? "release-artifacts/partners-gateway-live-e2e" : "release-artifacts/partners-gateway-postgres-e2e");
mkdirSync(output, { recursive: true });
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
docker("run", "--rm", "-d", "--name", name, "-e", "POSTGRES_DB=tw_gateway_e2e", "-e", "POSTGRES_USER=fixture",
  "-e", "POSTGRES_PASSWORD=fixture-only", "-p", "127.0.0.1::5432", image);
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = spawnSync("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "fixture", "-d", "tw_gateway_e2e"], { stdio: "ignore" });
    if (probe.status === 0) { ready = true; break; }
    await delay(200);
  }
  assert.ok(ready, "Disposable PostgreSQL did not become ready");
  const details = JSON.parse(docker("inspect", name))[0];
  const port = details.NetworkSettings.Ports["5432/tcp"][0].HostPort;
  const version = docker("exec", name, "psql", "-U", "fixture", "-d", "tw_gateway_e2e", "-Atc", "SHOW server_version");
  const testFile = live ? "src/partners-gateway.live-e2e.test.ts" : "src/partners-gateway.postgres-e2e.test.ts";
  const result = spawnSync("pnpm", ["--filter", "@task-weaver/api", "exec", "tsx", "--test", testFile], {
    encoding: "utf8", timeout: live ? 210_000 : 90_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TW_GATEWAY_E2E_DATABASE_URL: `postgres://fixture:fixture-only@127.0.0.1:${port}/tw_gateway_e2e` },
  });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(resolve(output, "test.log"), log);
  console.log(log);
  writeFileSync(resolve(output, "verification.json"), `${JSON.stringify({ postgresVersion: version, image,
    realPostgres: true, realHttpSse: true, gateway: live ? "external deployment" : "local protocol fixture", passed: result.status === 0 }, null, 2)}\n`);
  assert.equal(result.status, 0, "Partners Gateway PostgreSQL end-to-end verification failed");
} finally {
  docker("rm", "-f", name);
}
