#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, existsSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertChecksums, json, publicUrl, safePath } from "./binary-source-lib.mjs";

const args = process.argv.slice(2);
const acquire = args.includes("--acquire");
const paths = args.filter((arg) => !arg.startsWith("--"));
if (paths.length !== 1 || args.some((arg) => arg.startsWith("--") && arg !== "--acquire")) {
  throw new Error("Usage: node scripts/assemble-binary-sources.mjs <source-plan-or-reviewed-lock.json> [--acquire]");
}
const plan = JSON.parse(readFileSync(resolve(paths[0])));
if (plan.schemaVersion !== 1 || !Array.isArray(plan.files)) throw new Error("Unsupported source manifest.");
const output = resolve("release-artifacts/binary-sources");
mkdirSync(output, { recursive: true });
const failures = [];
let next = 0;
async function worker() {
  while (next < plan.files.length) {
    const file = plan.files[next++];
    try {
      const target = resolve(output, safePath(file.path));
      for (let part = target; part.startsWith(output); part = dirname(part)) {
        if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error("Symlink in source-bundle output.");
      }
      mkdirSync(dirname(target), { recursive: true });
      if (!acquire && !file.sha256) throw new Error("Source acquisition requires --acquire; reviewed locks require SHA-256.");
      if (!existsSync(target)) {
        console.log(`Fetching ${file.path}`);
        const download = (url, resume) => new Promise((accept, reject) => {
          const child = spawn("curl", ["--fail", "--silent", "--show-error", "--http1.1", "--location", "--proto", "=https", "--proto-redir", "=https",
            "--connect-timeout", "15", "--max-time", "900", "--speed-time", "60", "--speed-limit", "1024", ...(resume ? ["--continue-at", "-"] : []),
            "--output", `${target}.partial`, publicUrl(url)], { stdio: "ignore" });
          child.on("error", reject);
          child.on("exit", (code) => code === 0 ? accept() : reject(Object.assign(new Error(`Download failed (${code})`), { code })));
        });
        let url = file.sha512 && file.component.startsWith("alpine-") && file.kind === "source"
          ? `https://distfiles.alpinelinux.org/distfiles/v3.23/${file.path.split("/").at(-1)}` : file.url;
        try { await download(url, existsSync(`${target}.partial`)); }
        catch (error) {
          if (error.code === 33 || error.code === 22) {
            // Keep the prior partial bytes; restart if a server cannot resume or its mirror is unavailable.
            if (existsSync(`${target}.partial`)) renameSync(`${target}.partial`, `${target}.partial-${Date.now()}`);
            url = file.url;
            await download(url, false);
          } else throw error;
        }
        file.downloadedFrom = url;
        file.sha256 = assertChecksums(file, `${target}.partial`, !acquire);
        renameSync(`${target}.partial`, target);
      } else file.sha256 = assertChecksums(file, target, !acquire);
    } catch (error) { failures.push({ path: file.path, error: error.message }); }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
writeFileSync(resolve(output, "source-lock.json"), json(plan));
writeFileSync(resolve(output, "acquisition.json"), json({ schemaVersion: 1, acquired: plan.files.length - failures.length,
  expected: plan.files.length, passed: failures.length === 0, failures, distributionApproved: false }));
console.log(`Source acquisition: ${plan.files.length - failures.length}/${plan.files.length}; distribution is not approved.`);
if (failures.length) { console.error(json(failures)); process.exitCode = 1; }
