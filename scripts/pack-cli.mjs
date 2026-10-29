import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { verifyCompiledOutputs } from "./compiled-outputs.mjs";
import { PUBLIC_PACKAGES, packCe, rewriteRelativeImports } from "./pack-ce.mjs";
import { assertPublicArtifactTree } from "./public-artifact-privacy.mjs";
import { withWorkspaceBuildLock } from "./workspace-build-lock.mjs";

function visit(directory, callback) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path, callback);
    else if (entry.isFile()) callback(path);
  }
}

export function stageCli(root, stageRoot, version) {
  const cliRoot = join(root, "apps/cli");
  const sharedVersion = JSON.parse(readFileSync(join(root, "packages/contracts/package.json"), "utf8")).version;
  if (version !== sharedVersion) throw new Error(`CLI release version must match contracts: ${sharedVersion}`);
  verifyCompiledOutputs(cliRoot);
  const stage = join(stageRoot, "cli");
  mkdirSync(join(stage, "dist"), { recursive: true });
  visit(join(cliRoot, "dist"), (source) => {
    const path = relative(join(cliRoot, "dist"), source);
    if (/\.test\.(?:js|d\.ts|map)$/.test(path) || path.endsWith(".map") || !/\.(?:js|d\.ts)$/.test(path)) return;
    const target = join(stage, "dist", path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  });
  visit(join(stage, "dist"), path => writeFileSync(path, rewriteRelativeImports(readFileSync(path, "utf8"), path)));
  const bin = join(stage, "dist/index.js");
  if (!existsSync(bin) || !readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n")) throw new Error("CLI executable is missing its Node shebang");
  chmodSync(bin, 0o755);
  const original = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));
  if (original.name !== "@task-weaver/cli") throw new Error("Unexpected CLI package identity");
  const dependencies = Object.fromEntries(Object.entries(original.dependencies ?? {}).map(([name, range]) => {
    if (!range.startsWith("workspace:")) return [name, range];
    if (!PUBLIC_PACKAGES.some(item => name === `@task-weaver/${item}`)) throw new Error(`Unpublished workspace dependency: ${name}`);
    return [name, version.includes("-") ? version : `^${version}`];
  }));
  const manifest = { name: original.name, version, description: "Task Weaver command-line interface", type: "module", license: "Apache-2.0", bin: { tw: "./dist/index.js" }, dependencies, files: ["dist", "LICENSE", "THIRD_PARTY_NOTICES.md"], engines: { node: ">=20" }, repository: { type: "git", url: "git+https://github.com/limmytian/task-weaver.git", directory: "apps/cli" }, publishConfig: { access: "public" } };
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  cpSync(join(root, "THIRD_PARTY_NOTICES.md"), join(stage, "THIRD_PARTY_NOTICES.md"));
  assertPublicArtifactTree(stage);
  return stage;
}

export function packCliSet(root, output, version) {
  verifyCompiledOutputs(join(root, "apps/cli"));
  const stageRoot = mkdtempSync(join(tmpdir(), "task-weaver-cli-pack-"));
  try {
    const stage = stageCli(root, stageRoot, version);
    const artifacts = packCe(root, output, version);
    const packed = execFileSync("npm", ["pack", stage, "--offline", "--silent", "--pack-destination", output], { encoding: "utf8" }).trim();
    const archive = join(output, basename(packed));
    artifacts.push({ package: "@task-weaver/cli", file: basename(archive), sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"), bytes: statSync(archive).size });
    writeFileSync(join(output, "cli-artifacts.json"), `${JSON.stringify({ version, artifacts }, null, 2)}\n`);
    return artifacts;
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const version = process.argv[2];
  if (!version) throw new Error("Usage: node scripts/pack-cli.mjs <version> [output-directory]");
  const root = process.cwd();
  const output = resolve(process.argv[3] ?? join(root, "release-artifacts", "cli-npm"));
  await withWorkspaceBuildLock(root, () => console.log(JSON.stringify(packCliSet(root, output, version), null, 2)));
}
