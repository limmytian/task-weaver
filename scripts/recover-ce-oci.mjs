import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// This helper only reads public registry state. It never republishes an image.
export function recoverPublishedEvidence(version, repository, digests, execute = execFileSync, directory = "release-artifacts/bundle") {
  assert.match(version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(repository, "limmytian/task-weaver");
  for (const app of ["api", "web"]) assert.match(digests[app] ?? "", /^sha256:[a-f0-9]{64}$/);
  const run = (command, args) => execute(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  const read = name => JSON.parse(readFileSync(`${directory}/${name}`, "utf8"));
  const save = (name, value) => writeFileSync(`${directory}/${name}`, `${JSON.stringify(value, null, 2)}\n`);
  const set = read("ce-candidate-set.json");
  assert.equal(set.version, version);
  assert.equal(set.commit, run("git", ["rev-parse", "HEAD"]).trim());
  const identity = `https://github.com/${repository}/.github/workflows/ce-release.yml@refs/tags/v${version}`;
  const signatureArgs = ["--certificate-identity", identity, "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com"];
  const pending = [];
  for (const app of ["api", "web"]) {
    const base = `ghcr.io/${repository}-${app}`;
    const reference = `${base}@${digests[app]}`;
    const raw = run("docker", ["buildx", "imagetools", "inspect", reference, "--raw"]);
    assert.equal(`sha256:${createHash("sha256").update(raw).digest("hex")}`, digests[app], "Index bytes must match the explicit recovery digest");
    const index = JSON.parse(raw);
    assert.equal(index.schemaVersion, 2);
    assert.equal(index.manifests.length, 2);
    assert.deepEqual(index.manifests.map(entry => `${entry.platform.os}/${entry.platform.architecture}`).sort(), ["linux/amd64", "linux/arm64"]);
    const signatures = JSON.parse(run("cosign", ["verify", ...signatureArgs, "--output", "json", reference]));
    assert.ok(signatures.some(entry => entry.critical?.image?.["docker-manifest-digest"] === digests[app]));
    const attestations = run("cosign", ["verify-attestation", ...signatureArgs, "--type", "custom", reference]).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const predicates = attestations.map(entry => JSON.parse(Buffer.from(entry.payload, "base64").toString("utf8"))).filter(statement => statement.subject?.some(subject => subject.digest?.sha256 === digests[app].slice(7))).map(statement => statement.predicate.Data ? JSON.parse(statement.predicate.Data) : statement.predicate).filter(predicate => predicate.version === version && predicate.commit === set.commit && predicate.platforms);
    assert.ok(predicates.length > 0, "Original signed index provenance is required");
    assert.ok(predicates.every(predicate => JSON.stringify(predicate) === JSON.stringify(predicates[0])), "Ambiguous signed provenance");
    const provenance = predicates[0];
    for (const child of index.manifests) {
      const platform = `${child.platform.os}/${child.platform.architecture}`;
      const arch = child.platform.architecture;
      const candidate = read(`ce-candidate-${arch}.json`);
      assert.equal(candidate.commit, set.commit);
      assert.equal(candidate.version, version);
      const selected = candidate.images.find(entry => entry.app === app && entry.platform === platform);
      assert.ok(selected);
      const recorded = provenance.platforms[platform];
      assert.equal(recorded.digest, child.digest);
      assert.equal(recorded.configDigest, selected.configDigest);
      const childRaw = run("docker", ["buildx", "imagetools", "inspect", `${base}@${child.digest}`, "--raw"]);
      assert.equal(`sha256:${createHash("sha256").update(childRaw).digest("hex")}`, child.digest);
      assert.equal(JSON.parse(childRaw).config.digest, selected.configDigest);
      const childSignatures = JSON.parse(run("cosign", ["verify", ...signatureArgs, "--output", "json", `${base}@${child.digest}`]));
      assert.ok(childSignatures.some(entry => entry.critical?.image?.["docker-manifest-digest"] === child.digest));
      assert.ok(recorded.image.startsWith(`${base}:candidate-`) && new RegExp(`^candidate-[1-9]\\d*-[1-9]\\d*-${arch}$`).test(recorded.image.slice(base.length + 1)), "Original signed platform tag is required");
      const tagRaw = run("docker", ["buildx", "imagetools", "inspect", recorded.image, "--raw"]);
      assert.equal(`sha256:${createHash("sha256").update(tagRaw).digest("hex")}`, child.digest, "Existing immutable platform tag differs");
    }
    const tagRaw = run("docker", ["buildx", "imagetools", "inspect", `${base}:${version}`, "--raw"]);
    assert.equal(`sha256:${createHash("sha256").update(tagRaw).digest("hex")}`, digests[app], "Existing immutable index tag differs");
    pending.push({ app, reference, index, provenance, inventory: { image: `${base}:${version}`, digest: digests[app], platforms: provenance.platforms } });
  }
  save("release-recovery.json", { schemaVersion: 1, version, commit: set.commit, originalImageIdentity: identity, digests, registryWrites: false, workflowCommit: process.env.GITHUB_WORKFLOW_SHA ?? null, workflowRef: process.env.GITHUB_WORKFLOW_REF ?? null });
  // Publish evidence files only after both applications pass every check.
  for (const { app, reference, index, provenance, inventory } of pending) {
    save(`${app}-image.json`, inventory);
    save(`${app}-image-index.json`, index);
    save(`${app}-multiarch-provenance.json`, provenance);
    writeFileSync(`${directory}/${app}-image.digest`, `${reference}\n`);
    for (const [platform, entry] of Object.entries(provenance.platforms)) {
      const arch = platform.split("/")[1];
      save(`${app}-image-${arch}.json`, { image: entry.image, digest: entry.digest, platform, configDigest: entry.configDigest, localImageId: entry.localImageId });
      writeFileSync(`${directory}/${app}-image-${arch}.digest`, `${reference.split("@")[0]}@${entry.digest}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, repository, api, web] = process.argv.slice(2);
  recoverPublishedEvidence(version, repository, { api, web });
}
