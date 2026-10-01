import { readFileSync } from "node:fs";
import { PUBLIC_PACKAGES } from "./pack-ce.mjs";
const versions = PUBLIC_PACKAGES.map(name => JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8")).version);
if (new Set(versions).size !== 1) throw new Error(`Package versions differ: ${versions.join(", ")}`);
const version = versions[0];
const match = readFileSync("apps/api/src/application.ts", "utf8").match(/TASK_WEAVER_VERSION = "([^"]+)"/);
if (!version || match?.[1] !== version) throw new Error("Application and package versions must agree");
console.log(`Task Weaver package/runtime version: ${version}`);
