import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { imageArchiveConfig } from "./ce-image-archive.mjs";

test("publication rejects evidence from another version or public commit before loading Docker images", () => {
  const directory = mkdtempSync(join(tmpdir(), "ce-publication-"));
  try {
    const script = resolve("scripts/load-ce-binary-candidate.mjs");
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    for (const candidate of [
      { schemaVersion: 1, version: "0.1.0", commit },
      { schemaVersion: 1, version: "0.2.0", commit: "0".repeat(40) },
    ]) {
      writeFileSync(join(directory, "ce-candidate.json"), JSON.stringify(candidate));
      const result = spawnSync(process.execPath, [script, directory, "0.2.0"], { encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /AssertionError/);
      assert.doesNotMatch(result.stderr, /docker/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("publication loads reviewed image bytes and applies evidence gates before registry writes", () => {
  const publicWorkflow = existsSync("open-source/public-files") ? "open-source/public-files/.github/workflows/ce-release.yml" : ".github/workflows/ce-release.yml";
  for (const path of [publicWorkflow, ".gitea/workflows/ce-registry-release.yml"].filter(existsSync)) {
    const source = readFileSync(path, "utf8");
    assert.ok(source.indexOf("load-ce-binary-candidate.mjs") < source.indexOf("docker push"));
    assert.doesNotMatch(source, /docker buildx build/);
    assert.match(source, /--type cyclonedx/);
  }
  if (!existsSync(".gitea/workflows/ce-registry-release.yml")) return;
  const mirror = readFileSync(".gitea/workflows/ce-registry-release.yml", "utf8");
  assert.doesNotMatch(mirror, /git clone --depth 1/);
  assert.match(mirror, /--tag "\$channel"/);
  assert.match(mirror, /channel=next/);
});

test("publication rejects changed archives and absent source evidence before Docker load", () => {
  const directory = mkdtempSync(join(tmpdir(), "ce-publication-evidence-"));
  try {
    const script = resolve("scripts/load-ce-binary-candidate.mjs");
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const content = join(directory, "contents");
    mkdirSync(content);
    const configuration = JSON.stringify({ os: "linux", architecture: "arm64" });
    writeFileSync(join(content, "config.json"), configuration);
    const configDigest = `sha256:${createHash("sha256").update(configuration).digest("hex")}`;
    const candidate = { schemaVersion: 1, version: "0.2.0", commit, images: [] };
    for (const app of ["api", "web"]) {
      const imageRef = `fixture-${app}:candidate`;
      const archive = `${app}.tar`;
      writeFileSync(join(content, "manifest.json"), JSON.stringify([{ Config: "config.json", RepoTags: [imageRef], Layers: [] }]));
      assert.equal(spawnSync("tar", ["-cf", join(directory, archive), "-C", content, "manifest.json", "config.json"]).status, 0);
      assert.equal(imageArchiveConfig(join(directory, archive), imageRef), configDigest);
      assert.throws(() => imageArchiveConfig(join(directory, archive), "unreviewed:tag"), /one tagged runtime image/);
      const sha256 = createHash("sha256").update(readFileSync(join(directory, archive))).digest("hex");
      candidate.images.push({ app, imageRef, imageId: `sha256:${"a".repeat(64)}`, configDigest, archive, sha256 });
    }
    const sha256 = candidate.images[0].sha256;
    candidate.images[0].sha256 = "0".repeat(64);
    writeFileSync(join(directory, "ce-candidate.json"), JSON.stringify(candidate));
    const changed = spawnSync(process.execPath, [script, directory, "0.2.0"], { encoding: "utf8" });
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /Candidate image archive changed/);
    candidate.images[0].sha256 = sha256;
    writeFileSync(join(directory, "ce-candidate.json"), JSON.stringify(candidate));
    const missing = spawnSync(process.execPath, [script, directory, "0.2.0"], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /source-lock.json/);
    candidate.images[0].configDigest = `sha256:${"0".repeat(64)}`;
    writeFileSync(join(directory, "ce-candidate.json"), JSON.stringify(candidate));
    const configurationResult = spawnSync(process.execPath, [script, directory, "0.2.0"], { encoding: "utf8" });
    assert.notEqual(configurationResult.status, 0);
    assert.match(configurationResult.stderr, /Archive runtime configuration changed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("publication accepts only the successful controlled candidate workflow at the public commit", () => {
  const directory = mkdtempSync(join(tmpdir(), "ce-candidate-run-"));
  try {
    const file = join(directory, "run.json");
    const commit = "a".repeat(40);
    const valid = { status: "completed", conclusion: "success", event: "workflow_dispatch", head_sha: commit,
      repository: { full_name: "example/task-weaver" }, path: ".github/workflows/ce-binary-candidate.yml" };
    const verify = (run) => {
      writeFileSync(file, JSON.stringify(run));
      return spawnSync(process.execPath, [resolve("scripts/check-ce-candidate-run.mjs"), file, commit, "example/task-weaver"]).status;
    };
    assert.equal(verify(valid), 0);
    for (const override of [{ conclusion: "failure" }, { head_sha: "b".repeat(40) }, { path: ".github/workflows/untrusted.yml" }]) {
      assert.notEqual(verify({ ...valid, ...override }), 0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
