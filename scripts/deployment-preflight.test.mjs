import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planDeploymentPreflight, reconcileDeploymentImages, verifyDeploymentPair } from "./deployment-preflight.mjs";

const digest = character => `sha256:${character.repeat(64)}`;
const version = "1.2.3";
const commit = "a".repeat(40);
const identity = `https://github.com/limmytian/task-weaver/.github/workflows/ce-release.yml@refs/tags/v${version}`;
const now = Date.now();
const time = new Date(now).toISOString();
const platforms = { "linux/arm64": { digest: digest("c"), configDigest: digest("d") }, "linux/amd64": { digest: digest("e"), configDigest: digest("f") } };
const verified = { version, commit, pair: Object.fromEntries(["api", "web"].map((app, i) => [app, { image: `ghcr.io/limmytian/task-weaver-${app}@${digest(String(i + 1))}`, platforms }])) };
function observations() {
  const nodes = [{ name: "node-a", platform: "linux/arm64" }, { name: "node-b", platform: "linux/amd64" }];
  return {
    schemaVersion: 1, observedAt: time, nodes,
    targets: Object.fromEntries(["api", "web"].map(app => [app, { namespace: "fixture", deployment: `actual-${app}`, container: `custom-${app}` }])),
    deployments: ["api", "web"].map(app => ({
      apiVersion: "apps/v1", kind: "Deployment", metadata: { namespace: "fixture", name: `actual-${app}`, uid: `${app}-uid`, resourceVersion: "42" },
      spec: { strategy: { type: app === "web" ? "Recreate" : "RollingUpdate", ...(app === "api" ? { rollingUpdate: { maxUnavailable: 1 } } : {}) },
        template: { spec: { containers: [{ name: "sidecar", image: "unrelated:keep" }, { name: `custom-${app}`, image: `ghcr.io/limmytian/task-weaver-${app}@${digest("9")}` }],
          initContainers: [{ name: "database-init", image: "database:keep" }, { name: "application-init", image: `ghcr.io/limmytian/task-weaver-${app}:old` }],
          securityContext: { fsGroup: 1000 } } } },
    })),
    receipts: nodes.flatMap(node => ["api", "web"].map(app => ({ node: node.name, platform: node.platform, image: verified.pair[app].image,
      childDigest: platforms[node.platform].digest, configDigest: platforms[node.platform].configDigest, version, commit, observedAt: time, publicPull: true, cached: true }))),
  };
}

