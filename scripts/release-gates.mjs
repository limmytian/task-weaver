#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultOutputDirectory = resolve(repositoryRoot, "release-artifacts");
const ignoredDirectoryNames = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "release-artifacts",
]);

const secretRules = [
  { name: "private-key", expression: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i },
  { name: "github-token", expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "aws-access-key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "slack-token", expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  {
    name: "assigned-secret",
    expression: /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][A-Za-z0-9+/_=-]{24,}["']/i,
  },
];

function normalizePath(path) {
  return path.split(sep).join("/");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function deterministicUuid(seed) {
  const bytes = Buffer.from(sha256(seed).slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function generatedAt() {
  const epoch = Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? "0", 10);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer.");
  }
  return new Date(epoch * 1000).toISOString();
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadPolicy(root = repositoryRoot) {
  const path = resolve(root, ".release/release-policy.json");
  if (!existsSync(path)) throw new Error("Missing .release/release-policy.json.");
  const policy = loadJson(path);
  if (policy.schemaVersion !== 1) throw new Error(`Unsupported release policy version: ${policy.schemaVersion}`);
  return policy;
}

function walkFiles(root, current = root, files = []) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue;
    const absolutePath = resolve(current, entry.name);
    const repositoryPath = normalizePath(relative(root, absolutePath));
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) throw new Error(`Release gates do not accept symbolic links: ${repositoryPath}`);
    if (stats.isDirectory()) walkFiles(root, absolutePath, files);
    else if (stats.isFile()) files.push({ absolutePath, repositoryPath, stats });
    else throw new Error(`Release gates do not accept special files: ${repositoryPath}`);
  }
  return files;
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) throw result.error;
  return result;
}

