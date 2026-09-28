#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertChecksums, hash, json, safePath } from "./binary-source-lib.mjs";

const [manifest, mode] = process.argv.slice(2);
if (mode && mode !== "--runtime-dependencies") throw new Error("Unsupported Rust source mode");
if (!manifest) throw new Error("Usage: node scripts/vendor-binary-rust-sources.mjs <acquired-source-lock.json>");
const lock = JSON.parse(readFileSync(resolve(manifest)));
const runtime = mode === "--runtime-dependencies";
const file = lock.files.find((entry) => runtime ? entry.path === "rust-standard-library/rust-src-nightly.tar.xz" : entry.component === "native-rsvg" && entry.kind === "source");
if (!file) throw new Error("The pinned librsvg release archive is required.");
const root = resolve("release-artifacts/binary-sources");
const archive = resolve(root, safePath(file.path));
assertChecksums(file, archive);
const result = spawnSync("tar", ["-xOf", archive, "--", runtime ? "rust-src-nightly/rust-src/lib/rustlib/src/rust/library/Cargo.lock" : "librsvg-2.63.2/Cargo.lock"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
if (result.status !== 0) throw new Error("Unable to read the reviewed librsvg release Cargo.lock.");
const packages = result.stdout.split("[[package]]").slice(1).map((block) => Object.fromEntries([...block.matchAll(/^(name|version|source|checksum) = "([^"]+)"/gm)].map((match) => [match[1], match[2]])));
for (const pkg of packages.filter((entry) => entry.source)) {
  if (pkg.source !== "registry+https://github.com/rust-lang/crates.io-index" || !/^[a-f0-9]{64}$/.test(pkg.checksum ?? "") ||
      !/^[A-Za-z0-9_-]+$/.test(pkg.name) || !/^[A-Za-z0-9_.+-]+$/.test(pkg.version)) throw new Error("Unsupported or unlocked Cargo source.");
  const component = `rust-${pkg.name}-${pkg.version}`;
  if (lock.components.some((entry) => entry.id === component)) {
    const prior = lock.files.find((entry) => entry.component === component && entry.path.endsWith(".crate"));
    if (prior?.sha256 !== pkg.checksum) throw new Error("Conflicting compiler/application crate checksum");
    continue;
  }
  lock.components.push({ id: component, family: "rust-crate", version: pkg.version });
  lock.files.push({ component, kind: "source", path: `rust-crates/${pkg.name}-${pkg.version}.crate`,
    url: `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`, sha256: pkg.checksum });
}
if (!runtime) lock.rustVendoring = { sourceArchive: file.path, cargoLockSha256: hash(result.stdout),
  strategy: "Archive all registry crates in the upstream release lock, including optional/unused crates.",
  postEditLockVerified: false };
if (runtime) lock.rustRuntimeEvidence.registryDependencyLock = { path: "rust-standard-library-Cargo.lock", sha256: hash(result.stdout), packages: packages.filter((entry) => entry.source).length };
writeFileSync(resolve(root, runtime ? "rust-standard-library-Cargo.lock" : "librsvg-release-Cargo.lock"), result.stdout);
writeFileSync(resolve(root, runtime ? "rust-runtime-dependencies-source-plan.json" : "rust-source-plan.json"), json(lock));
console.log(`Added ${lock.components.filter((entry) => entry.family === "rust-crate").length} checksum-locked crate sources. Post-edit build-input comparison remains separate.`);