test("both exact signed public indexes and signed source/version artifacts must verify", () => {
  const directory = mkdtempSync(join(tmpdir(), "tw-preflight-"));
  const artifacts = [];
  const save = (name, content) => {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    writeFileSync(join(directory, name), text);
    artifacts.push({ file: name, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) });
  };
  for (const app of ["api", "web"]) {
    save(`${app}-image.digest`, verified.pair[app].image + "\n");
    save(`${app}-image.json`, { image: `ghcr.io/limmytian/task-weaver-${app}:${version}`, digest: verified.pair[app].image.split("@")[1], platforms });
    save(`${app}-multiarch-provenance.json`, { version, commit, platforms });
  }
  writeFileSync(join(directory, "ce-release.json"), JSON.stringify({ schemaVersion: 1, version, commit, tag: `v${version}`, rehearsal: false, artifacts }));
  const calls = [];
  const execute = (command, args) => {
    calls.push({ command, args });
    assert.equal(command, "cosign");
    assert.ok(!args.some(arg => /insecure|ignore|regexp/.test(arg)));
    return args[0] === "verify-blob" ? "" : JSON.stringify([{ critical: { image: { "docker-manifest-digest": args.at(-1).split("@")[1] } } }]);
  };
  try {
    assert.deepEqual(verifyDeploymentPair(directory, { version, commit, identity }, execute), verified);
    assert.equal(calls.length, 3);
    assert.throws(() => verifyDeploymentPair(directory, { version, commit: "b".repeat(40), identity }, execute));
    assert.throws(() => verifyDeploymentPair(directory, { version, commit, identity: identity + "-untrusted" }, execute));
    assert.throws(() => verifyDeploymentPair(directory, { version, commit, identity }, () => { throw Error("secret transport detail"); }), /signature verification failed/);
    assert.throws(() => verifyDeploymentPair(directory, { version, commit, identity }, (_command, args) => args[0] === "verify-blob" ? "" : "[]"), /exact index digest/);
    writeFileSync(join(directory, "web-image.digest"), verified.pair.api.image);
    assert.throws(() => verifyDeploymentPair(directory, { version, commit, identity }, execute), /Signed artifact bytes changed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("preflight covers both apps on every node and preserves unrelated init containers/strategy", () => {
  const input = observations();
  const before = structuredClone(input);
  const result = planDeploymentPreflight(verified, input, now);
  assert.equal(result.evidenceComplete, true);
  assert.equal(result.liveChangeAuthorized, false);
  assert.equal(result.mode, "offline-evidence-review");
  assert.equal(result.requiredPulls.length, 4);
  assert.deepEqual(input, before, "planning cannot mutate the snapshot");
  for (const plan of result.workloads) {
    assert.deepEqual(plan.changes.map(change => change.name), [`custom-${plan.app}`, "application-init"]);
    assert.ok(plan.patch.every(op => !/strategy|initContainers\/0|containers\/0/.test(op.path)));
    assert.deepEqual(plan.patch.slice(0, 2).map(op => op.path), ["/metadata/uid", "/metadata/resourceVersion"]);
    assert.equal(plan.rollbackVerificationRequired, true);
  }
  assert.match(result.workloads[1].availability, /downtime is possible/);
});

test("missing, duplicate, stale, private or wrong-identity node receipts withhold patches", () => {
  for (const mutate of [input => input.receipts.pop(), input => input.receipts.push(input.receipts[0]),
    input => { input.receipts[0].publicPull = false; }, input => { input.receipts[0].cached = false; },
    input => { input.receipts[0].childDigest = digest("0"); }, input => { input.receipts[0].configDigest = digest("0"); },
    input => { input.receipts[0].commit = "0".repeat(40); }, input => { input.receipts[0].version = "different"; },
    input => { input.receipts[0].observedAt = new Date(now - 300001).toISOString(); },
    input => { input.receipts[0].observedAt = new Date(now + 1).toISOString(); }]) {
    const input = observations(); mutate(input);
    const plan = planDeploymentPreflight(verified, input, now);
    assert.equal(plan.evidenceComplete, false);
    assert.ok(plan.missingEvidence.length > 0);
    assert.ok(plan.workloads.every(workload => workload.patch === null));
  }
  const stale = observations(); stale.observedAt = new Date(now - 300001).toISOString();
  assert.throws(() => planDeploymentPreflight(verified, stale, now), /snapshot is stale/);
  const duplicate = observations(); duplicate.nodes.push(duplicate.nodes[0]);
  assert.throws(() => planDeploymentPreflight(verified, duplicate, now), /Duplicate node/);
});

test("uncertain patch results require observation and never imply automatic replay or rollback", () => {
  const input = observations();
  const [plan] = planDeploymentPreflight(verified, input, now).workloads;
  const current = structuredClone(input.deployments[0]);
  assert.equal(reconcileDeploymentImages(plan, current), "original_revision_unchanged");
  current.metadata.resourceVersion = "43";
  assert.equal(reconcileDeploymentImages(plan, current), "conflict_or_unknown");
  current.spec.template.spec.containers[1].image = verified.pair.api.image;
  current.spec.template.spec.initContainers[1].image = verified.pair.api.image;
  assert.equal(reconcileDeploymentImages(plan, current), "target_images_observed");
  current.metadata.uid = "replacement-object";
  assert.equal(reconcileDeploymentImages(plan, current), "conflict_or_unknown");
});