function parseCommandJson(result, label, acceptedStatuses = [0]) {
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} did not return valid JSON (exit ${result.status ?? "unknown"}).`);
  }
  if (!acceptedStatuses.includes(result.status)) {
    const code = typeof parsed?.error?.code === "string" && /^[A-Z0-9_]+$/.test(parsed.error.code)
      ? ` (${parsed.error.code})` : "";
    throw new Error(`${label} failed with exit ${result.status ?? "unknown"}${code}.`);
  }
  return parsed;
}

function canonicalLicense(expression) {
  const withoutOuterParentheses = expression.startsWith("(") && expression.endsWith(")")
    ? expression.slice(1, -1)
    : expression;
  if (withoutOuterParentheses.toUpperCase() === "SIL OPEN FONT LICENSE") return "OFL-1.1";
  return withoutOuterParentheses;
}

function matchesGlob(value, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function matchVersionedRecord(records, component, license) {
  return records.find((record) =>
    (record.name === component.name || (record.namePattern && matchesGlob(component.name, record.namePattern))) &&
    record.versions?.includes(component.version) &&
    (!license || record.license === license));
}

export function normalizeLicenseInventory(rawInventory, policy) {
  const components = [];
  for (const [rawLicense, packages] of Object.entries(rawInventory)) {
    for (const packageEntry of packages) {
      for (const version of packageEntry.versions) {
        const component = { name: packageEntry.name, version, license: canonicalLicense(rawLicense) };
        if (component.license === "Unknown") {
          const override = matchVersionedRecord(policy.licensePolicy.metadataOverrides, component);
          if (override) {
            component.license = override.declaredLicense;
            component.licenseEvidence = override.evidence;
          }
        }
        components.push(component);
      }
    }
  }
  const unique = new Map();
  for (const component of components) unique.set(`${component.name}@${component.version}`, component);
  return [...unique.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function validateLicenseInventory(components, policy) {
  const failures = [];
  const allowed = new Set(policy.licensePolicy.allowedExpressions);
  for (const component of components) {
    if (allowed.has(component.license)) continue;
    const exception = matchVersionedRecord(policy.licensePolicy.reviewedExceptions, component, component.license);
    if (!exception) {
      failures.push(`${component.name}@${component.version} has unapproved license ${component.license}`);
      continue;
    }
    if (!exception.rationale || !exception.reviewedBy || !exception.reviewedOn || !exception.scope) {
      failures.push(`${component.name}@${component.version} has an incomplete license exception`);
    }
    if (exception.reviewAgainBy && Date.now() > Date.parse(`${exception.reviewAgainBy}T23:59:59Z`)) {
      failures.push(`${component.name}@${component.version} license exception expired on ${exception.reviewAgainBy}`);
    }
  }
  return failures;
}

function workspacePackageFiles(root) {
  return walkFiles(root)
    .filter((file) => basename(file.repositoryPath) === "package.json")
    .map((file) => file.repositoryPath);
}

function verifyPackageMetadata(root) {
  const failures = [];
  for (const packagePath of workspacePackageFiles(root)) {
    const manifest = loadJson(resolve(root, packagePath));
    if (manifest.license !== "Apache-2.0") failures.push(`${packagePath} must declare license Apache-2.0`);
  }
  return failures;
}

function verifyNotices(root, policy) {
  const noticePath = resolve(root, "THIRD_PARTY_NOTICES.md");
  if (!existsSync(noticePath)) return ["Missing THIRD_PARTY_NOTICES.md"];
  const notice = readFileSync(noticePath, "utf8");
  const failures = policy.requiredNoticeEntries
    .filter((entry) => !notice.includes(entry))
    .map((entry) => `THIRD_PARTY_NOTICES.md is missing ${entry}`);
  for (const licensePath of policy.requiredLicenseFiles ?? []) {
    if (!existsSync(resolve(root, licensePath))) failures.push(`Missing required license file: ${licensePath}`);
  }
  return failures;
}

function writeReport(outputDirectory, name, report) {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, name), stableJson(report));
}

function collectLicenses(root, outputDirectory, policy) {
  const raw = parseCommandJson(command("pnpm", ["licenses", "list", "--json"], { cwd: root }), "pnpm licenses list");
  const components = normalizeLicenseInventory(raw, policy);
  const failures = [
    ...validateLicenseInventory(components, policy),
    ...verifyPackageMetadata(root),
    ...verifyNotices(root, policy),
  ];
  writeReport(outputDirectory, "licenses.json", {
    schemaVersion: 1,
    generatedAt: generatedAt(),
    componentCount: components.length,
    components,
  });
  const licenseTexts = new Map();
  for (const entries of Object.values(raw)) {
    for (const entry of entries) {
      for (const packagePath of entry.paths ?? []) {
        const collect = (directory, depth = 0) => {
          for (const file of readdirSync(directory, { withFileTypes: true })) {
            if (file.isDirectory() && /^(?:licenses?|licensing)$/i.test(file.name) && depth < 3) {
              collect(resolve(directory, file.name), depth + 1);
            } else if (file.isFile() && (depth > 0 || /^(?:licen[cs]e|copying|copyright|notice)(?:[.-].*)?$/i.test(file.name))) {
              const text = readFileSync(resolve(directory, file.name), "utf8");
              const packageVersion = loadJson(resolve(packagePath, "package.json")).version;
              const key = `${entry.name}@${packageVersion}: ${normalizePath(relative(packagePath, resolve(directory, file.name)))}`;
              licenseTexts.set(key, text);
            }
          }
        };
        collect(packagePath);
      }
    }
  }
  writeFileSync(resolve(outputDirectory, "dependency-license-texts.txt"), [...licenseTexts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, text]) => `Component: ${name}\n\n${text.trim()}\n`).join("\n"));
  if (failures.length > 0) throw new Error(`License gate failed:\n- ${failures.join("\n- ")}`);
  return components;
}

export function packageUrl(name, version) {
  const encodedName = name.startsWith("@")
    ? `${encodeURIComponent(name.split("/")[0])}/${encodeURIComponent(name.split("/")[1])}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function generateSbom(root, outputDirectory, policy, suppliedComponents) {
  const components = suppliedComponents ?? collectLicenses(root, outputDirectory, policy);
  const lockHash = sha256(readFileSync(resolve(root, "pnpm-lock.yaml")));
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${deterministicUuid(lockHash)}`,
    version: 1,
    metadata: {
      timestamp: generatedAt(),
      component: { type: "application", "bom-ref": "pkg:npm/task-weaver@0.0.1", name: "task-weaver", version: "0.0.1", licenses: [{ license: { id: "Apache-2.0" } }] },
      tools: { components: [{ type: "application", name: "Task Weaver release gates", version: "1" }] },
    },
    components: components.map((component) => ({
      type: "library",
      "bom-ref": packageUrl(component.name, component.version),
      group: component.name.startsWith("@") ? component.name.split("/")[0].slice(1) : undefined,
      name: component.name.startsWith("@") ? component.name.split("/")[1] : component.name,
      version: component.version,
      purl: packageUrl(component.name, component.version),
      licenses: [{ expression: component.license }],
      ...(component.licenseEvidence ? { externalReferences: [{ type: "license", url: component.licenseEvidence }] } : {}),
    })),
  };
  writeReport(outputDirectory, "sbom.cdx.json", bom);
}

export function scanSecrets(root, policy) {
  const findings = [];
  for (const file of walkFiles(root)) {
    const content = readFileSync(file.absolutePath);
    if (content.subarray(0, Math.min(content.length, 8192)).includes(0)) continue;
    const lines = content.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      for (const rule of secretRules) {
        rule.expression.lastIndex = 0;
        if (!rule.expression.test(lines[index])) continue;
        const excepted = policy.secretPolicy.reviewedExceptions.some((exception) =>
          exception.path === file.repositoryPath && exception.rule === rule.name && exception.line === index + 1);
        if (!excepted) findings.push({ path: file.repositoryPath, line: index + 1, rule: rule.name });
      }
    }
  }
  return findings;
}

function runSecretGate(root, outputDirectory, policy) {
  const findings = scanSecrets(root, policy);
  writeReport(outputDirectory, "secret-scan.json", { schemaVersion: 1, generatedAt: generatedAt(), findingCount: findings.length, findings });
  if (findings.length > 0) {
    throw new Error(`Secret gate failed without printing matched values:\n- ${findings.map((item) => `${item.path}:${item.line} (${item.rule})`).join("\n- ")}`);
  }
}

function normalizeRegistry(value) {
  const url = new URL(value.trim());
  return `${url.protocol}//${url.host}`;
}

