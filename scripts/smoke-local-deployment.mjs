#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// This writes disposable rehearsal data. Never target a normal workspace.
const [apiValue, webValue, consent] = process.argv.slice(2);
if (!apiValue || !webValue || consent !== "--disposable") {
  throw new Error("Usage: node scripts/smoke-local-deployment.mjs <api-url> <web-url> --disposable");
}
const validate = (value) => {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Only explicit loopback deployments are supported");
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/");
  return url.origin;
};
const api = validate(apiValue);
const web = validate(webValue);
const checks = [];
const request = async (path, method = "GET", body) => {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Actor-Id": "publication-rehearsal", "X-Actor-Type": "agent" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response.json();
};
await request("/health");
checks.push("api-health");
const project = await request("/api/v1/projects", "POST", { name: `Publication rehearsal ${Date.now()}` });
assert.ok(project.id);
const requirement = await request(`/api/v1/projects/${project.id}/requirements`, "POST", { title: "Disposable deployment validation" });
const task = await request(`/api/v1/projects/${project.id}/tasks`, "POST", { title: "Validate task lifecycle", requirementId: requirement.id });
await request(`/api/v1/tasks/${task.id}/claim`, "POST", { durationMinutes: 5 });
const completed = await request(`/api/v1/tasks/${task.id}/status`, "PATCH", { status: "done", reason: "Disposable publication deployment smoke test" });
assert.equal(completed.status, "done");
checks.push("project-requirement-task-lifecycle");
const document = await request("/api/v1/documents", "POST", { projectId: project.id, title: "Rehearsal searchable document", content: "Publication rehearsal persistence verification." });
const search = await request(`/api/v1/search/documents/fulltext?query=rehearsal&projectId=${project.id}`);
assert.ok((Array.isArray(search) ? search : search.items).some((item) => item.id === document.id));
checks.push("document-fulltext-search");
for (const path of ["/", "/projects"]) {
  const response = await fetch(`${web}${path}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Task Weaver/);
}
const response = await fetch(`${web}/api/trpc/project.get?input=${encodeURIComponent(JSON.stringify({ json: { id: project.id } }))}`, { signal: AbortSignal.timeout(30_000) });
assert.equal(response.status, 200);
assert.equal((await response.json()).result.data.json.id, project.id);
checks.push("web-pages-and-database-backed-trpc");
const output = resolve("release-artifacts");
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "deployment-smoke.json"), `${JSON.stringify({ schemaVersion: 1, api, web, projectId: project.id, documentId: document.id, checks }, null, 2)}\n`);
console.log(JSON.stringify({ projectId: project.id, checks }, null, 2));
