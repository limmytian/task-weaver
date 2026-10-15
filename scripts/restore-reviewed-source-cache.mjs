import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertChecksums, json } from "./binary-source-lib.mjs";

// The caller must verify the immutable release archive's Sigstore bundle first.
const [archive] = process.argv.slice(2);
if (!archive) throw new Error("Usage: node scripts/restore-reviewed-source-cache.mjs <verified-source-archive>");
const selected = ["native-cairo/cairo-1.18.6.tar.xz", "native-pixman/pixman-0.46.4.tar.gz"];
const lock = JSON.parse(execFileSync("tar", ["-xOzf", resolve(archive), "source-lock.json"], { maxBuffer: 8 * 1024 * 1024 }));
if (lock.schemaVersion !== 1 || !Array.isArray(lock.files)) throw new Error("Unsupported reviewed source lock");
const files = selected.map((path) => {
  const file = lock.files.find((entry) => entry.path === path);
  if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || file.url !== `https://cairographics.org/releases/${path.split("/").at(-1)}`) {
    throw new Error("Reviewed source cache identity mismatch");
  }
  return file;
});
const output = resolve("release-artifacts/binary-sources");
mkdirSync(output, { recursive: true });
for (const file of files) {
  const bytes = execFileSync("tar", ["-xOzf", resolve(archive), file.path], { maxBuffer: 64 * 1024 * 1024 });
  mkdirSync(resolve(output, file.component), { recursive: true });
  const target = resolve(output, file.path);
  writeFileSync(target, bytes);
  assertChecksums(file, target);
}
writeFileSync(resolve(output, "source-lock.json"), json({ schemaVersion: 1, files }));
console.log(`Restored and verified ${files.length} upstream source archives from the signed release cache`);
