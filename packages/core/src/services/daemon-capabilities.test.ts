import assert from "node:assert/strict";
import test from "node:test";
import { matchDaemonTaskCapabilities } from "./daemon-capabilities";

test("executor constraints are any-of and preserve daemon preference order", () => {
  const match = matchDaemonTaskCapabilities(
    ["executor:codex", "executor:agy"],
    ["executor:agy", "executor:codex"],
  );

  assert.equal(match.eligible, true);
  assert.equal(match.executorTool, "agy");
  assert.deepEqual(match.allowedExecutors, ["codex", "agy"]);
});

test("legacy tool tags select an installed executor instead of the first task tag", () => {
  const match = matchDaemonTaskCapabilities(
    ["tool:claude", "tool:codex"],
    ["codex"],
  );

  assert.equal(match.eligible, true);
  assert.equal(match.executorTool, "codex");
});

test("auxiliary all-of and grouped any-of requirements are evaluated independently", () => {
  const tags = [
    "capability:docker",
    "capability-any:browser:chrome",
    "capability-any:browser:firefox",
    "capability-any:forge:github",
    "capability-any:forge:gitea",
  ];
  const match = matchDaemonTaskCapabilities(tags, [
    "executor:codex",
    "docker",
    "firefox",
    "gitea",
  ]);

  assert.equal(match.eligible, true);
  assert.deepEqual(match.missingCapabilities, []);
  assert.deepEqual(match.missingAnyGroups, []);

  const missing = matchDaemonTaskCapabilities(tags, ["executor:codex", "chrome"]);
  assert.equal(missing.eligible, false);
  assert.deepEqual(missing.missingCapabilities, ["docker"]);
  assert.deepEqual(missing.missingAnyGroups, ["forge"]);
});
