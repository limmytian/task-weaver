import assert from "node:assert/strict";
import test from "node:test";
import { APPLICATION_VERSION } from "@task-weaver/contracts";
import { compareVersions, createVersionChecker, installedBuild } from "./version";

const release = { tag_name: "v0.3.0", html_url: "https://github.com/limmytian/task-weaver/releases/tag/v0.3.0", draft: false, prerelease: false, published_at: "2026-10-01T00:00:00Z" };
const installed = (version = "0.2.1") => () => ({ version, commit: null, development: true });
test("semantic ordering handles numeric identifiers, prereleases and build metadata", () => {
  for (const [a, b] of [["0.9.0", "0.10.0"], ["1.0.0-rc.9", "1.0.0-rc.10"], ["1.0.0-1", "1.0.0-alpha"], ["1.0.0-alpha", "1.0.0-alpha.1"], ["1.0.0-rc.1", "1.0.0"]]) {
    assert.equal(compareVersions(a!, b!), -1);
    assert.equal(compareVersions(b!, a!), 1);
  }
  assert.equal(compareVersions("1.0.0+one", "1.0.0+two"), 0);
  assert.throws(() => compareVersions("1.0.0-01", "1.0.0"));
  assert.throws(() => compareVersions("01.0.0", "1.0.0"));
});
test("only explicit checks fetch, with a fixed URL, coalescing and expiry", async () => {
  let calls = 0, time = 0;
  const checker = createVersionChecker({ installed: installed(), now: () => time, fetch: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.github.com/repos/limmytian/task-weaver/releases/latest");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal);
    return Response.json({ ...release, assets: [{ description: "x".repeat(100_000) }] });
  } });
  assert.equal(checker.info().status, "not_checked");
  assert.equal(calls, 0);
  const results = await Promise.all([checker.check(), checker.check()]);
  assert.equal(calls, 1);
  assert.equal(results[0]?.status, "update_available");
  assert.equal((await checker.check()).status, "update_available");
  assert.equal(calls, 1);
  time = 300_001;
  await checker.check();
  assert.equal(calls, 2);
});
test("disabled, offline and rate-limited checks never report current", async () => {
  let calls = 0;
  const disabled = createVersionChecker({ enabled: () => false, fetch: async () => { calls++; throw new Error(); } });
  assert.equal((await disabled.check()).status, "disabled");
  assert.equal(calls, 0);
  const offline = createVersionChecker({ fetch: async () => { throw new Error("Timeout"); } });
  assert.equal((await offline.check()).status, "unavailable");
  assert.equal((await createVersionChecker({ fetch: async () => new Response(null, { status: 429 }) }).check()).status, "rate_limited");
});
test("stable source and bounded content are verified before comparison", async () => {
  for (const value of [{ ...release, prerelease: true }, { ...release, draft: true }, { ...release, html_url: "https://example.invalid" }, { ...release, tag_name: "v0.3.0-rc.1" }]) {
    assert.equal((await createVersionChecker({ fetch: async () => Response.json(value) }).check()).status, "unavailable");
  }
  const oversized = createVersionChecker({ fetch: async () => new Response("x".repeat(1_048_577)) });
  assert.equal((await oversized.check()).status, "unavailable");
  for (const [version, status] of [["0.3.0", "current"], ["0.4.0-dev.1", "ahead"], ["0.3.0-rc.1", "update_available"]]) {
    assert.equal((await createVersionChecker({ installed: installed(version), fetch: async () => Response.json(release) }).check()).status, status);
  }
});
test("build identity never invents a commit when metadata is missing", () => {
  assert.deepEqual(installedBuild({ NODE_ENV: "production" }), { version: APPLICATION_VERSION, commit: null, development: true });
  assert.equal(installedBuild({ NODE_ENV: "production", TW_BUILD_COMMIT: "a".repeat(40) }).development, false);
  assert.equal(installedBuild({ TW_BUILD_COMMIT: "invalid" }).commit, null);
});
