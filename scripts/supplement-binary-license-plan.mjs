#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertChecksums, getText, json, safePath } from "./binary-source-lib.mjs";

const [manifest] = process.argv.slice(2);
if (!manifest) throw new Error("Usage: node scripts/supplement-binary-license-plan.mjs <acquired-source-lock.json>");
const root = resolve("release-artifacts/binary-sources");
const lock = JSON.parse(readFileSync(resolve(manifest)));
const extraction = JSON.parse(readFileSync(resolve(root, "license-extraction.json")));
const unresolved = [];
const additions = [];
for (const id of extraction.componentsWithoutArchiveLicenseText.filter((name) => name.startsWith("rust-"))) {
  const file = lock.files.find((entry) => entry.component === id && entry.kind === "source");
  const archive = resolve(root, safePath(file.path));
  assertChecksums(file, archive);
  const base = file.path.split("/").at(-1).replace(/\.crate$/, "");
  const member = (name) => {
    const result = spawnSync("tar", ["-xOf", archive, "--", `${base}/${name}`], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    return result.status === 0 ? result.stdout : null;
  };
  const metadata = member("Cargo.toml");
  const vcsText = member(".cargo_vcs_info.json");
  const repository = metadata?.match(/^repository = "https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"/m)?.[1]?.replace(/\.git$/, "");
  const vcs = vcsText ? JSON.parse(vcsText) : null;
  if (!repository || !/^[a-f0-9]{40}$/.test(vcs?.git?.sha1 ?? "")) {
    unresolved.push({ component: id, reason: "Archive does not establish an exact HTTPS GitHub source commit; no current-HEAD fallback is allowed." });
    continue;
  }
  const commit = vcs.git.sha1;
  // The crate-published VCS metadata binds this lookup to its own source revision.
  const directory = JSON.parse(getText(`https://api.github.com/repos/${repository}/contents?ref=${commit}`));
  if (!Array.isArray(directory)) throw new Error("Unsupported upstream license directory.");
  const candidates = directory.filter((entry) => entry.type === "file" && /^(?:LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE|PATENTS)(?:[._-].*)?$/i.test(entry.name));
  if (!candidates.length) unresolved.push({ component: id, commit, reason: "No root license/notice file exists at the published source commit; inspect embedded/subdirectory notices." });
  for (const entry of candidates) {
    const path = `supplemental-licenses/${id}/${safePath(entry.name)}`;
    if (lock.files.some((item) => item.path === path)) continue;
    lock.files.push({ component: id, kind: "license", path, url: entry.download_url, gitBlob: entry.sha });
    additions.push({ component: id, repository, commit, path });
  }
}
lock.supplementalLicenseLookup = { additions, unresolved, strategy: "Use crate-published VCS commit metadata, never a mutable default branch." };
writeFileSync(resolve(root, "supplemental-source-plan.json"), json(lock));
console.log(`Added ${additions.length} exact-commit upstream notice files; ${unresolved.length} crates require further investigation.`);
