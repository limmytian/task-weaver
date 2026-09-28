#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertChecksums, publicUrl, safePath } from "./binary-source-lib.mjs";

const [manifest, selectedPath] = process.argv.slice(2);
if (!manifest || !selectedPath) throw new Error("Usage: node scripts/download-source-ranges.mjs <source-lock-or-plan.json> <source-path>");
const plan = JSON.parse(readFileSync(resolve(manifest)));
const file = plan.files.find((entry) => entry.path === selectedPath);
if (!file || (!file.sha256 && !file.sha512)) throw new Error("Range acquisition requires an upstream-locked checksum.");
const url = file.sha512 && file.component.startsWith("alpine-")
  ? `https://distfiles.alpinelinux.org/distfiles/v3.23/${file.path.split("/").at(-1)}` : file.url;
publicUrl(url);
const head = spawnSync("curl", ["--fail", "--silent", "--show-error", "--location", "--head", "--proto", "=https", "--proto-redir", "=https", "--max-time", "30", url], { encoding: "utf8" });
if (head.status !== 0) throw new Error("Unable to inspect the locked source archive.");
const size = Number([...head.stdout.matchAll(/^content-length:\s*(\d+)\s*$/gmi)].at(-1)?.[1]);
if (!Number.isSafeInteger(size) || size <= 0 || size > 512 * 1024 * 1024) throw new Error("Unsupported source archive size.");
const root = resolve("release-artifacts/binary-sources");
const target = resolve(root, safePath(file.path));
const parts = resolve(root, "range-parts", safePath(file.path));
for (const path of [target, `${target}.assembled`, parts]) {
  for (let part = path; part.startsWith(root); part = dirname(part)) {
    if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error("Symlink in range-acquisition output.");
  }
}
if (existsSync(target)) {
  assertChecksums(file, target, false);
  console.log(`Locked source archive is already present and verified: ${file.path}`);
  process.exit(0);
}
mkdirSync(parts, { recursive: true });
const partSize = 2 * 1024 * 1024;
const count = Math.ceil(size / partSize);
let next = 0;
async function worker() {
  while (next < count) {
    const index = next++;
    const start = index * partSize;
    const end = Math.min(start + partSize, size) - 1;
    const path = resolve(parts, String(index).padStart(5, "0"));
    for (const candidate of [path, `${path}.partial`]) {
      if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) throw new Error("Symlink in source range cache.");
    }
    if (existsSync(path) && statSync(path).size === end - start + 1) continue;
    const status = await new Promise((accept, reject) => {
      const child = spawn("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https",
        "--connect-timeout", "15", "--max-time", "120", "--max-filesize", String(partSize), "--range", `${start}-${end}`,
        "--output", `${path}.partial`, "--write-out", "%{http_code}", url], { stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      child.stdout.on("data", (bytes) => stdout += bytes);
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? accept(stdout) : reject(new Error(`Source range ${index} failed (${code}). Retry retains completed chunks.`)));
    });
    if (status !== "206" || statSync(`${path}.partial`).size !== end - start + 1) throw new Error("Upstream did not honor the exact source range.");
    renameSync(`${path}.partial`, path);
    console.log(`Acquired range ${index + 1}/${count}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(`${target}.assembled`, "");
for (let index = 0; index < count; index++) appendFileSync(`${target}.assembled`, readFileSync(resolve(parts, String(index).padStart(5, "0"))));
const checksum = assertChecksums(file, `${target}.assembled`, false);
renameSync(`${target}.assembled`, target);
console.log(`Locked source archive assembled and verified: ${file.path}, SHA-256 ${checksum}`);
