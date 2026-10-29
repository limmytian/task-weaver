import { assertBusyboxWgetEvidence } from "./busybox-wget-evidence.mjs";
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
    const publication = path === publicWorkflow ? readFileSync("scripts/publish-ce-oci.mjs", "utf8") : source;
    assert.ok(source.indexOf("load-ce-binary-candidate.mjs") < source.indexOf(path === publicWorkflow ? "publish-ce-oci.mjs" : "docker push"));
    assert.doesNotMatch(source, /docker buildx build/);
    assert.match(publication, /cyclonedx/);
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

test("multi-platform indexes bind exactly the reviewed AMD64 and ARM64 child digests", async () => {
  const { verifyOciIndex } = await import("./oci-index.mjs");
  const expected = { "linux/amd64": `sha256:${"a".repeat(64)}`, "linux/arm64": `sha256:${"b".repeat(64)}` };
  const index = { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: Object.entries(expected).map(([platform, digest]) => ({ digest, size: 512, platform: { os: "linux", architecture: platform.split("/")[1] } })) };
  assert.equal(verifyOciIndex(index, expected), index);
  for (const mutate of [copy => copy.manifests.pop(), copy => copy.manifests[1].platform.architecture = "amd64", copy => copy.manifests[0].digest = expected["linux/arm64"], copy => copy.manifests[0].platform.os = "windows", copy => copy.manifests[0].platform.variant = "v9"]) {
    const copy = structuredClone(index);
    mutate(copy);
    assert.throws(() => verifyOciIndex(copy, expected));
  }
});

test("source evidence requires one supported CPU and chooses its native Rust targets", async () => {
  const { rustTargets, sourcePlatform } = await import("./release-platforms.mjs");
  assert.deepEqual(rustTargets("linux/amd64"), ["x86_64-unknown-linux-musl", "x86_64-unknown-linux-gnu"]);
  assert.deepEqual(rustTargets("linux/arm64"), ["aarch64-unknown-linux-musl", "aarch64-unknown-linux-gnu"]);
  assert.throws(() => sourcePlatform({ images: [{ platform: "linux/amd64" }, { platform: "linux/arm64" }] }));
  assert.throws(() => rustTargets("linux/riscv64"));
});

