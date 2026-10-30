import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const apps = ["api", "web"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const imagePattern = app => new RegExp(`^ghcr\\.io/limmytian/task-weaver-${app}@sha256:[a-f0-9]{64}$`);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const json = path => JSON.parse(readFileSync(path, "utf8"));

export function verifyDeploymentPair(directory, policy, execute = execFileSync) {
  assert.match(policy.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.match(policy.commit, /^[a-f0-9]{40}$/);
  // Exact workflow/tag identity is selected by the operator, never a regexp.
  assert.equal(policy.identity, `https://github.com/limmytian/task-weaver/.github/workflows/ce-release.yml@refs/tags/v${policy.version}`);
  const signatureArgs = ["--certificate-identity", policy.identity, "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com"];
  const verify = args => {
    try { return execute("cosign", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }); }
    catch { throw new Error("Deployment signature verification failed; no workload changes are permitted"); }
  };
  const manifestIdentity = policy.manifestIdentity ?? policy.identity;
  const recoveryPrefix = `https://github.com/limmytian/task-weaver/.github/workflows/ce-release.yml@refs/tags/v${policy.version}-recovery.`;
  assert.ok(manifestIdentity === policy.identity || (manifestIdentity.startsWith(recoveryPrefix) && /^[1-9]\d*$/.test(manifestIdentity.slice(recoveryPrefix.length))), "Release files require the exact original or version-scoped recovery tag identity");
  const manifestSignatureArgs = ["--certificate-identity", manifestIdentity, "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com"];
  const manifestPath = join(directory, "ce-release.json");
  const manifestBytes = readFileSync(manifestPath);
  verify(["verify-blob", ...manifestSignatureArgs, "--bundle", join(directory, "ce-release.json.sigstore.json"), join(directory, "ce-release.json")]);
  assert.equal(sha256(readFileSync(manifestPath)), sha256(manifestBytes), "Release manifest changed during signature verification");
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.version, policy.version);
  assert.equal(manifest.commit, policy.commit);
  assert.equal(manifest.tag, `v${policy.version}`);
  assert.equal(manifest.rehearsal, false, "A rehearsal bundle cannot authorize a production plan");
  const artifact = name => {
    const entries = manifest.artifacts.filter(entry => entry.file === name);
    assert.equal(entries.length, 1, "Required signed artifact must be unique");
    const bytes = readFileSync(join(directory, name));
    assert.equal(sha256(bytes), entries[0].sha256, "Signed artifact bytes changed");
    assert.equal(bytes.length, entries[0].bytes);
    return bytes.toString("utf8");
  };
  const pair = {};
  for (const app of apps) {
    const image = artifact(`${app}-image.digest`).trim();
    assert.match(image, imagePattern(app));
    const provenance = JSON.parse(artifact(`${app}-multiarch-provenance.json`));
    assert.equal(provenance.version, policy.version);
    assert.equal(provenance.commit, policy.commit);
    const inventory = JSON.parse(artifact(`${app}-image.json`));
    assert.equal(image, `${inventory.image.split(":")[0]}@${inventory.digest}`);
    assert.deepEqual(provenance.platforms, inventory.platforms);
    const signatures = JSON.parse(verify(["verify", ...signatureArgs, "--output", "json", image]));
    assert.ok(Array.isArray(signatures) && signatures.some(entry => entry.critical?.image?.["docker-manifest-digest"] === inventory.digest), "OCI signature must cover the exact index digest");
    pair[app] = { image, platforms: inventory.platforms };
  }
  return { version: policy.version, commit: policy.commit, pair };
}

