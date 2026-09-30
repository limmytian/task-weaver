import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// Works in both the preparation repository and an extracted public candidate.
const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const source = (() => {
  try { read("open-source/public-files/docker-compose.yml"); return "open-source/public-files/"; }
  catch { return ""; }
})();

test("public deployment uses only the published digest-pinned ARM64 application images", () => {
  const compose = read(`${source}docker-compose.yml`);
  assert.doesNotMatch(compose, /^  db:/m);
  assert.doesNotMatch(compose, /pgvector\/|POSTGRES_PASSWORD/);
  assert.doesNotMatch(compose, /^\s+build:/m);
  assert.doesNotMatch(compose, /(?:latest|0\.1\.0-arm64|sha-aefb27f-arm64)/);
  assert.equal((compose.match(/DATABASE_URL:\s*\$\{/g) ?? []).length, 3);
  assert.match(compose, /Configure an external PostgreSQL connection/);
  const expectedImages = [
    "ghcr.io/limmytian/task-weaver-api@sha256:7d89b0bfe4adf251d7831fbed0b473fae631aca0befc862d06e07ebf58442359",
    "ghcr.io/limmytian/task-weaver-web@sha256:3d9dbbf08c73c888fd9d9f18b66ed7520113a2f698deab84bc5f4a34455d5e35",
  ];
  assert.equal(compose.split(expectedImages[0]).length - 1, 2);
  assert.equal(compose.split(expectedImages[1]).length - 1, 1);
  assert.equal((compose.match(/platform: \$\{TW_IMAGE_PLATFORM:-linux\/arm64\}/g) ?? []).length, 3);
  const configuredImages = [...compose.matchAll(/^\s+image:\s+\$\{TW_(API|WEB)_IMAGE:-([^}]+)\}/gm)];
  assert.equal(configuredImages.length, 3);
  for (const match of configuredImages) {
    const expected = match[1] === "API" ? expectedImages[0] : expectedImages[1];
    assert.equal(match[2], expected);
  }
  const policy = JSON.parse(read(`${source}.release/distribution.json`));
  assert.equal(policy.sourceOnly, false);
  assert.equal(policy.containersPublished, true);
  assert.equal(policy.composeProvided, true);
  assert.equal(policy.containerPlatform, "linux/arm64");
  assert.equal(policy.databaseDelivery, "operator-provisioned");
  assert.equal(policy.npmPublished, false);
});

test("public export excludes every bundled PostgreSQL Compose service", () => {
  if (source) return;
  assert.equal(existsSync(resolve(root, "examples/local/docker-compose.yml")), false);
  assert.equal(existsSync(resolve(root, "examples/daemon-pipeline/docker-compose.yml")), false);
  assert.equal(existsSync(resolve(root, "scripts/docker-isolated-smoke.sh")), false);
  const policy = JSON.parse(read(".release/distribution.json"));
  assert.equal(policy.composeProvided, true);
  assert.equal(policy.containersPublished, true);
  assert.equal(policy.npmPublished, false);
});

test("application base image is digest-pinned and package managers are absent from runner", () => {
  for (const name of ["api", "web"]) {
    const dockerfile = read(`${source}apps/${name}/Dockerfile`);
    assert.match(dockerfile, /FROM node:24\.21\.0-alpine3\.23@sha256:[a-f0-9]{64} AS runtime-base/);
    assert.match(dockerfile, /FROM scratch AS runner\nCOPY --from=runtime-base \/ \//);
    assert.match(dockerfile, /ENTRYPOINT \["docker-entrypoint.sh"\]/);
    assert.match(dockerfile, /\/usr\/local\/lib\/node_modules\/npm/);
    assert.match(dockerfile, /apk add --no-network ca-certificates-bundle && apk del apk-tools/);
    assert.match(dockerfile, /USER node/);
  }
});
