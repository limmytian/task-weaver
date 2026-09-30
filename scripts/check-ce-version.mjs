import { readFileSync } from "node:fs";

const packageNames = ["contracts", "module-sdk", "db", "realtime", "core", "partners-gateway"];
const versions = packageNames.map((name) => JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8")).version);
if (new Set(versions).size !== 1) throw new Error(`CE package versions differ: ${versions.join(", ")}`);
const version = versions[0];
if (!version) throw new Error("CE package version is missing.");

const checks = [
  ["apps/api/src/application.ts", /TASK_WEAVER_CORE_VERSION = "([^"]+)"/],
  ["apps/web/lib/web-module-registry.ts", /TASK_WEAVER_WEB_CORE_VERSION = "([^"]+)"/],
  ["packages/partners-gateway/src/module.ts", /version: "([^"]+)",\s+supportedCoreVersion: "\^([^"]+)"/],
];
for (const [path, pattern] of checks) {
  const match = readFileSync(path, "utf8").match(pattern);
  if (!match || match.slice(1).some((actual) => actual !== version)) {
    throw new Error(`${path} must declare Core version ${version}.`);
  }
}
console.log(`CE package and runtime versions agree: ${version}`);
