import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectLocalImage } from "./image-inspection-lib.mjs";

const [apiImage, webImage] = process.argv.slice(2);
if (!apiImage || !webImage) throw new Error("Usage: node scripts/verify-ce-image-deployment.mjs <api-image> <web-image>");
const databaseImage = "pgvector/pgvector@sha256:c8483555ce48101872f888c1df8a895ff689d6c7c7a5f7ac266475f9dfe89e0b";
const prefix = `tw-ce-candidate-${randomUUID().slice(0, 8)}`;
const password = randomUUID();
const url = `postgresql://postgres:${password}@database:5432/postgres`;
const containers = [];
const docker = (args) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
const delay = () => new Promise((done) => setTimeout(done, 1000));
async function ready(check, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if (await check()) return; } catch {}
    await delay();
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function start(name, args) {
  const container = `${prefix}-${name}`;
  containers.push(container);
  docker(["run", "-d", "--name", container, "--platform", "linux/arm64", "--network", prefix, ...args]);
  return container;
}
function port(name, number) {
  return Number(docker(["port", name, `${number}/tcp`]).split(":").at(-1));
}
const images = [apiImage, webImage].map((image) => ({ image, imageId: inspectLocalImage(image, "linux/arm64").Id, platform: "linux/arm64" }));
try {
  docker(["network", "create", prefix]);
  docker(["volume", "create", prefix]);
  const database = start("database", ["--network-alias", "database", "-e", `POSTGRES_PASSWORD=${password}`, databaseImage]);
  await ready(() => docker(["exec", database, "pg_isready", "-U", "postgres"]).includes("accepting connections"), "PostgreSQL");
  for (const script of ["migrate.ts", "setup-search.ts"]) {
    docker(["run", "--rm", "--platform", "linux/arm64", "--network", prefix, "-e", `DATABASE_URL=${url}`, apiImage,
      "./node_modules/.bin/tsx", `node_modules/@task-weaver/db/src/${script}`]);
  }
  const api = start("api", ["--network-alias", "api", "-p", "127.0.0.1::3001", "-e", `DATABASE_URL=${url}`,
    "-e", "TW_DAEMON_MODE=polling", "-e", "SKILL_PACKAGE_STORAGE_DIR=/app/data/skill-packages", "-v", `${prefix}:/app/data`, apiImage]);
  const apiUrl = `http://127.0.0.1:${port(api, 3001)}`;
  await ready(async () => (await fetch(`${apiUrl}/health`)).ok, "API health");
  const web = start("web", ["-p", "127.0.0.1::3000", "-e", `DATABASE_URL=${url}`, "-e", "TW_API_URL=http://api:3001", webImage]);
  await ready(async () => (await fetch(`http://127.0.0.1:${port(web, 3000)}`)).ok, "Web health");
  const request = async (path, body) => {
    const response = await fetch(`${apiUrl}/api/v1${path}`, { method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "X-Actor-Id": "ce-candidate-smoke", "X-Actor-Type": "agent" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `REST smoke failed: ${path} (${response.status})`);
    return response.json();
  };
  const project = await request("/projects", { name: "CE binary candidate smoke" });
  const requirement = await request(`/projects/${project.id}/requirements`, { title: "Verify candidate deployment" });
  const task = await request(`/projects/${project.id}/tasks`, { title: "Preserve candidate fixture", requirementId: requirement.id });
  for (const [kind, entry] of [["projects", project], ["requirements", requirement], ["tasks", task]]) {
    assert.equal((await request(`/${kind}/${entry.id}`)).id, entry.id);
  }
  const output = resolve("release-artifacts/deployment-verification.json");
  mkdirSync(resolve("release-artifacts"), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, mode: "isolated-fresh-install", imageIds: images,
    databaseImage, migrationPassed: true, searchSetupPassed: true, apiHealthy: true, webHealthy: true,
    restCreateReadPassed: true, passed: true }, null, 2)}\n`);
  console.log(output);
} finally {
  for (const container of containers.reverse()) {
    try { docker(["rm", "--force", "--volumes", container]); } catch {}
  }
  for (const resource of ["volume", "network"]) {
    try { docker([resource, "rm", prefix]); } catch {}
  }
}
