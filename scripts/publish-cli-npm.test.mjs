import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compareVersions, inspectCliSet, preflightRegistry, preflightTags, publishCliSet, waitForPublishedVersion } from "./publish-cli-npm.mjs";
import { packCliSet } from "./pack-cli.mjs";

test("registry processing wait is bounded and never accepts conflicting integrity", async () => {
  const item = { package: "@task-weaver/contracts", integrity: "sha512-reviewed" };
  let requests = 0;
  let sleeps = 0;
  const sleep = async () => { sleeps++; };
  const transport = async () => ++requests < 3
    ? new Response("", { status: 404 })
    : Response.json({ name: item.package, version: "0.3.18", dist: { integrity: item.integrity } });
  assert.equal((await waitForPublishedVersion(item, "0.3.18", { transport, sleep, attempts: 3 })).exists, true);
  assert.equal(sleeps, 2);
  await assert.rejects(waitForPublishedVersion(item, "0.3.18", {
    transport: async () => new Response("", { status: 404 }), sleep, attempts: 2,
  }), /bounded registry processing wait/);
  await assert.rejects(waitForPublishedVersion(item, "0.3.18", {
    transport: async () => Response.json({ name: item.package, version: "0.3.18", dist: { integrity: "sha512-wrong" } }),
    sleep,
  }), /immutable version conflicts/i);
});

test("publication preflight rejects archive tampering and enforces repository version and dependency order", async () => {
  const root = resolve(import.meta.dirname, "..");
  const version = JSON.parse(readFileSync(join(root, "packages/contracts/package.json"), "utf8")).version;
  const temp = mkdtempSync(join(tmpdir(), "tw-cli-publish-test-"));
  try {
    packCliSet(root, temp, version);
    const artifacts = inspectCliSet(temp, version);
    assert.equal(artifacts.length, 6);
    const missing = await preflightRegistry(artifacts, version, async () => new Response("", { status: 404 }));
    assert.ok(missing.every(item => !item.exists));
    await assert.rejects(preflightRegistry(artifacts, version, async () => new Response("", { status: 403 })), /Registry preflight failed/);
    const conflicting = async () => Response.json({ name: artifacts[0].package, version, dist: { integrity: "sha512-wrong" } });
    await assert.rejects(preflightRegistry([artifacts[0]], version, conflicting), /immutable version conflicts/i);
    const matching = async () => Response.json({ name: artifacts[0].package, version, dist: { integrity: artifacts[0].integrity } });
    assert.equal((await preflightRegistry([artifacts[0]], version, matching))[0].exists, true);
    assert.ok(compareVersions("0.3.17-dev.10", "0.3.17-dev.2") > 0);
    assert.ok(compareVersions("0.3.17", "0.3.17-rc.1") > 0);
    assert.ok(compareVersions("0.3.17-rc-test.2", "0.3.17-rc-test.1") > 0);
    assert.throws(() => compareVersions("0.3.17-rc.01", version), /Invalid prerelease/);
    const tagged = async () => Response.json({ name: artifacts[0].package, version: "99.0.0" });
    await assert.rejects(preflightTags([{ ...artifacts[0], exists: false }], version, "next", tagged), /backwards/);
    const absentTag = async () => new Response("", { status: 404 });
    await assert.rejects(preflightTags([{ ...artifacts[0], exists: true }], version, "next", absentTag), /explicit|no next tag/);
    await assert.rejects(publishCliSet(temp, version, true, {}), /requires GitHub Actions/);
    writeFileSync(artifacts[0].file, "tampered");
    assert.throws(() => inspectCliSet(temp, version), /Archive size mismatch|Archive checksum mismatch/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
