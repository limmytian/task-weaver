import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Works in both the preparation repository and an extracted public candidate.
const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const source = (() => {
  try { read("open-source/public-files/docker-compose.yml"); return "open-source/public-files/"; }
  catch { return ""; }
})();

test("public deployment uses only the published digest-pinned multi-platform application images", () => {
  const compose = read(`${source}docker-compose.yml`);
  assert.doesNotMatch(compose, /^  db:/m);
  assert.doesNotMatch(compose, /pgvector\/|POSTGRES_PASSWORD/);
  assert.doesNotMatch(compose, /^\s+build:/m);
  assert.doesNotMatch(compose, /(?:latest|0\.1\.0-arm64|sha-aefb27f-arm64)/);
  assert.equal((compose.match(/DATABASE_URL:\s*\$\{/g) ?? []).length, 3);
  assert.match(compose, /Configure an external PostgreSQL connection/);
  const expectedImages = [
    "ghcr.io/limmytian/task-weaver-api@sha256:beb2ee810fdc0880d955c7dfdd245a0bfb838e3bbbad1ae457ddf46656ba00a4",
    "ghcr.io/limmytian/task-weaver-web@sha256:a5f7b11ceacdd5098fab7388b95c6509036d27a20c049bd01fe00fb3bfee562b",
  ];
  assert.equal(compose.split(expectedImages[0]).length - 1, 2);
  assert.equal(compose.split(expectedImages[1]).length - 1, 1);
  assert.doesNotMatch(compose, /^\s+platform:/m);
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
  assert.equal(policy.containerPlatform, "linux/amd64,linux/arm64");
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

test("local trial setup uses random ignored credentials instead of checked-in defaults", () => {
  if (source) return;
  const compose = read("docker-compose.local.yml");
  const helper = read("scripts/local-compose-up.sh");
  const readme = read("README.md");
  const guide = read("docs/local-quickstart.md");
  const dockerignore = read(".dockerignore");
  assert.match(compose, /TW_LOCAL_DATABASE_PASSWORD:\?Run the local bootstrap helper first/);
  assert.match(compose, /TW_LOCAL_AUTH_SECRET:\?Run the local bootstrap helper first/);
  assert.match(compose, /TW_LOCAL_BOOTSTRAP_SECRET:\?Run the local bootstrap helper first/);
  assert.match(helper, /randomBytes\(32\)/);
  assert.match(helper, /chmod 700/);
  assert.match(helper, /chmod 600/);
  assert.match(helper, /Refusing to use a symlink/);
  assert.match(helper, /docker compose --env-file/);
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);
  assert.match(readme, /scripts\/local-compose-up\.sh/);
  assert.match(guide, /scripts\/local-compose-up\.sh/);
  assert.doesNotMatch(`${readme}\n${guide}\n${compose}`, /task-weaver-local-(?:first-admin-bootstrap|demo-secret-change|only)/);
});

test("Kubernetes API and Web receive the same required authentication secret keys", () => {
  const apps = read(`${source}deploy/kubernetes/apps.yaml.in`);
  const deployments = apps.split(/^---$/m);
  assert.equal(deployments.length, 2);
  for (const deployment of deployments) {
    for (const [name, key] of [["TW_AUTH_SECRET", "secret"], ["TW_AUTH_BASE_URL", "base-url"], ["TW_AUTH_TRUSTED_ORIGINS", "trusted-origins"]]) {
      assert.match(deployment, new RegExp(`name: ${name}\\s+valueFrom:\\s+secretKeyRef:\\s+name: task-weaver-auth\\s+key: ${key}`));
    }
    assert.match(deployment, /name: TW_AUTH_BOOTSTRAP_SECRET\s+valueFrom:\s+secretKeyRef:\s+name: task-weaver-auth\s+key: bootstrap-secret\s+optional: true/);
  }
});

test("local credential preparation does not start or alter containers", () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-trial-prepare-"));
  try {
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "bin"));
    copyFileSync(resolve(root, "scripts/local-compose-up.sh"), join(dir, "scripts/local-compose-up.sh"));
    const docker = join(dir, "bin/docker");
    writeFileSync(docker, `#!/bin/sh\ntouch '${join(dir, "docker-called")}'\nexit 0\n`);
    chmodSync(docker, 0o755);
    const result = spawnSync("sh", [join(dir, "scripts/local-compose-up.sh"), "--prepare-only"], {
      cwd: dir, env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, "docker-called")), false);
    const credentials = readFileSync(join(dir, ".task-weaver/local-trial/compose.env"), "utf8");
    assert.match(credentials, /^TW_LOCAL_DATABASE_PASSWORD=[A-Za-z0-9_-]{43}$/m);
    assert.doesNotMatch(result.stdout, /TW_LOCAL_DATABASE_PASSWORD=/);
    assert.equal(statSync(join(dir, ".task-weaver/local-trial/compose.env")).mode & 0o777, 0o600);
    const again = spawnSync("sh", [join(dir, "scripts/local-compose-up.sh"), "--prepare-only"], {
      cwd: dir, env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` }, encoding: "utf8",
    });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(join(dir, ".task-weaver/local-trial/compose.env"), "utf8"), credentials);
    assert.equal(spawnSync("sh", [join(dir, "scripts/local-compose-up.sh"), "--unknown"], { cwd: dir }).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("application base image is digest-pinned and package managers are absent from runner", () => {
  for (const name of ["api", "web"]) {
    const dockerfile = read(`${source}apps/${name}/Dockerfile`);
    assert.match(dockerfile, /FROM node:24\.21\.0-alpine3\.23@sha256:[a-f0-9]{64} AS runtime-base/);
    assert.match(dockerfile, /FROM scratch AS runner\nCOPY --from=runtime-base \/ \//);
    assert.match(dockerfile, /ENTRYPOINT \["docker-entrypoint.sh"\]/);
    assert.match(dockerfile, /\/usr\/local\/lib\/node_modules\/npm/);
    assert.match(dockerfile, /apk add --no-cache ca-certificates-bundle musl=1\.2\.5-r24 musl-utils=1\.2\.5-r24 && apk del apk-tools/);
    assert.match(dockerfile, /USER node/);
  }
});
