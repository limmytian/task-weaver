#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? "");
const expectedOutput = join(root, "release-artifacts", "public-releases", "v0.1.0");
assert.equal(output, expectedOutput, "Output must be the v0.1.0 public release staging directory");
assert.ok(lstatSync(output).isDirectory() && !lstatSync(output).isSymbolicLink());

const manifestPath = join(output, "task-weaver-0.1.0-publication-manifest.json");
const sumsPath = join(output, "SHA256SUMS");
assert.equal(existsSync(manifestPath), false, "Refusing to overwrite the publication manifest");
assert.equal(existsSync(sumsPath), false, "Refusing to overwrite SHA256SUMS");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const file = (name) => {
  const path = join(output, name);
  assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `Invalid asset: ${name}`);
  const bytes = readFileSync(path);
  return { name, bytes: bytes.length, sha256: sha256(bytes) };
};

const imageDefinitions = [
  {
    component: "api",
    registry: "ghcr.io/limmytian/task-weaver-api",
    registryDigest: "sha256:7d89b0bfe4adf251d7831fbed0b473fae631aca0befc862d06e07ebf58442359",
    platformManifestDigest: "sha256:261d541915e21b5a108043709598a60b3a50e1b4f7f26227705b6ed94d71f0aa",
    mediumFindings: 4
  },
  {
    component: "web",
    registry: "ghcr.io/limmytian/task-weaver-web",
    registryDigest: "sha256:3d9dbbf08c73c888fd9d9f18b66ed7520113a2f698deab84bc5f4a34455d5e35",
    platformManifestDigest: "sha256:d23eb1b278fdf44507c8d97467ce15c1b3b6a3c5323f2d562b843020908869ca",
    mediumFindings: 2
  }
];

const staticAssets = [
  "task-weaver-0.1.0-application-source.tar",
  "task-weaver-0.1.0-binary-verification.json",
  "task-weaver-0.1.0-corresponding-source.tar.gz",
  "task-weaver-0.1.0-deployment-verification.json",
  "task-weaver-0.1.0-LICENSE.txt",
  "task-weaver-0.1.0-NOTICE.txt",
  "task-weaver-0.1.0-review-checkpoint.json",
  "task-weaver-0.1.0-runtime-source-NOTICES.txt",
  "task-weaver-0.1.0-source-lock.json",
  "task-weaver-api-0.1.0-arm64.cdx.json",
  "task-weaver-api-0.1.0-arm64.vulnerabilities.json",
  "task-weaver-web-0.1.0-arm64.cdx.json",
  "task-weaver-web-0.1.0-arm64.vulnerabilities.json"
];

const expectedStaticHashes = new Map([
  ["task-weaver-0.1.0-application-source.tar", "028d92ff604dc7e6e33e9d9b66f81edcb3634785963ed9d1d33e651f89061101"],
  ["task-weaver-0.1.0-binary-verification.json", "0c4cbc44b067c3b3b4adf2c2b580e10ec68ee7b0e4ed567bec5450169f972e81"],
  ["task-weaver-0.1.0-corresponding-source.tar.gz", "22e6c34ff8532f416c68060098552fe642bb409378088e7b29fef751137b4021"],
  ["task-weaver-0.1.0-deployment-verification.json", "be1130aefe5d80dae9b6efcf0492a7bfd5150038aa59e13d0e3b7d746ba8cb8c"],
  ["task-weaver-0.1.0-LICENSE.txt", "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"],
  ["task-weaver-0.1.0-NOTICE.txt", "fb836b28bf7b83670ad96597e4c184bd929749d4053ea35cb57d2355b70147f6"],
  ["task-weaver-0.1.0-review-checkpoint.json", "fb6a0821de7a2999e0a2b2d918fc64a4637e62eb5fbac5f518811b9a1ed94571"],
  ["task-weaver-0.1.0-runtime-source-NOTICES.txt", "204e76bb29896bdd678967f44ae0732c4158788202d6f3db0432d241eb4545ce"],
  ["task-weaver-0.1.0-source-lock.json", "fd56197096a97b9e59a971c63c9585602538af629ee2a076a87ed32c98130643"]
]);

const assets = staticAssets.map(file);
for (const asset of assets) {
  const expected = expectedStaticHashes.get(asset.name);
  if (expected) assert.equal(asset.sha256, expected, `Retained asset changed: ${asset.name}`);
}

for (const image of imageDefinitions) {
  const sbomName = `task-weaver-${image.component}-0.1.0-arm64.cdx.json`;
  const advisoryName = `task-weaver-${image.component}-0.1.0-arm64.vulnerabilities.json`;
  const sbom = JSON.parse(readFileSync(join(output, sbomName), "utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  const advisory = JSON.parse(readFileSync(join(output, advisoryName), "utf8"));
  const counts = {};
  for (const match of advisory.matches ?? []) {
    const severity = match.vulnerability.severity;
    counts[severity] = (counts[severity] ?? 0) + 1;
  }
  assert.equal(counts.High ?? 0, 0);
  assert.equal(counts.Critical ?? 0, 0);
  assert.equal(counts.Medium ?? 0, image.mediumFindings);
}

const manifest = {
  schemaVersion: 1,
  release: "v0.1.0",
  distributionApproved: true,
  approvalScope: "owner-approved-api-web-linux-arm64-container-publication",
  source: {
    repository: "https://github.com/limmytian/task-weaver",
    commit: "aefb27fd44bbff7db648601e6c03e1de6458e6bc",
    tree: "57ad0621af622135f6bd539a8b5658566860b763"
  },
  platform: "linux/arm64",
  images: imageDefinitions.map((image) => ({
    component: image.component,
    registry: image.registry,
    tags: ["0.1.0-arm64", "sha-aefb27f-arm64"],
    registryDigest: image.registryDigest,
    platformManifestDigest: image.platformManifestDigest,
    layers: 9,
    vulnerabilities: { Medium: image.mediumFindings, High: 0, Critical: 0 },
    labels: {
      "org.opencontainers.image.source": "https://github.com/limmytian/task-weaver",
      "org.opencontainers.image.revision": "aefb27fd44bbff7db648601e6c03e1de6458e6bc",
      "org.opencontainers.image.licenses": "Apache-2.0"
    }
  })),
  scanner: {
    syft: "1.52.0",
    grype: "0.119.0",
    databaseSchema: "v6.1.9",
    databaseBuilt: "2026-09-28T06:42:30Z"
  },
  databaseDelivery: "operator-provisioned",
  composePublished: false,
  npmPublished: false,
  signed: false,
  assets,
  limitations: [
    "Only Linux ARM64 is supported by this release.",
    "Public Docker Compose is deferred until after container publication.",
    "Image signing and full native byte-for-byte reproducibility are not established.",
    "Internet-facing authorization hardening and complete upgrade/downgrade certification are not established."
  ]
};

const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(manifestPath, manifestBytes, { flag: "wx" });
const releaseAssets = [...assets, {
  name: basename(manifestPath),
  bytes: manifestBytes.length,
  sha256: sha256(manifestBytes)
}].sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(sumsPath, `${releaseAssets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`, { flag: "wx" });

const actual = readdirSync(output).filter((name) => name !== "RELEASE_NOTES.md").sort();
assert.deepEqual(actual, [...releaseAssets.map((asset) => asset.name), "SHA256SUMS"].sort());
console.log(JSON.stringify({ output, assets: releaseAssets.length + 1, images: manifest.images }, null, 2));