export function planDeploymentPreflight(verified, input, now = Date.now()) {
  assert.equal(input.schemaVersion, 1);
  assert.ok(Array.isArray(input.nodes) && input.nodes.length > 0, "Explicit intended nodes are required");
  assert.equal(new Set(input.nodes.map(node => node.name)).size, input.nodes.length, "Duplicate node");
  assert.ok(Number.isFinite(now));
  const fresh = time => {
    const observed = Date.parse(time);
    return Number.isFinite(observed) && observed <= now && now - observed <= 5 * 60_000;
  };
  assert.ok(fresh(input.observedAt), "Deployment snapshot is stale or from the future");
  const pulls = [];
  const missingEvidence = [];
  for (const node of input.nodes) {
    assert.ok(typeof node.name === "string" && node.name.length > 0);
    assert.match(node.platform, /^linux\/(?:arm64|amd64)$/);
    for (const app of apps) {
      const selected = verified.pair[app];
      const child = selected.platforms[node.platform];
      assert.ok(child, "Signed release lacks an intended node platform");
      assert.match(child.digest, digestPattern);
      assert.match(child.configDigest, digestPattern);
      const pull = { node: node.name, platform: node.platform, image: selected.image, childDigest: child.digest, configDigest: child.configDigest };
      pulls.push(pull);
      const receipts = (input.receipts ?? []).filter(entry => entry.node === node.name && entry.image === selected.image && entry.platform === node.platform);
      if (receipts.length !== 1 || !fresh(receipts[0].observedAt) || receipts[0].publicPull !== true || receipts[0].cached !== true ||
          receipts[0].childDigest !== child.digest || receipts[0].configDigest !== child.configDigest ||
          receipts[0].version !== verified.version || receipts[0].commit !== verified.commit) missingEvidence.push(pull);
    }
  }
  const workloads = apps.map(app => {
    const target = input.targets[app];
    const snapshot = input.deployments.find(entry => entry.metadata?.namespace === target.namespace && entry.metadata?.name === target.deployment);
    assert.equal(input.deployments.filter(entry => entry.metadata?.namespace === target.namespace && entry.metadata?.name === target.deployment).length, 1, "Workload snapshot must be unique");
    assert.equal(snapshot?.kind, "Deployment");
    assert.equal(snapshot.apiVersion, "apps/v1");
    assert.ok(typeof snapshot.metadata.uid === "string" && snapshot.metadata.uid);
    assert.ok(typeof snapshot.metadata.resourceVersion === "string" && snapshot.metadata.resourceVersion);
    const strategy = snapshot.spec.strategy;
    assert.ok(["Recreate", "RollingUpdate"].includes(strategy?.type), "Read the actual workload strategy before planning");
    const changes = [];
    const containers = snapshot.spec.template.spec.containers;
    assert.equal(containers.filter(container => container.name === target.container).length, 1, "Select the actual application container explicitly");
    const index = containers.findIndex(container => container.name === target.container);
    const add = (path, container, image) => changes.push({ path, name: container.name, before: container.image, after: image });
    add(`/spec/template/spec/containers/${index}/image`, containers[index], verified.pair[app].image);
    // Only init containers using the same application repository follow that
    // application. Database/bootstrap images and all other fields are preserved.
    const repository = verified.pair[app].image.split("@")[0];
    for (const [i, container] of (snapshot.spec.template.spec.initContainers ?? []).entries()) {
      if (container.image?.split(/[@:]/)[0] === repository) add(`/spec/template/spec/initContainers/${i}/image`, container, verified.pair[app].image);
    }
    const patch = [
      { op: "test", path: "/metadata/uid", value: snapshot.metadata.uid },
      { op: "test", path: "/metadata/resourceVersion", value: snapshot.metadata.resourceVersion },
      ...changes.flatMap(change => [{ op: "test", path: change.path, value: change.before }, { op: "replace", path: change.path, value: change.after }]),
    ];
    return { app, namespace: target.namespace, deployment: target.deployment, uid: snapshot.metadata.uid, resourceVersion: snapshot.metadata.resourceVersion,
      strategy, availability: strategy.type === "Recreate" ? "Replacement can stop the old replica before the new one is ready; downtime is possible even with cached images." : "Availability depends on the observed rollout settings, replicas, probes and node capacity; zero downtime is not guaranteed.",
      changes, patch: missingEvidence.length === 0 ? patch : null, rollbackVerificationRequired: true };
  });
  assert.equal(new Set(workloads.map(workload => `${workload.namespace}/${workload.deployment}`)).size, 2, "API and Web must select separate workloads");
  return { schemaVersion: 1, mode: "offline-evidence-review", version: verified.version, commit: verified.commit,
    observedAt: input.observedAt, liveChangeAuthorized: false, evidenceComplete: missingEvidence.length === 0,
    requiredPulls: pulls, missingEvidence, workloads,
    nextStep: "Verify the recorded node receipts through an authorized operator, re-read live UID/resourceVersion and obtain deployment approval before any patch. Pre-pull both images on every intended node before replacement." };
}

export function reconcileDeploymentImages(plan, current) {
  if (current?.metadata?.uid !== plan.uid) return "conflict_or_unknown";
  const value = path => path.split("/").slice(1).reduce((object, key) => object?.[key], current);
  if (!plan.changes.every(change => value(change.path.replace(/\/image$/, "/name")) === change.name)) return "conflict_or_unknown";
  if (plan.changes.every(change => value(change.path) === change.after)) return "target_images_observed";
  if (current.metadata.resourceVersion === plan.resourceVersion && plan.changes.every(change => value(change.path) === change.before)) return "original_revision_unchanged";
  return "conflict_or_unknown";
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [directory, policyFile, inputFile] = process.argv.slice(2);
  if (!directory || !policyFile || !inputFile) throw new Error("Usage: deployment-preflight.mjs <signed-bundle-directory> <policy.json> <observations.json>");
  // Only signature verification and local evidence reads occur. No kubectl,
  // node pull, workload mutation, automatic retry or rollback is performed.
  const verified = verifyDeploymentPair(resolve(directory), json(policyFile));
  const plan = planDeploymentPreflight(verified, json(inputFile));
  console.log(JSON.stringify(plan, null, 2));
  if (!plan.evidenceComplete) process.exitCode = 1;
}
