#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicPackages = new Map([
  ["packages/contracts", []],
  ["packages/realtime", ["contracts"]],
  ["packages/db", []],
  ["packages/core", ["contracts", "db", "realtime"]],
  ["packages/partners-gateway", ["contracts", "core", "db"]],
  ["apps/api", ["contracts", "core", "db", "partners-gateway", "realtime"]],
  ["apps/cli", ["contracts", "core", "partners-gateway"]],
  ["apps/web", ["contracts", "core", "db", "realtime"]],
]);
const hiddenNamespace = /^@task-weaver\/(?:private|internal|enterprise|pro)(?:\/|$)|^@(?:private|internal)\//;
const sourceExtensions = /\.(?:[cm]?[jt]s|tsx)$/;
const ignoredDirectories = new Set(["node_modules", "dist", ".next", ".turbo", "coverage"]);

function packageForPath(path) {
  for (const prefix of publicPackages.keys()) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

function importSpecifiers(source, fileName) {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const imports = [];
  const add = (node) => {
    if (node && ts.isStringLiteralLike(node)) imports.push(node.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

export function sourceBoundaryViolations(path, source) {
  const owner = packageForPath(path);
  if (!owner) return [];
  const allowed = new Set(publicPackages.get(owner));
  const violations = [];
  for (const specifier of importSpecifiers(source, path)) {
    if (hiddenNamespace.test(specifier)) {
      violations.push(`${path}: non-public import '${specifier}'`);
      continue;
    }
    const dependency = /^@task-weaver\/([^/]+)/.exec(specifier)?.[1];
    if (dependency && dependency !== owner.split("/")[1] && !allowed.has(dependency)) {
      violations.push(`${path}: '${owner}' cannot import '${specifier}'`);
      continue;
    }
    if (specifier.startsWith(".")) {
      const target = resolve(dirname(join(repositoryRoot, path)), specifier);
      const targetPath = relative(repositoryRoot, target).split(sep).join("/");
      const targetOwner = packageForPath(targetPath);
      if (/(?:^|\/)(?:private|internal|enterprise)(?:\/|$)/.test(targetPath)) {
        violations.push(`${path}: non-public import '${targetPath}'`);
      } else if (/^(?:packages|apps)\//.test(targetPath) && !targetOwner) {
        violations.push(`${path}: import targets an unregistered workspace '${targetPath}'`);
      } else if (targetOwner && targetOwner !== owner && !allowed.has(targetOwner.split("/")[1])) {
        violations.push(`${path}: '${owner}' cannot import '${targetPath}'`);
      }
    }
  }
  return violations;
}

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : sourceFiles(join(directory, entry.name));
    }
    return entry.isFile() && sourceExtensions.test(entry.name) ? [join(directory, entry.name)] : [];
  });
}

export function checkModuleBoundaries(root = repositoryRoot) {
  const violations = [];
  for (const parent of ["packages", "apps"]) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json"))) {
        const packagePath = `${parent}/${entry.name}`;
        if (!publicPackages.has(packagePath)) {
          violations.push(`${packagePath}: workspace has no declared dependency direction`);
        }
      }
    }
  }
  for (const [packagePath, allowedDependencies] of publicPackages) {
    const packageRoot = join(root, packagePath);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      if (hiddenNamespace.test(dependency)) {
        violations.push(`${packagePath}/package.json: non-public dependency '${dependency}'`);
      } else if (dependency.startsWith("@task-weaver/") && !allowedDependencies.includes(dependency.slice(13))) {
        violations.push(`${packagePath}/package.json: disallowed dependency '${dependency}'`);
      }
    }
    for (const file of sourceFiles(packageRoot)) {
      const path = relative(root, file).split(sep).join("/");
      violations.push(...sourceBoundaryViolations(path, readFileSync(file, "utf8")));
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = checkModuleBoundaries();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Module dependency boundaries verified.");
  }
}