function runVulnerabilityGate(root, outputDirectory, policy) {
  const registryResult = command("pnpm", ["config", "get", "registry"], { cwd: root });
  if (registryResult.status !== 0) throw new Error("Unable to resolve the pnpm audit registry.");
  const registry = normalizeRegistry(registryResult.stdout);
  if (process.env.TASK_WEAVER_AUDIT_REGISTRY && registry !== normalizeRegistry(process.env.TASK_WEAVER_AUDIT_REGISTRY)) {
    throw new Error(`Configured registry ${registry} does not match TASK_WEAVER_AUDIT_REGISTRY.`);
  }
  const result = command("pnpm", ["audit", "--prod", "--json"], { cwd: root });
  const report = parseCommandJson(result, "pnpm audit", [0, 1]);
  if (report.error) throw new Error(`Vulnerability service failed: ${report.error.summary ?? "unknown error"}`);
  const advisories = Object.values(report.advisories ?? {});
  const failOn = new Set(policy.vulnerabilityPolicy.failOn);
  const failures = advisories.filter((advisory) => {
    if (!failOn.has(advisory.severity)) return false;
    return !policy.vulnerabilityPolicy.reviewedExceptions.some((exception) =>
      String(exception.id) === String(advisory.id) && exception.module === advisory.module_name && exception.expiresOn &&
      Date.now() <= Date.parse(`${exception.expiresOn}T23:59:59Z`));
  });
  writeReport(outputDirectory, "vulnerabilities.json", {
    schemaVersion: 1,
    generatedAt: generatedAt(),
    registry,
    counts: report.metadata?.vulnerabilities ?? {},
    advisories: advisories.map((advisory) => ({
      id: advisory.id,
      module: advisory.module_name,
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.url,
      vulnerableVersions: advisory.vulnerable_versions,
      patchedVersions: advisory.patched_versions,
    })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  });
  if (failures.length > 0) {
    throw new Error(`Vulnerability gate failed: ${failures.length} unreviewed high or critical advisories.`);
  }
}

function generateProvenance(root, outputDirectory) {
  const files = walkFiles(root).map((file) => ({
    path: file.repositoryPath,
    sha256: sha256(readFileSync(file.absolutePath)),
    size: file.stats.size,
    mode: file.stats.mode & 0o777,
  }));
  const sourceDigest = sha256(stableJson(files));
  writeReport(outputDirectory, "source-provenance.json", {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "task-weaver-source", digest: { sha256: sourceDigest } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://task-weaver.dev/release/source-manifest/v1",
        externalParameters: {},
        internalParameters: { sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? "0" },
        resolvedDependencies: [],
      },
      runDetails: { builder: { id: "https://task-weaver.dev/release-gates/v1" }, metadata: { invocationId: deterministicUuid(sourceDigest) } },
    },
    files,
  });
}

function generateArtifactInventory(outputDirectory) {
  const artifacts = readdirSync(outputDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "release-artifacts.json")
    .map((entry) => {
      const content = readFileSync(resolve(outputDirectory, entry.name));
      return { path: entry.name, sha256: sha256(content), size: content.length };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  writeReport(outputDirectory, "release-artifacts.json", { schemaVersion: 1, generatedAt: generatedAt(), artifacts });
}

function parseArguments(argv) {
  const args = [...argv];
  const action = args.shift() ?? "all";
  let outputDirectory = defaultOutputDirectory;
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--output-dir") {
      const value = args.shift();
      if (!value) throw new Error("--output-dir requires a value.");
      outputDirectory = resolve(repositoryRoot, value);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!new Set(["all", "licenses", "sbom", "provenance", "secrets", "vulnerabilities"]).has(action)) {
    throw new Error(`Unknown release gate: ${action}`);
  }
  return { action, outputDirectory };
}

function main() {
  const { action, outputDirectory } = parseArguments(process.argv.slice(2));
  if (outputDirectory === repositoryRoot || !resolve(outputDirectory).startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("Release output directory must be inside the repository and cannot be its root.");
  }
  const policy = loadPolicy();
  let components;
  if (action === "all" || action === "licenses" || action === "sbom") {
    components = collectLicenses(repositoryRoot, outputDirectory, policy);
  }
  if (action === "all" || action === "sbom") generateSbom(repositoryRoot, outputDirectory, policy, components);
  if (action === "all" || action === "secrets") runSecretGate(repositoryRoot, outputDirectory, policy);
  if (action === "all" || action === "vulnerabilities") runVulnerabilityGate(repositoryRoot, outputDirectory, policy);
  if (action === "all" || action === "provenance") generateProvenance(repositoryRoot, outputDirectory);
  generateArtifactInventory(outputDirectory);
  process.stdout.write(`Release gate '${action}' passed. Reports: ${normalizePath(relative(repositoryRoot, outputDirectory))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
