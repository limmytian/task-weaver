import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { PUBLIC_PACKAGES } from "./pack-ce.mjs";

const names = [...PUBLIC_PACKAGES.map(name => `@task-weaver/${name}`), "@task-weaver/cli"];
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export function compareVersions(left, right) {
  const parse = value => {
    assert.match(value, semver, "Invalid registry version");
    const separator = value.indexOf("-");
    const core = separator < 0 ? value : value.slice(0, separator);
    const pre = separator < 0 ? undefined : value.slice(separator + 1).split(".");
    assert.ok(!pre || pre.every(item => item.length > 0 && (!/^\d+$/.test(item) || item === "0" || !item.startsWith("0"))), "Invalid prerelease identifier");
    return { core: core.split(".").map(BigInt), pre };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre || !b.pre) return a.pre === b.pre ? 0 : a.pre ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function inspectCliSet(directory, version) {
  assert.match(version, semver, "Invalid release version");
  const inventory = JSON.parse(readFileSync(join(directory, "cli-artifacts.json"), "utf8"));
  assert.equal(inventory.version, version, "Inventory version mismatch");
  assert.deepEqual(inventory.artifacts.map(item => item.package), names, "Unexpected package inventory or order");
  return inventory.artifacts.map(item => {
    assert.equal(item.file, basename(item.file), "Unsafe archive filename");
    const file = join(directory, item.file);
    const bytes = readFileSync(file);
    assert.equal(statSync(file).size, item.bytes, "Archive size mismatch");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256, "Archive checksum mismatch");
    const manifest = JSON.parse(execFileSync("tar", ["-xOf", file, "package/package.json"], { encoding: "utf8", maxBuffer: 1024 * 1024 }));
    assert.equal(manifest.name, item.package, "Archive package identity mismatch");
    assert.equal(manifest.version, version, "Archive version mismatch");
    assert.notEqual(manifest.private, true, "Private package cannot be published");
    assert.equal(manifest.publishConfig?.access, "public", "Package must opt into public access");
    assert.equal(manifest.repository?.url, "git+https://github.com/limmytian/task-weaver.git", "Repository provenance mismatch");
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      assert.ok(!range.startsWith("workspace:"), "Workspace protocol in release archive");
      if (name.startsWith("@task-weaver/")) {
        assert.ok(names.includes(name), `Unexpected internal dependency: ${name}`);
        assert.equal(range, version.includes("-") ? version : `^${version}`, "Internal dependency version mismatch");
        assert.ok(names.indexOf(name) < names.indexOf(item.package), "Dependency order is not publishable");
      }
    }
    if (item.package === "@task-weaver/cli") assert.equal(manifest.bin?.tw, "./dist/index.js");
    return { ...item, file, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  });
}

export async function preflightRegistry(artifacts, version, transport = fetch) {
  const results = [];
  for (const item of artifacts) {
    const url = `https://registry.npmjs.org/${encodeURIComponent(item.package)}/${encodeURIComponent(version)}`;
    const response = await transport(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (response.status === 404) { results.push({ ...item, exists: false }); continue; }
    assert.equal(response.status, 200, `Registry preflight failed for ${item.package}: HTTP ${response.status}`);
    const body = await response.json();
    assert.equal(body.name, item.package, "Registry package identity mismatch");
    assert.equal(body.version, version, "Registry version mismatch");
    assert.equal(body.dist?.integrity, item.integrity, `Existing immutable version conflicts: ${item.package}`);
    results.push({ ...item, exists: true });
  }
  return results;
}

export async function waitForPublishedVersion(item, version, {
  transport = fetch, attempts = 60, delayMs = 10000,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [published] = await preflightRegistry([item], version, transport);
    if (published.exists) return published;
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  throw new Error(`Published version not visible after bounded registry processing wait: ${item.package}`);
}

export async function preflightTags(artifacts, version, tag, transport = fetch) {
  for (const item of artifacts) {
    const url = `https://registry.npmjs.org/${encodeURIComponent(item.package)}/${tag}`;
    const response = await transport(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (response.status === 404) {
      assert.equal(item.exists, false, `Existing version has no ${tag} tag: ${item.package}`);
      continue;
    }
    assert.equal(response.status, 200, `Registry tag preflight failed for ${item.package}: HTTP ${response.status}`);
    const body = await response.json();
    assert.equal(body.name, item.package, "Registry tag package identity mismatch");
    assert.ok(compareVersions(version, body.version) >= 0, `Refusing to move ${tag} backwards: ${item.package}`);
    if (item.exists) assert.equal(body.version, version, `Existing version needs explicit ${tag} reconciliation: ${item.package}`);
  }
}

export async function publishCliSet(directory, version, execute = false, env = process.env) {
  const artifacts = inspectCliSet(directory, version);
  if (execute) {
    assert.equal(env.GITHUB_ACTIONS, "true", "Publishing requires GitHub Actions");
    assert.equal(env.GITHUB_REPOSITORY, "limmytian/task-weaver", "Unexpected publishing repository");
    assert.equal(env.GITHUB_REF, `refs/tags/v${version}`, "Publishing requires the exact release tag");
    assert.equal(env.TW_NPM_PUBLISH_AUTHORIZED, "1", "Publishing was not explicitly authorized");
    const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
    const [major, minor, patch] = npmVersion.split(".").map(Number);
    assert.ok(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))), "Trusted publishing requires npm >=11.5.1");
  }
  const checked = await preflightRegistry(artifacts, version);
  const tag = version.includes("-") ? "next" : "latest";
  await preflightTags(checked, version, tag);
  for (const item of checked) {
    if (item.exists) { console.log(`Already published with matching integrity: ${item.package}@${version}`); continue; }
    const args = ["publish", item.file, "--access", "public", "--tag", tag, "--ignore-scripts"];
    if (execute) args.push("--provenance"); else args.push("--dry-run");
    execFileSync("npm", args, { stdio: "inherit", env });
    if (execute) {
      await waitForPublishedVersion(item, version);
    }
  }
  return { tag, packages: checked.length, dryRun: !execute };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [version, path, mode = "--dry-run"] = process.argv.slice(2);
  if (!version || !path || !["--dry-run", "--execute"].includes(mode)) throw new Error("Usage: node scripts/publish-cli-npm.mjs <version> <artifact-directory> [--dry-run|--execute]");
  console.log(JSON.stringify(await publishCliSet(resolve(path), version, mode === "--execute")));
}
