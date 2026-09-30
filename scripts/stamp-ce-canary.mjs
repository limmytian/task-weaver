import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
const packageNames = ["contracts", "module-sdk", "db", "realtime", "core", "partners-gateway"];
const manifests = packageNames.map((name) => ({ path: `packages/${name}/package.json`, data: JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8")) }));
const versions = new Set(manifests.map(({ data }) => data.version));
if (versions.size !== 1) throw new Error("CE package versions must agree before canary stamping.");
const base = manifests[0].data.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!base) throw new Error("A stable CE version is required before canary stamping.");
const version = `${base[1]}.${base[2]}.${Number(base[3]) + 1}-next.${commit}`;

for (const { path, data } of manifests) {
  data.version = version;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}
for (const [path, name] of [
  ["apps/api/src/application.ts", "TASK_WEAVER_CORE_VERSION"],
  ["apps/web/lib/web-module-registry.ts", "TASK_WEAVER_WEB_CORE_VERSION"],
]) {
  const source = readFileSync(path, "utf8");
  const updated = source.replace(new RegExp(`(${name} = ")[^"]+("(?: as const)?;)`), (_match, left, right) => `${left}${version}${right}`);
  if (updated === source) throw new Error(`Failed to stamp ${path}`);
  writeFileSync(path, updated);
}
const gatewayPath = "packages/partners-gateway/src/module.ts";
const gatewaySource = readFileSync(gatewayPath, "utf8");
const gatewayUpdated = gatewaySource.replace(/version: "[^"]+",\s+supportedCoreVersion: "\^[^"]+"/, `version: "${version}",\n      supportedCoreVersion: "^${version}"`);
if (gatewayUpdated === gatewaySource) throw new Error(`Failed to stamp ${gatewayPath}`);
writeFileSync(gatewayPath, gatewayUpdated);
console.log(version);
