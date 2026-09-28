#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const failures = [];

const journal = JSON.parse(read("packages/db/drizzle/meta/_journal.json"));
const catalogIndex = journal.entries.findIndex((entry) => entry.tag === "0029_repository_catalog");
const removalIndex = journal.entries.findIndex((entry) => entry.tag === "0030_remove_project_git_url");
if (catalogIndex < 0 || removalIndex !== catalogIndex + 1) {
  failures.push("Repository catalog and legacy-column removal migrations must remain adjacent and ordered.");
}

const catalogMigration = read("packages/db/drizzle/0029_repository_catalog.sql");
for (const table of ["repositories", "requirement_repositories", "task_repositories"]) {
  if (!catalogMigration.includes(`CREATE TABLE IF NOT EXISTS \"${table}\"`)) failures.push(`Repository migration is missing ${table}.`);
}
if (!/ON CONFLICT \(canonical_key\) DO NOTHING/.test(catalogMigration)) {
  failures.push("Legacy repository migration must retain canonical-key deduplication.");
}

const projectsSchema = read("packages/db/src/schema/projects.ts");
if (/gitUrl|git_url/.test(projectsSchema)) failures.push("Project schema must not restore the legacy Git URL field.");

const credentialTests = read("apps/cli/src/repository-credentials.test.ts");
if (!/AI environment excludes Git and provider credentials/.test(credentialTests)) {
  failures.push("AI credential-isolation canary test is missing.");
}

const daemonTests = read("apps/cli/src/daemon-e2e.test.ts");
if (!/preserves one successful repository when another push fails/.test(daemonTests)) {
  failures.push("Independent multi-repository delivery coverage is missing.");
}

const workspaceTests = read("apps/cli/src/repository-workspace.test.ts");
for (const marker of ["preserve slice state", "accept added repositories", "isolate concurrent requirements"]) {
  if (!workspaceTests.includes(marker)) failures.push(`Composite workspace coverage is missing: ${marker}.`);
}

const rollout = read("docs/repository-rollout.md");
for (const heading of ["## Deployment sequence", "## Rollback", "## Observability", "## Validation matrix"]) {
  if (!rollout.includes(heading)) failures.push(`Repository rollout guide is missing ${heading}.`);
}

if (failures.length > 0) {
  console.error("Repository rollout safeguards failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Repository rollout safeguards passed.");
