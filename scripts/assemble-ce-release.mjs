import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { PUBLIC_PACKAGES } from "./pack-ce.mjs";

const version = process.argv[2];
const rehearsal = process.argv.includes("--rehearsal");
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: node scripts/assemble-ce-release.mjs <version> [--rehearsal]");
}
const tag = `v${version}`;
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!rehearsal) {
  const tagType = execFileSync("git", ["cat-file", "-t", `refs/tags/${tag}`], { encoding: "utf8" }).trim();
  const tagCommit = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
  if (tagType !== "tag" || tagCommit !== commit) {
    throw new Error(`Release requires annotated tag ${tag} pointing to HEAD`);
  }
  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (status.trim()) throw new Error("Release checkout must be clean.");
}

const root = process.cwd();
const output = resolve(root, "release-artifacts", "bundle");
mkdirSync(output, { recursive: true });
const sourceName = `task-weaver-${version}-source.tar.gz`;
const sourceTar = execFileSync("git", ["archive", "--format=tar", `--prefix=task-weaver-${version}/`, "HEAD"], { maxBuffer: 128 * 1024 * 1024 });
writeFileSync(join(output, sourceName), gzipSync(sourceTar, { level: 9, mtime: 0 }));

const npmInventory = JSON.parse(readFileSync(resolve(root, "release-artifacts/npm/npm-artifacts.json"), "utf8"));
if (npmInventory.version !== version || npmInventory.artifacts.length !== PUBLIC_PACKAGES.length
  || new Set(npmInventory.artifacts.map(artifact => artifact.package)).size !== PUBLIC_PACKAGES.length
  || PUBLIC_PACKAGES.some(name => !npmInventory.artifacts.some(artifact => artifact.package === `@task-weaver/${name}`))) {
  throw new Error("CE npm inventory does not match the release version or package count.");
}
for (const artifact of npmInventory.artifacts) {
  copyFileSync(resolve(root, "release-artifacts/npm", artifact.file), join(output, artifact.file));
}
for (const [source, target] of [
  ["release-artifacts/npm/npm-artifacts.json", "npm-artifacts.json"],
  ["release-artifacts/sbom.cdx.json", "sbom.cdx.json"],
  ["release-artifacts/licenses.json", "licenses.json"],
  ["release-artifacts/source-provenance.json", "source-provenance.json"],
  ["release-artifacts/RELEASE_NOTES.md", "RELEASE_NOTES.md"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["NOTICE", "NOTICE"],
  ["LICENSE", "LICENSE"],
]) {
  const path = resolve(root, source);
  if (!existsSync(path)) throw new Error(`Missing required release evidence: ${source}`);
  copyFileSync(path, join(output, target));
}

const artifacts = readdirSync(output).filter((file) => file !== "ce-release.json")
  .sort().map((file) => {
    const bytes = readFileSync(join(output, file));
    return { file: basename(file), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  });
writeFileSync(join(output, "ce-release.json"), `${JSON.stringify({ schemaVersion: 1, version, tag, commit, rehearsal, artifacts }, null, 2)}\n`);
console.log(join(output, "ce-release.json"));
