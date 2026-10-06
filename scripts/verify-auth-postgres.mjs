import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const name = `tw-auth-e2e-${randomUUID().slice(0, 8)}`;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
docker(
  "run",
  "--rm",
  "-d",
  "--name",
  name,
  "-e",
  "POSTGRES_DB=tw_auth_e2e",
  "-e",
  "POSTGRES_USER=fixture",
  "-e",
  "POSTGRES_PASSWORD=fixture-only",
  "-p",
  "127.0.0.1::5432",
  "pgvector/pgvector:0.8.6-pg16-trixie",
);
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      spawnSync(
        "docker",
        [
          "exec",
          name,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "fixture",
          "-d",
          "tw_auth_e2e",
        ],
        { stdio: "ignore" },
      ).status === 0
    ) {
      ready = true;
      break;
    }
    await delay(200);
  }
  assert.ok(ready, "Disposable PostgreSQL did not become ready");
  const port = JSON.parse(docker("inspect", name))[0].NetworkSettings.Ports[
    "5432/tcp"
  ][0].HostPort;
  for (const [packageName, testFile] of [
    ["@task-weaver/db", "src/auth.postgres-e2e.test.ts"],
    ["@task-weaver/core", "src/services/api-keys.postgres-e2e.test.ts"],
    ["@task-weaver/core", "src/services/authentication.postgres-e2e.test.ts"],
    [
      "@task-weaver/core",
      "src/services/identity-management.postgres-e2e.test.ts",
    ],
    ["@task-weaver/api", "src/authentication.postgres-e2e.test.ts"],
    [null, "scripts/auth-transports.postgres-e2e.test.ts"],
    [null, "scripts/resource-authorization.postgres-e2e.test.ts"],
    [null, "scripts/retrieval-authorization.postgres-e2e.test.ts"],
    [null, "scripts/asset-authorization.postgres-e2e.test.ts"],
    [null, "scripts/mcp-authorization.postgres-e2e.test.ts"],
    [null, "scripts/repository-authorization.postgres-e2e.test.ts"],
    [null, "scripts/metadata-authorization.postgres-e2e.test.ts"],
    [null, "scripts/realtime-authorization.postgres-e2e.test.ts"],
    [null, "scripts/webhook-authorization.postgres-e2e.test.ts"],
    [null, "scripts/daemon-authorization.postgres-e2e.test.ts"],
    [null, "scripts/execution-delegation.postgres-e2e.test.ts"],
  ]) {
    if (process.env.TW_AUTH_E2E_TEST_FILTER && !testFile.includes(process.env.TW_AUTH_E2E_TEST_FILTER)) continue;
    const result = spawnSync(
      "pnpm",
      [
        ...(packageName ? ["--filter", packageName] : []),
        "exec",
        "tsx",
        "--test",
        testFile,
      ],
      {
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          PGOPTIONS: "-c client_min_messages=warning",
          TW_AUTH_E2E_DATABASE_URL: `postgres://fixture:fixture-only@127.0.0.1:${port}/tw_auth_e2e`,
        },
      },
    );
    process.stdout.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    assert.equal(
      result.status,
      0,
      "Authentication PostgreSQL verification failed",
    );
  }
} finally {
  docker("rm", "-f", name);
}
