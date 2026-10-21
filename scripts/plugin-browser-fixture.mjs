import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const name = `tw-plugin-browser-${randomUUID().slice(0, 8)}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let fixture;
let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  if (fixture && fixture.exitCode === null) {
    fixture.kill("SIGTERM"); await Promise.race([once(fixture, "exit"), delay(10000)]);
    if (fixture.exitCode === null) fixture.kill("SIGKILL");
  }
  try { docker("rm", "--force", name); } catch { /* The owned disposable container may already have exited. */ }
};
process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
try {
  docker("run", "--rm", "-d", "--name", name, "-e", "POSTGRES_DB=tw_plugin_browser", "-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_PASSWORD=fixture-only", "-p", "127.0.0.1::5432", "pgvector/pgvector:0.8.6-pg16-bookworm");
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { docker("exec", name, "pg_isready", "-U", "fixture", "-d", "tw_plugin_browser"); ready = true; break; } catch { await delay(200); }
  }
  assert.ok(ready, "Disposable browser database did not become ready");
  const port = JSON.parse(docker("inspect", name))[0].NetworkSettings.Ports["5432/tcp"][0].HostPort;
  const image = JSON.parse(docker("image", "inspect", "pgvector/pgvector:0.8.6-pg16-bookworm"))[0].RepoDigests?.[0];
  assert.match(image ?? "", /@sha256:[a-f0-9]{64}$/);
  fixture = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../apps/api/src/plugin-browser-fixture.ts", import.meta.url))], {
    env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning", TW_PLUGIN_BROWSER_DATABASE_URL: `postgres://fixture:fixture-only@127.0.0.1:${port}/tw_plugin_browser`, TW_SKILL_RUNTIME_TEST_IMAGE: image }, stdio: ["ignore", "inherit", "inherit"],
  });
  const [code] = await once(fixture, "exit");
  if (!stopping) { await stop(); process.exitCode = typeof code === "number" ? code : 1; }
} catch (error) {
  await stop(); throw error;
}
