import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeLicenseInventory, packageUrl, scanSecrets, stableJson } from "./release-gates.mjs";

const policy = {
  licensePolicy: {
    metadataOverrides: [{ name: "khroma", versions: ["2.1.0"], declaredLicense: "MIT", evidence: "https://example.test/license" }],
  },
  secretPolicy: { reviewedExceptions: [] },
};

test("license inventory is normalized, deduplicated, and overrides missing metadata", () => {
  const inventory = normalizeLicenseInventory({
    Unknown: [{ name: "khroma", versions: ["2.1.0", "2.1.0"] }],
    "(MPL-2.0 OR Apache-2.0)": [{ name: "dompurify", versions: ["3.3.3"] }],
  }, policy);
  assert.deepEqual(inventory, [
    { name: "dompurify", version: "3.3.3", license: "MPL-2.0 OR Apache-2.0" },
    { name: "khroma", version: "2.1.0", license: "MIT", licenseEvidence: "https://example.test/license" },
  ]);
});

test("stable JSON recursively sorts object keys", () => {
  assert.equal(stableJson({ z: 1, a: { d: 2, b: 1 } }), '{\n  "a": {\n    "b": 1,\n    "d": 2\n  },\n  "z": 1\n}\n');
});

test("npm package URLs encode scoped namespaces", () => {
  assert.equal(packageUrl("@modelcontextprotocol/sdk", "1.30.1"), "pkg:npm/%40modelcontextprotocol/sdk@1.30.1");
});

test("secret scan reports location and rule without exposing the matched value", () => {
  const root = join(tmpdir(), `task-weaver-secret-test-${process.pid}-${Date.now()}`);
  mkdirSync(root);
  writeFileSync(join(root, "fixture.txt"), "api_key = \"abcdefghijklmnopqrstuvwxyz123456\"\n");
  const findings = scanSecrets(root, policy);
  assert.deepEqual(findings, [{ path: "fixture.txt", line: 1, rule: "assigned-secret" }]);
  assert.doesNotMatch(JSON.stringify(findings), /abcdefghijklmnopqrstuvwxyz/);
});
