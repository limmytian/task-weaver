import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

export const PUBLIC_PACKAGES = ["contracts", "db", "realtime", "core", "partners-gateway"];
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function visit(directory, callback) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path, callback);
    else if (entry.isFile()) callback(path);
  }
}

function compiledExport(sourcePath) {
  if (!sourcePath.startsWith("./src/") || !sourcePath.endsWith(".ts")) {
    throw new Error(`Unsupported public export: ${sourcePath}`);
  }
  return sourcePath.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js");
}

export function releasePackageJson(original, version) {
  const exports = Object.fromEntries(Object.entries(original.exports).map(([key, path]) => {
    const importPath = compiledExport(path);
    return [key, {
      types: importPath.replace(/\.js$/, ".d.ts"),
      default: importPath,
    }];
  }));
  const dependencies = Object.fromEntries(Object.entries(original.dependencies ?? {}).map(([name, range]) => {
    if (!range.startsWith("workspace:")) return [name, range];
    if (!PUBLIC_PACKAGES.some((item) => name === `@task-weaver/${item}`)) {
      throw new Error(`Unpublished workspace dependency: ${name}`);
    }
    return [name, version.includes("-") ? version : `^${version}`];
  }));
  return {
    name: original.name,
    version,
    type: "module",
    license: "Apache-2.0",
    exports,
    dependencies,
    files: ["dist", "drizzle", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    engines: { node: ">=20" },
    publishConfig: { access: "public" },
  };
}

function rewriteRelativeImports(contents, filePath) {
  return contents.replace(/(\b(?:from\s+|import\s*\(|import\s+|export\s+[^;]*?from\s+)["'])(\.{1,2}\/[^"']+)(["'])/g,
    (_match, prefix, specifier, quote) => {
      if (/\.(?:js|json|node)$/.test(specifier)) return `${prefix}${specifier}${quote}`;
      const base = resolve(dirname(filePath), specifier);
      const resolved = existsSync(`${base}.js`) ? `${specifier}.js` : `${specifier}/index.js`;
      if (!existsSync(resolve(dirname(filePath), resolved))) {
        throw new Error(`Unresolved compiled import in ${filePath}: ${specifier}`);
      }
      return `${prefix}${resolved}${quote}`;
    }).replace(/^\/\/# sourceMappingURL=.*$/gm, "");
}

export function stagePackage(root, stageRoot, packageName, version) {
  const packageRoot = join(root, "packages", packageName);
  const sourceDist = join(packageRoot, "dist");
  if (!existsSync(sourceDist)) throw new Error(`Build output is missing: ${sourceDist}`);
  const stage = join(stageRoot, packageName);
  mkdirSync(join(stage, "dist"), { recursive: true });
  visit(sourceDist, (source) => {
    const path = relative(sourceDist, source);
    if (/\.test\.(?:js|d\.ts|map)$/.test(path) || path.endsWith(".map")) return;
    if (!/\.(?:js|d\.ts)$/.test(path)) return;
    const target = join(stage, "dist", path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  });
  visit(join(stage, "dist"), (filePath) => {
    writeFileSync(filePath, rewriteRelativeImports(readFileSync(filePath, "utf8"), filePath));
  });
  const original = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (original.version !== version) {
    throw new Error(`Package ${original.name} has version ${original.version}; expected ${version}`);
  }
  const manifest = releasePackageJson(original, version);
  for (const exported of Object.values(manifest.exports)) {
    if (exported.default.includes("*")) continue;
    if (!existsSync(join(stage, exported.default))) throw new Error(`Missing compiled export: ${exported.default}`);
    if (!existsSync(join(stage, exported.types))) throw new Error(`Missing declaration: ${exported.types}`);
  }
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  cpSync(join(root, "THIRD_PARTY_NOTICES.md"), join(stage, "THIRD_PARTY_NOTICES.md"));
  if (packageName === "db") cpSync(join(packageRoot, "drizzle"), join(stage, "drizzle"), { recursive: true });
  return stage;
}

export function packCe(root, output, version, canary = false) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid semantic version: ${version}`);
  if (canary && !/^\d+\.\d+\.\d+-next\.[0-9a-f]{7,40}$/.test(version)) {
    throw new Error("Canary versions must use the next.<commit> prerelease format.");
  }
  if (!existsSync(join(root, "LICENSE")) || existsSync(join(root, "open-source.manifest.json"))) {
    throw new Error("CE packages must be assembled from the verified public export.");
  }
  mkdirSync(output, { recursive: true });
  const stageRoot = mkdtempSync(join(tmpdir(), "task-weaver-pack-"));
  try {
    const artifacts = [];
    for (const packageName of PUBLIC_PACKAGES) {
      const stage = stagePackage(root, stageRoot, packageName, version);
      const packed = execFileSync("npm", ["pack", stage, "--offline", "--silent", "--pack-destination", output], { encoding: "utf8" }).trim();
      const archive = join(output, basename(packed));
      const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
      artifacts.push({ package: `@task-weaver/${packageName}`, file: basename(archive), sha256, bytes: statSync(archive).size });
    }
    writeFileSync(join(output, "npm-artifacts.json"), `${JSON.stringify({ version, artifacts }, null, 2)}\n`);
    return artifacts;
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const version = process.argv[2];
  if (!version) throw new Error("Usage: node scripts/pack-ce.mjs <version> [output-directory] [--canary]");
  const root = process.cwd();
  const output = resolve(process.argv[3]?.startsWith("--") ? join(root, "release-artifacts", "npm") : process.argv[3] ?? join(root, "release-artifacts", "npm"));
  console.log(JSON.stringify(packCe(root, output, version, process.argv.includes("--canary")), null, 2));
}
