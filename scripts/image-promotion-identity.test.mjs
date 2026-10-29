import assert from "node:assert/strict";
import test from "node:test";
import { promotionIdentity } from "./image-promotion-identity.mjs";
const commit = "a".repeat(40);
const main = { id: 987, run_attempt: 1, repository: { full_name: "example/task-weaver" }, status: "in_progress", path: ".github/workflows/release-gates.yml", event: "push", head_branch: "main", head_sha: commit, created_at: "2026-10-28T09:00:00Z" };
const input = { repository: "example/task-weaver", runId: "987", attempt: 1, kind: "main", commit, version: "0.3.17-dev.0" };
test("identity derives unique main version and validates the publisher", () => {
  assert.deepEqual(promotionIdentity(main, input), { version: "0.3.17-dev.0-main.987.1", commit });
  for (const patch of [{ id: 988 }, { run_attempt: 2 }, { status: "completed" }, { path: "untrusted" }, { head_branch: "other" }, { head_sha: "b".repeat(40) }]) assert.throws(() => promotionIdentity({ ...main, ...patch }, input));
});
test("release runs use their selected immutable version", () => {
  const run = { ...main, path: ".github/workflows/ce-release.yml", event: "workflow_dispatch" };
  assert.equal(promotionIdentity(run, { ...input, kind: "release", version: "0.3.17" }).version, "0.3.17");
  assert.throws(() => promotionIdentity({ ...run, event: "push" }, { ...input, kind: "release" }));
});

test("both publisher workflows share a lock and promote only after their gates", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(".github/workflows/release-gates.yml", "utf8");
  const release = readFileSync(".github/workflows/ce-release.yml", "utf8");
  assert.match(main, /group: task-weaver-image-promotion/);
  assert.match(release, /group: task-weaver-image-promotion/);
  assert.match(main, /candidate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.ok(main.indexOf("Sign the Web candidate") < main.indexOf("promote-image-pair.mjs main"));
  assert.ok(release.indexOf("ce-consumption") < release.indexOf("publish-ce-oci.mjs"));
  assert.ok(release.indexOf("publish-ce-oci.mjs") < release.indexOf("promote-image-pair.mjs release"));
  assert.ok(release.indexOf("promote-image-pair.mjs release") < release.indexOf("Create public release"));
  assert.doesNotMatch(main, /--tag .*:latest/);
  assert.doesNotMatch(release, /promote-image-pair\.mjs recover/);
  assert.doesNotMatch(main, /contents: write/);
});
