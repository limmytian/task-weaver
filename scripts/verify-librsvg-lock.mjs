#!/usr/bin/env node
import { rustTargets, sourcePlatform } from "./release-platforms.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, writeFileSync, copyFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { assertChecksums, hash, json, safePath } from "./binary-source-lib.mjs";

const [manifest] = process.argv.slice(2);
if (!manifest) throw new Error("Usage: node scripts/verify-librsvg-lock.mjs <acquired-source-lock.json>");
const lock = JSON.parse(readFileSync(resolve(manifest)));
const root = resolve("release-artifacts/binary-sources");
const scratch = mkdtempSync(resolve(root, "cargo-lock-verification-"));
const extract = (file, directory) => {
  const archive = resolve(root, safePath(file.path));
  assertChecksums(file, archive);
  const listing = spawnSync("tar", ["-tvf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (listing.status !== 0) throw new Error("Unable to inspect source archive.");
  const members = [];
  for (const line of listing.stdout.trim().split("\n")) {
    // The release has duplicate license aliases; their original regular text is
    // archived separately. Do not materialize links in the verification tree.
    if (line.startsWith("l") && /\/(?:COPYING(?:\.LIB)?|LICENSE) -> /.test(line)) continue;
    if (!/^[d-]/.test(line)) throw new Error("Source verification rejects archive links/special files.");
    const member = line.trim().split(/\s+/).at(-1).replace(/\/$/, "");
    try { safePath(member); } catch { throw new Error(`Unsupported archive path in ${file.path}: ${JSON.stringify(member)}`); }
    if (line.startsWith("-")) members.push(member);
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}.members`, Buffer.from(`${members.join("\0")}\0`));
  const result = spawnSync("tar", ["-xf", archive, "-C", directory, "--no-same-owner", "--no-same-permissions", "--null", "-T", `${directory}.members`]);
  if (result.status !== 0) throw new Error("Unable to extract validated source archive.");
};
const rsvg = lock.files.find((file) => file.component === "native-rsvg" && file.kind === "source");
extract(rsvg, resolve(scratch, "source"));
const source = resolve(scratch, "source/librsvg-2.63.2");
const vendor = resolve(scratch, "vendor");
const walk = (directory, base = directory, result = {}) => {
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (lstatSync(path).isDirectory()) walk(path, base, result);
    else if (lstatSync(path).isFile()) result[relative(base, path)] = hash(readFileSync(path));
    else throw new Error("Unsupported extracted source file.");
  }
  return result;
};
const crates = lock.files.filter((file) => file.path.startsWith("rust-crates/"));
assert.ok(crates.length > 0, "Complete Rust crate source manifest is required");
for (const file of crates) {
  extract(file, vendor);
  const directory = resolve(vendor, file.path.split("/").at(-1).replace(/\.crate$/, ""));
  writeFileSync(resolve(directory, ".cargo-checksum.json"), json({ files: walk(directory), package: file.sha256 }));
}
const original = readFileSync(resolve(source, "Cargo.lock"), "utf8");
const edits = [];
for (const [path, replacements] of [
  ["rsvg/Cargo.toml", [[/^(image = .*), "gif", "webp"(.*)$/gm, "$1$2"], [/^(cairo-rs = .*), "pdf", "ps"(.*)$/gm, "$1$2"]]],
  ["librsvg-c/Cargo.toml", [[/^(cairo-rs = .*), "pdf", "ps"(.*)$/gm, "$1$2"]]],
]) {
  const target = resolve(source, path);
  const before = readFileSync(target, "utf8");
  const after = replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), before);
  assert.notEqual(before, after, `Upstream feature-removal recipe drift: ${path}`);
  // Mechanical replay of the tagged build recipe, in disposable source only.
  writeFileSync(target, after);
  edits.push({ path, originalSha256: hash(before), modifiedSha256: hash(after) });
}
const patch = lock.files.find((file) => file.path.endsWith("9106011db93d701728ac2c9da50c9ab2c1bb5dc6.patch"));
assertChecksums(patch, resolve(root, patch.path));
assert.doesNotMatch(readFileSync(resolve(root, patch.path), "utf8"), /^diff --git .*Cargo\.(?:toml|lock)/m,
  "Post-lock native patch changes Cargo inputs; source coverage needs another review");
mkdirSync(resolve(scratch, "cargo-home"));
const cargoVersion = spawnSync("cargo", ["--version"], { encoding: "utf8" });
assert.equal(cargoVersion.status, 0, "Cargo is required for the offline lock comparison");
const result = spawnSync("cargo", ["update", "--workspace", "--offline", "--manifest-path", resolve(source, "Cargo.toml"),
  "--config", 'source.crates-io.replace-with="vendored-sources"', "--config", `source.vendored-sources.directory=${JSON.stringify(vendor)}`],
{ encoding: "utf8", env: { ...process.env, CARGO_HOME: resolve(scratch, "cargo-home") }, maxBuffer: 8 * 1024 * 1024 });
assert.equal(result.status, 0, result.stderr);
const updated = readFileSync(resolve(source, "Cargo.lock"), "utf8");
const tuples = (text) => text.split("[[package]]").slice(1).map((block) => Object.fromEntries([...block.matchAll(/^(name|version|source|checksum) = "([^"]+)"/gm)].map((match) => [match[1], match[2]])))
  .filter((pkg) => pkg.source).map((pkg) => JSON.stringify(pkg));
const originalPackages = new Set(tuples(original));
const updatedPackages = tuples(updated);
assert.ok(updatedPackages.every((pkg) => originalPackages.has(pkg)), "Post-edit dependencies are not covered by the original lock source superset");
const targets = rustTargets(sourcePlatform(lock));
const linuxTrees = [];
const linuxPackages = new Set();
for (const target of targets) {
  const tree = spawnSync("cargo", ["tree", "--locked", "--offline", "--manifest-path", resolve(source, "Cargo.toml"),
    "--package", "librsvg-c", "--all-features", "--edges", "normal,build", "--target", target,
    "--prefix", "none", "--format", "{p}", "--color", "never",
    "--config", 'source.crates-io.replace-with="vendored-sources"', "--config", `source.vendored-sources.directory=${JSON.stringify(vendor)}`],
  { encoding: "utf8", env: { ...process.env, CARGO_HOME: resolve(scratch, "cargo-home") }, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(tree.status, 0, tree.stderr);
  for (const line of tree.stdout.trim().split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+) v([A-Za-z0-9_.+-]+)(?: |$)/);
    assert.ok(match, `Unrecognized Cargo tree entry: ${line}`);
    if (crates.some((file) => file.component === `rust-${match[1]}-${match[2]}`)) linuxPackages.add(`rust-${match[1]}-${match[2]}`);
    else assert.ok(["librsvg", "librsvg-c"].includes(match[1]), `Unknown local source dependency: ${line}`);
  }
  const normalizedTree = tree.stdout.replaceAll(source, "<librsvg-source>");
  linuxTrees.push({ target, package: "librsvg-c", allFeatures: true, edges: ["normal", "build"], treeSha256: hash(normalizedTree) });
  writeFileSync(resolve(root, `${target}-source-tree.txt`), normalizedTree);
}
const runtimeSource = lock.files.find((file) => file.path === "rust-standard-library/rust-src-nightly.tar.xz");
let standardLibrarySource;
if (runtimeSource) {
  extract(runtimeSource, resolve(scratch, "runtime-source"));
  standardLibrarySource = resolve(scratch, "runtime-source/rust-src-nightly/rust-src/lib/rustlib/src/rust/library");
  assert.equal(hash(readFileSync(resolve(standardLibrarySource, "Cargo.lock"))), lock.rustRuntimeEvidence.registryDependencyLock.sha256);
  for (const target of targets) {
    const tree = spawnSync("cargo", ["tree", "--locked", "--offline", "--manifest-path", resolve(standardLibrarySource, "Cargo.toml"),
      "--package", "std", "--all-features", "--edges", "normal,build", "--target", target, "--prefix", "none", "--format", "{p}", "--color", "never",
      "--config", 'source.crates-io.replace-with="vendored-sources"', "--config", `source.vendored-sources.directory=${JSON.stringify(vendor)}`],
    { encoding: "utf8", env: { ...process.env, RUSTC_BOOTSTRAP: "1", CARGO_HOME: resolve(scratch, "cargo-home") }, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(tree.status, 0, tree.stderr);
    for (const line of tree.stdout.trim().split("\n")) {
      const match = line.match(/^([A-Za-z0-9_-]+) v([A-Za-z0-9_.+-]+)(?: |$)/);
      assert.ok(match, `Unrecognized standard-library Cargo tree entry: ${line}`);
      const component = `rust-${match[1]}-${match[2]}`;
      if (crates.some((file) => file.component === component)) linuxPackages.add(component);
      else assert.ok(line.includes(`(${standardLibrarySource}/`), `Unknown standard-library local source: ${line}`);
    }
    const normalizedTree = tree.stdout.replaceAll(standardLibrarySource, "<standard-library-source>");
    linuxTrees.push({ target, package: "std", allFeatures: true, edges: ["normal", "build"], treeSha256: hash(normalizedTree) });
    writeFileSync(resolve(root, `std-${target}-source-tree.txt`), normalizedTree);
  }
}
assert.ok(linuxPackages.size > 0);
assert.ok(![...linuxPackages].some((id) => /rust-(?:winapi-(?:i686|x86_64)|objc|block-)/.test(id)), "Non-Linux import artifacts unexpectedly enter the Linux source graph");
const deliveryVendor = mkdtempSync(resolve(root, "linux-source-vendor-"));
const deliveryFiles = [];
const omittedImportLibraries = [];
for (const file of crates) {
  const name = file.path.split("/").at(-1).replace(/\.crate$/, "");
  const from = resolve(vendor, name);
  const to = resolve(deliveryVendor, name);
  mkdirSync(to);
  const files = walk(from);
  delete files[".cargo-checksum.json"];
  for (const [path, digest] of Object.entries(files)) {
    const importLibrary = /\.a$/.test(path) && /^winapi-(?:i686|x86_64)-pc-windows-gnu-0\.4\.0$/.test(name);
    const testBinary = /(?:^|\/)tests?\//.test(path) && /\.(?:a|lib|so|dll|dylib|exe|node|o|obj|wasm)$/.test(path);
    const nonTargetBinary = !linuxPackages.has(file.component) && /\.(?:a|lib|so|dll|dylib|exe|node|o|obj|wasm)$/.test(path);
    if (importLibrary || testBinary || nonTargetBinary) {
      if (importLibrary) assert.ok(!linuxPackages.has(file.component));
      omittedImportLibraries.push({ component: file.component, path, sha256: digest,
        reason: importLibrary ? "non-Linux import library" : testBinary ? "unbuilt native test fixture" : "non-Linux build source graph binary" });
      delete files[path];
      continue;
    }
    assert.ok(!/\.(?:a|lib|so|dll|dylib|exe|node|o|obj|wasm)$/.test(path), `Unexpected native binary in Rust source delivery: ${name}/${path}`);
    safePath(path);
    mkdirSync(resolve(to, path, ".."), { recursive: true });
    copyFileSync(resolve(from, path), resolve(to, path));
  }
  writeFileSync(resolve(to, ".cargo-checksum.json"), json({ files, package: file.sha256 }));
  for (const [path, digest] of Object.entries(walk(to))) deliveryFiles.push({ path: `rust-vendor/${name}/${path}`, sha256: digest,
    sourcePath: relative(root, resolve(to, path)), mode: lstatSync(resolve(to, path)).mode & 0o111 ? 0o755 : 0o644 });
}
if (runtimeSource) {
  const runtimeRoot = resolve(standardLibrarySource, "..");
  const runtimeDelivery = mkdtempSync(resolve(root, "runtime-source-delivery-"));
  const runtimeFiles = walk(runtimeRoot);
  const omitted = [];
  for (const path of Object.keys(runtimeFiles)) {
    if (/\.(?:a|lib|so|dll|dylib|exe|node|o|obj|wasm)$/.test(path)) {
      assert.ok(path.startsWith("library/vendor/wit-bindgen-0.62.0/src/rt/") || path === "library/vendor/wit-bindgen-0.62.0/wasi-cli@0.2.0.wasm", `Unexpected native runtime-source payload: ${path}`);
      assert.ok(!linuxPackages.has("rust-wit-bindgen-0.62.0"));
      omitted.push(path);
      omittedImportLibraries.push({ component: "rust-standard-library", path, sha256: runtimeFiles[path], reason: "non-Linux WASI runtime artifact in official source acquisition container" });
      continue;
    }
    safePath(path);
    mkdirSync(resolve(runtimeDelivery, path, ".."), { recursive: true });
    copyFileSync(resolve(runtimeRoot, path), resolve(runtimeDelivery, path));
  }
  const checksumPath = resolve(runtimeDelivery, "library/vendor/wit-bindgen-0.62.0/.cargo-checksum.json");
  const checksum = JSON.parse(readFileSync(checksumPath));
  for (const path of omitted) delete checksum.files[path.replace("library/vendor/wit-bindgen-0.62.0/", "")];
  writeFileSync(checksumPath, json(checksum));
  for (const [path, digest] of Object.entries(walk(runtimeDelivery))) deliveryFiles.push({ path: `rust-standard-library/source/${path}`, sha256: digest,
    sourcePath: relative(root, resolve(runtimeDelivery, path)), mode: lstatSync(resolve(runtimeDelivery, path)).mode & 0o111 ? 0o755 : 0o644 });
  standardLibrarySource = resolve(runtimeDelivery, "library");
}
for (const { target, treeSha256, package: packageName } of linuxTrees) {
  const replay = spawnSync("cargo", ["tree", "--locked", "--offline", "--manifest-path", resolve(packageName === "std" ? standardLibrarySource : source, "Cargo.toml"),
    "--package", packageName, "--all-features", "--edges", "normal,build", "--target", target,
    "--prefix", "none", "--format", "{p}", "--color", "never", "--config", 'source.crates-io.replace-with="vendored-sources"',
    "--config", `source.vendored-sources.directory=${JSON.stringify(deliveryVendor)}`],
  { encoding: "utf8", env: { ...process.env, ...(packageName === "std" ? { RUSTC_BOOTSTRAP: "1" } : {}), CARGO_HOME: resolve(scratch, "cargo-home") }, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(replay.status, 0, replay.stderr);
  const normalizedTree = replay.stdout.replaceAll(packageName === "std" ? standardLibrarySource : source, packageName === "std" ? "<standard-library-source>" : "<librsvg-source>");
  assert.equal(hash(normalizedTree), treeSha256, "Removing non-Linux import binaries changed the conservative Linux dependency graph");
}
writeFileSync(resolve(root, "rust-source-delivery.json"), json({ schemaVersion: 1, files: deliveryFiles.sort((a, b) => a.path.localeCompare(b.path)),
  omittedImportLibraries, cargoPackageChecksums: "Original upstream archive checksums; local vendor file checksums describe the delivered source-only snapshot.",
  linuxTreeReplayPassed: true, distributionApproved: false }));
writeFileSync(resolve(root, "linux-rust-source-coverage.json"), json({ schemaVersion: 1, postEditCargoLockSha256: hash(updated),
  sourceArchiveSha256: rsvg.sha256, trees: linuxTrees, includedComponents: [...linuxPackages].sort(),
  excludedComponents: crates.map((file) => file.component).filter((id) => !linuxPackages.has(id)).sort(),
  offline: true, buildScriptsExecuted: false, sourceOnlyVendorReplayPassed: true, passed: true, distributionApproved: false,
  limitation: "Conservative normal/build source graph with all librsvg-c features, not a compiled-runtime SBOM or full native rebuild." }));
writeFileSync(resolve(root, "librsvg-post-edit-Cargo.lock"), updated);
writeFileSync(resolve(root, "rust-lock-verification.json"), json({ schemaVersion: 1, cargoVersion: cargoVersion.stdout.trim(),
  archiveSha256: rsvg.sha256, originalCargoLockSha256: hash(original), postEditCargoLockSha256: hash(updated), edits,
  postLockPatchSha256: patch.sha256, originalRegistryPackages: originalPackages.size, postEditRegistryPackages: updatedPackages.length,
  newRegistryPackages: 0, offline: true, buildScriptsExecuted: false, passed: true, distributionApproved: false }));
lock.rustVendoring = { ...lock.rustVendoring, postEditLockVerified: true, postEditCargoLockSha256: hash(updated),
  verification: "rust-lock-verification.json", linuxSourceCoverage: "linux-rust-source-coverage.json",
  coverage: "All post-edit registry dependencies occur unchanged in the archived upstream lock/source superset." };
writeFileSync(resolve(root, "verified-source-lock.json"), json(lock));
console.log(`Offline Cargo lock comparison passed; ${updatedPackages.length} post-edit dependencies are covered by ${crates.length} archived sources. This is not a full native build.`);
