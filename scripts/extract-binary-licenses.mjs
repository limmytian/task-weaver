#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, lstatSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { assertChecksums, hash, json, safePath } from "./binary-source-lib.mjs";

const [manifest] = process.argv.slice(2);
if (!manifest) throw new Error("Usage: node scripts/extract-binary-licenses.mjs <reviewed-source-lock.json>");
const lock = JSON.parse(readFileSync(resolve(manifest)));
const root = resolve("release-artifacts/binary-sources");
const evidence = [];
const failures = [];
const textBundle = [];
const crateDeclarations = [];
const applicableName = /^(?:COPYING|LICENSE|LICENCE|COPYRIGHT|NOTICE|AUTHORS|PATENTS|FTL)(?:[._-].*)?$/i;
for (const file of lock.files) {
  try {
    const path = resolve(root, safePath(file.path));
    assertChecksums(file, path);
    if (file.kind === "license") {
      const bytes = readFileSync(path);
      evidence.push({ component: file.component, archive: null, member: null, path: file.path, sha256: hash(bytes) });
      textBundle.push(`Component: ${file.component}\nUpstream reference: ${file.url}\nSHA-256: ${hash(bytes)}\n\n${bytes.toString("utf8")}\n`);
      continue;
    }
    if (!/(?:\.tar\.(?:gz|xz|bz2)|\.crate)$/.test(path)) continue;
    if (file.component.startsWith("rust-") && file.path.endsWith(".crate")) {
      const prefix = file.path.split("/").at(-1).replace(/\.crate$/, "");
      const metadata = spawnSync("tar", ["-xOf", path, "--", `${prefix}/Cargo.toml`], { encoding: "utf8", maxBuffer: 1024 * 1024 });
      if (metadata.status !== 0) throw new Error("Rust archive lacks published package metadata.");
      const packageBlock = metadata.stdout.match(/^\[package\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? metadata.stdout;
      crateDeclarations.push({ component: file.component, archive: file.path, archiveSha256: file.sha256,
        publishedMetadataSha256: hash(metadata.stdout),
        license: packageBlock.match(/^license = "([^"]+)"/m)?.[1] ?? null,
        licenseFile: packageBlock.match(/^license-file = "([^"]+)"/m)?.[1] ?? null,
        publishedAuthorsField: packageBlock.match(/^authors = (\[[\s\S]*?\])/m)?.[1] ?? null,
        repository: packageBlock.match(/^repository = "([^"]+)"/m)?.[1] ?? null });
    }
    const listing = spawnSync("tar", ["-tvf", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const names = spawnSync("tar", ["-tf", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (listing.status !== 0 || names.status !== 0) throw new Error(`Invalid source archive: ${file.path}`);
    const entries = names.stdout.trimEnd().split("\n");
    const types = listing.stdout.trimEnd().split("\n").map((line) => line[0]);
    if (entries.length !== types.length) throw new Error("Unsupported archive listing.");
    const embeddedNotices = file.component === "alpine-ca-certificates"
      ? new Set(["certdata.txt", "c_rehash.c", "update-ca.c", "mk-ca-bundle.pl", "split-ca-bundle.sh"])
      : file.component === "rust-selectors-0.40.0" ? new Set(["lib.rs"]) : new Set();
    const members = entries.filter((member, index) => types[index] === "-" &&
      (file.kind !== "notice-container" || basename(member) === "COPYRIGHT-library.html") &&
      (applicableName.test(basename(member)) || embeddedNotices.has(basename(member))) && !member.endsWith("/"));
    members.forEach(safePath);
    for (const member of members) {
      if (entries.filter((entry) => entry === member).length !== 1 || entries.some((entry, index) =>
        ["l", "h"].includes(types[index]) && member.startsWith(`${entry.replace(/\/$/, "")}/`))) {
        throw new Error("Duplicate or link-ancestor license member.");
      }
    }
    if (!members.length) continue;
    const scratch = mkdtempSync(resolve(root, "license-extract-"));
    try {
      // Only selected regular files enter a new empty directory. No links, source execution,
      // archive directory entries, ownership, or permission metadata are accepted.
      const memberList = resolve(scratch, "selected-members");
      writeFileSync(memberList, members.join("\0") + "\0");
      const result = spawnSync("tar", ["-xf", path, "-C", scratch, "--no-same-owner", "--no-same-permissions", "--null", "-T", memberList]);
      if (result.status !== 0) throw new Error(`Unable to extract license text: ${file.path}`);
      for (const member of members) {
      const extracted = resolve(scratch, member);
      if (!lstatSync(extracted).isFile() || lstatSync(extracted).size > 2 * 1024 * 1024) throw new Error("Unsupported license file.");
      const bytes = readFileSync(extracted);
      const text = bytes.toString("utf8");
      if (text.includes("\0")) throw new Error(`Non-text license member: ${member}`);
      const target = `license-texts/${safePath(file.component)}/${member}`;
      mkdirSync(dirname(resolve(root, target)), { recursive: true });
      writeFileSync(resolve(root, target), bytes);
      evidence.push({ component: file.component, archive: file.path, member, path: target, sha256: hash(bytes) });
      textBundle.push(`Component: ${file.component}\nSource archive: ${file.path}\nUpstream file: ${member}\nSHA-256: ${hash(bytes)}\n\n${text}\n`);
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  } catch (error) { failures.push({ path: file.path, error: error.message }); }
}
writeFileSync(resolve(root, "license-texts.txt"), textBundle.join("\n---\n\n"));
writeFileSync(resolve(root, "rust-license-declarations.json"), json({ schemaVersion: 1, declarations: crateDeclarations,
  limitation: "Published license/author metadata is retained as provenance, not invented copyright notices or automatic legal approval." }));
const missing = lock.components.filter((component) => !evidence.some((item) => item.component === component.id)).map((component) => component.id);
writeFileSync(resolve(root, "license-extraction.json"), json({ schemaVersion: 1, evidence, failures, componentsWithoutArchiveLicenseText: missing,
  distributionApproved: false, limitation: "Preserves upstream archive notices, not an automatic determination of applicable licenses or complete source coverage." }));
console.log(`Preserved ${evidence.length} license/copyright files. ${failures.length} archive failures; ${missing.length} components need recipe-only or manual notice review.`);
if (failures.length) process.exitCode = 1;
