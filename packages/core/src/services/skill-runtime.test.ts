import assert from "node:assert/strict";
import test from "node:test";
import { configuredSkillRuntimes, listSkillRuntimes } from "./skill-runtime";

const profile = { id: "shell-fixture", image: `example/runtime@sha256:${"a".repeat(64)}`, interpreter: "shell" };
test("skill runtimes are opt-in and reject floating images, duplicate IDs and unsafe config", async () => {
  assert.deepEqual(configuredSkillRuntimes(), []);
  assert.equal((await listSkillRuntimes()).items.length, 0);
  assert.equal(configuredSkillRuntimes(JSON.stringify([profile]))[0]!.timeoutMs, 3000);
  for (const input of [[{ ...profile, image: "example/runtime:latest" }], [profile, profile], [{ ...profile, command: "host-shell" }], [{ ...profile, timeoutMs: 30000 }], [{ ...profile, interpreter: "/bin/bash -c" }]]) {
    assert.throws(() => configuredSkillRuntimes(JSON.stringify(input)));
  }
});
