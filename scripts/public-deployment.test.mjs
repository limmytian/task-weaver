import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// Works in both the preparation repository and an extracted public candidate.
const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const sourceOnly = existsSync(resolve(root, ".release/distribution.json")) &&
  JSON.parse(read(".release/distribution.json")).sourceOnly === true;
const source = (() => {
  try { read("open-source/public-files/docker-compose.yml"); return "open-source/public-files/"; }
  catch { return ""; }
})();

test("default deployment requires external PostgreSQL and publishes no database service", { skip: sourceOnly }, () => {
  const compose = read(`${source}docker-compose.yml`);
  assert.doesNotMatch(compose, /^  db:/m);
  assert.doesNotMatch(compose, /pgvector\/|POSTGRES_PASSWORD/);
  assert.equal((compose.match(/DATABASE_URL:\s*\$\{/g) ?? []).length, 3);
  assert.match(compose, /Configure an external PostgreSQL connection/);
});

test("optional database example is explicitly separate", { skip: sourceOnly }, () => {
  const example = read(`${source}examples/local/docker-compose.yml`);
  assert.match(example, /not a Task Weaver release artifact/);
  assert.match(example, /POSTGRES_IMAGE/);
  assert.match(example, /127\.0\.0\.1/);
});

test("source-only staging does not ship Compose or advertise its commands", { skip: !sourceOnly }, () => {
  assert.equal(existsSync(resolve(root, "docker-compose.yml")), false);
  assert.equal(existsSync(resolve(root, "examples/local/docker-compose.yml")), false);
  assert.equal(existsSync(resolve(root, "examples/daemon-pipeline/docker-compose.yml")), false);
  assert.equal(existsSync(resolve(root, "scripts/docker-isolated-smoke.sh")), false);
  assert.doesNotMatch(read("README.md") + read("docs/deployment.md"), /docker compose|docker-compose\.yml/);
  for (const path of readdirSync(resolve(root, "docs"), { recursive: true })) {
    if (path.endsWith(".md")) {
      assert.doesNotMatch(read(`docs/${path}`), /docker-isolated-smoke\.sh|docker compose|docker-compose\.yml/, path);
    }
  }
  const policy = JSON.parse(read(".release/distribution.json"));
  assert.equal(policy.composeProvided, false);
  assert.equal(policy.containersPublished, false);
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
