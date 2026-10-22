import { readFileSync } from "node:fs";
import { PUBLIC_PACKAGES } from "./pack-ce.mjs";
const versions = PUBLIC_PACKAGES.map(name => JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8")).version);
if (new Set(versions).size !== 1) throw new Error(`Package versions differ: ${versions.join(", ")}`);
const version = versions[0];
const application = readFileSync("apps/api/src/application.ts", "utf8");
if (!application.includes('import { APPLICATION_VERSION } from "@task-weaver/contracts";') ||
    !/export const TASK_WEAVER_VERSION = APPLICATION_VERSION;/.test(application)) {
  throw new Error("Application version must use the shared contracts version");
}
const buildVersion = readFileSync("packages/contracts/src/version.ts", "utf8").match(/APPLICATION_VERSION = "([^\"]+)"/);
if (buildVersion?.[1] !== version) throw new Error("Build metadata version must match application version");
console.log(`Task Weaver package/runtime version: ${version}`);
