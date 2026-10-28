import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertPublicArtifactTree, inspectPublicArtifactTree } from "./public-artifact-privacy.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tw-public-privacy-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("public artifacts reject local state and home paths without exposing their values", t => {
  const root = fixture(t);
  mkdirSync(join(root, ".kube"));
  writeFileSync(join(root, ".env.local"), "private fixture");
  const privatePath = ["", "Users", "private-operator", "workspace"].join("/") + "/";
  writeFileSync(join(root, "metadata.json"), JSON.stringify({ location: privatePath }));
  writeFileSync(join(root, "windows.json"), JSON.stringify({ location: ["C:", "Users", "private-operator", "workspace"].join("\\") + "\\" }));
  const findings = inspectPublicArtifactTree(root);
  assert.deepEqual(new Set(findings.map(item => item.rule)), new Set(["private-state-directory", "private-state-file", "operator-home-path"]));
  assert.doesNotMatch(JSON.stringify(findings), /private-operator/);
  assert.throws(() => assertPublicArtifactTree(root), /Public artifact privacy check failed/);
});

test("compiled packages are scanned for modern credentials and private keys", t => {
  const root = fixture(t);
  mkdirSync(join(root, "dist"));
  const secret = "tw_" + "a".repeat(64);
  writeFileSync(join(root, "dist", "index.js"), `const credential = ${JSON.stringify(secret)};`);
  writeFileSync(join(root, "token.txt"), "github_pat_" + "x".repeat(50));
  writeFileSync(join(root, "identity.pem"), "private fixture");
  const findings = inspectPublicArtifactTree(root);
  assert.deepEqual(new Set(findings.map(item => item.rule)), new Set(["task-weaver-token", "github-fine-grained-token", "private-state-file"]));
  assert.ok(findings.some(item => item.path === "dist/index.js"));
  assert.ok(!JSON.stringify(findings).includes(secret));
});

test("safe examples pass and artifact symlinks fail closed", t => {
  const root = fixture(t);
  writeFileSync(join(root, ".env.example"), "DATABASE_URL=postgres://user:password@database.example/task_weaver");
  writeFileSync(join(root, "guide.md"), "Use the operator-provisioned database.");
  assertPublicArtifactTree(root);
  symlinkSync("guide.md", join(root, "link"));
  assert.throws(() => assertPublicArtifactTree(root), /nonregular-artifact-entry/);
});
