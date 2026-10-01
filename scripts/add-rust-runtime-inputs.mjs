#!/usr/bin/env node
import { rustTargets, sourcePlatform } from "./release-platforms.mjs";

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getText, json } from "./binary-source-lib.mjs";

const [manifest, evidence] = process.argv.slice(2);
if (!manifest || !evidence) throw new Error("Usage: node scripts/add-rust-runtime-inputs.mjs <verified-source-lock.json> <image-license-evidence-directory>");
const lock = JSON.parse(readFileSync(resolve(manifest)));
const inventory = JSON.parse(readFileSync(resolve(evidence, "inventory.json")));
const toolchains = inventory.inventory.flatMap((image) => JSON.parse(readFileSync(resolve(evidence, image.report))).nativeToolchains ?? []);
assert.ok(toolchains.length > 0, "Collect native toolchain commit evidence first");
const commits = [...new Set(toolchains.flatMap((entry) => entry.rustCommits))];
const commit = "75a75c3e0a67d3fa3d03982775f5bb0356e7b510";
assert.deepEqual(commits, [commit], "Rust runtime toolchain drift requires a new source review");
const date = "2026-09-27";
const channelUrl = `https://static.rust-lang.org/dist/${date}/channel-rust-nightly.toml`;
const channel = getText(channelUrl);
const rust = channel.split(/(?=^\[)/m).find((block) => block.startsWith("[pkg.rust]\n"));
assert.match(rust, new RegExp(`git_commit_hash = "${commit}"`));
const component = "rust-standard-library";
if (!lock.components.some((entry) => entry.id === component)) lock.components.push({ id: component, family: "compiler-runtime", commit, date });
const add = (kind, url, name, extra = {}) => {
  const path = `${component}/${name}`;
  if (!lock.files.some((file) => file.path === path)) lock.files.push({ component, kind, path, url, ...extra });
};
add("recipe", channelUrl, "channel-rust-nightly.toml");
for (const name of ["COPYRIGHT", "LICENSE-APACHE", "LICENSE-MIT", "REUSE.toml", "license-metadata.json"]) {
  add(name.startsWith("LICENSE") || name === "COPYRIGHT" ? "license" : "recipe", `https://raw.githubusercontent.com/rust-lang/rust/${commit}/${name}`, name);
}
for (const [pkg, target] of [["rust-src", '"*"'], ["rust-docs", rustTargets(sourcePlatform(lock))[0]]]) {
  const block = channel.split(/(?=^\[)/m).find((entry) => entry.startsWith(`[pkg.${pkg}.target.${target}]\n`));
  const url = block?.match(/^xz_url = "([^"]+)"/m)?.[1];
  const sha256 = block?.match(/^xz_hash = "([a-f0-9]{64})"/m)?.[1];
  assert.ok(url && sha256, "Nightly source/copyright package is not checksum-locked");
  add(pkg === "rust-src" ? "source" : "notice-container", url, `${pkg}-nightly.tar.xz`, { sha256 });
}
lock.rustRuntimeEvidence = { commit, date, libraries: toolchains, channelUrl,
  limitation: "Source/notice acquisition for the binary-observed toolchain, not proof of a full native rebuild." };
writeFileSync(resolve("release-artifacts/binary-sources/rust-runtime-source-plan.json"), json(lock));
console.log("Added exact binary-observed Rust standard-library source and copyright inputs.");