test("independent consumption receipts reject changed commits, platforms and runtime identities", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-native-consumption-"));
  const script = resolve("scripts/verify-ce-consumption.mjs");
  const save = (path, value) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  };
  try {
    for (const args of [["init", "-q"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Fixture"]]) assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const version = "0.3.1";
    const reports = {};
    for (const arch of ["amd64", "arm64"]) {
      const platform = `linux/${arch}`;
      const images = ["api", "web"].map((app, i) => ({ app, platform, imageId: `sha256:${String(i + 1).repeat(64)}`, configDigest: `sha256:${String(i + 3).repeat(64)}` }));
      const loaded = { commit, version, platform, images, passed: true };
      const deployment = { platform, imageIds: images, build: { commit, version }, buildMetadataPassed: true, passed: true, migrationPassed: true, searchSetupPassed: true, apiHealthy: true, webHealthy: true, restCreateReadPassed: true };
      save(`release-artifacts/bundle/ce-candidate-${arch}.json`, { images });
      save(`receipts/ce-consumption-${arch}/bundle/ce-load-verification.json`, loaded);
      save(`receipts/ce-consumption-${arch}/deployment-verification.json`, deployment);
      reports[arch] = deployment;
    }
    const run = () => spawnSync(process.execPath, [script, "receipts", version], { cwd: root, encoding: "utf8" });
    assert.equal(run().status, 0);
    for (const mutate of [report => report.build.commit = "0".repeat(40), report => report.platform = "linux/arm64", report => report.imageIds[0].imageId = `sha256:${"f".repeat(64)}`, report => report.migrationPassed = false]) {
      const changed = structuredClone(reports.amd64);
      mutate(changed);
      save("receipts/ce-consumption-amd64/deployment-verification.json", changed);
      assert.notEqual(run().status, 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("registry preflight fails closed on existing tags or authentication errors before writes", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-publication-preflight-"));
  const script = resolve("scripts/publish-ce-oci.mjs");
  try {
    for (const args of [["init", "-q"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Fixture"]]) assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    mkdirSync(join(root, "release-artifacts/bundle"), { recursive: true });
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "release-artifacts/bundle/source-provenance.json"), "{}");
    writeFileSync(join(root, "release-artifacts/bundle/ce-candidate-set.json"), JSON.stringify({ version: "0.3.1", commit }));
    const calls = join(root, "calls.txt");
    for (const [status, error, message] of [[0, "", /Immutable image tag already exists/], [1, "unauthorized", /Cannot establish registry tag availability/], [1, "manifest unknown", /ce-candidate-amd64.json/]]) {
      writeFileSync(calls, "");
      writeFileSync(join(root, "bin/docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TW_TEST_CALLS"\nprintf '%s\\n' '${error}' >&2\nexit ${status}\n`, { mode: 0o755 });
      const result = spawnSync(process.execPath, [script, "0.3.1", "example/task-weaver"], { cwd: root, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, TW_TEST_CALLS: calls, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" }, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      const commands = readFileSync(calls, "utf8");
      assert.doesNotMatch(commands, /push|imagetools create|tag /);
      assert.equal(commands.trim().split("\n").length, error === "manifest unknown" ? 12 : 1);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("formal staging signs candidate indexes without writing stable or latest tags", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-ce-stage-"));
  const script = resolve("scripts/publish-ce-oci.mjs");
  const run = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    assert.equal(run("init", "-q").status, 0);
    assert.equal(run("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Fixture").status, 0);
    const commit = run("rev-parse", "HEAD").stdout.trim();
    const out = join(root, "release-artifacts/bundle"); mkdirSync(out, { recursive: true }); mkdirSync(join(root, "bin"));
    writeFileSync(join(out, "source-provenance.json"), "{}");
    writeFileSync(join(out, "ce-candidate-set.json"), JSON.stringify({ version: "0.3.17", commit }));
    const d = c => `sha256:${c.repeat(64)}`;
    for (const [arch, value] of [["amd64", "a"], ["arm64", "b"]]) {
      writeFileSync(join(out, `ce-candidate-${arch}.json`), JSON.stringify({ platform: `linux/${arch}`, commit, version: "0.3.17", images: ["api", "web"].map(app => ({ app, platform: `linux/${arch}`, imageId: d(value), configDigest: d(value) })) }));
    }
    const calls = join(root, "calls");
    writeFileSync(join(root, "bin/docker"), `#!/usr/bin/env node\nconst fs=require('fs'),a=process.argv.slice(2),d=c=>'sha256:'+c.repeat(64);fs.appendFileSync(process.env.TW_TEST_CALLS,'docker '+a.join(' ')+'\\n');if(a[0]==='image'&&a[1]==='inspect'){const arch=a[3].split('/')[1];console.log(JSON.stringify([{Os:'linux',Architecture:arch,Id:d(arch==='amd64'?'a':'b')}]))}else if(a[0]==='buildx'&&a[1]==='imagetools'&&a[2]==='inspect'){const ref=a[3];if(ref.includes(':candidate-')&&a.includes('--format')){console.log(JSON.stringify({digest:d(ref.endsWith('-amd64')?'c':ref.endsWith('-arm64')?'d':'e')}))}else if(ref.includes('@')&&a.includes('--raw')){if(ref.endsWith(d('e')))console.log(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{digest:d('c'),size:1,platform:{os:'linux',architecture:'amd64'}},{digest:d('d'),size:1,platform:{os:'linux',architecture:'arm64'}}]}));else console.log(JSON.stringify({config:{digest:ref.endsWith(d('c'))?d('a'):d('b')}}))}else {console.error('manifest unknown');process.exit(1)}}\n`, { mode: 0o755 });
    writeFileSync(join(root, "bin/cosign"), `#!/bin/sh\nprintf 'cosign %s\\n' "$*" >> "$TW_TEST_CALLS"\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [script, "0.3.17", "example/task-weaver"], { cwd: root, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, TW_TEST_CALLS: calls, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(calls, "utf8");
    assert.match(log, /imagetools create --tag ghcr.io\/example\/task-weaver-api:candidate-123-1/);
    assert.doesNotMatch(log, /(?:push|create --tag) ghcr.io\/example\/task-weaver-(?:api|web):(?:0\.3\.17|latest)/);
    assert.match(log, /cosign attest/);
    assert.equal(JSON.parse(readFileSync(join(out, "api-image.json"), "utf8")).image, "ghcr.io/example/task-weaver-api:0.3.17");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("BusyBox verification must pass for the exact candidate image and platform", () => {
  const image = `sha256:${"a".repeat(64)}`;
  const report = { passed: true, imageId: image, platform: "linux/arm64" };
  assert.doesNotThrow(() => assertBusyboxWgetEvidence(report, image, "linux/arm64"));
  assert.throws(() => assertBusyboxWgetEvidence(null, image, "linux/arm64"));
  assert.throws(() => assertBusyboxWgetEvidence({ ...report, passed: false }, image, "linux/arm64"));
  assert.throws(() => assertBusyboxWgetEvidence(report, `sha256:${"b".repeat(64)}`, "linux/arm64"));
  assert.throws(() => assertBusyboxWgetEvidence(report, image, "linux/amd64"));
});
