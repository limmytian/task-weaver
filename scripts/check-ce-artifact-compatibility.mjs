import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [previousDirectory, nextDirectory] = process.argv.slice(2);
if (!previousDirectory || !nextDirectory) {
  throw new Error("Usage: node scripts/check-ce-artifact-compatibility.mjs <previous-tarballs> <next-tarballs>");
}
const previousRoot = resolve(previousDirectory);
const nextRoot = resolve(nextDirectory);
const packages = ["contracts", "db", "realtime", "core", "partners-gateway"];

function archive(root, name, version) {
  return join(root, `task-weaver-${name}-${version}.tgz`);
}
function entry(file, path) {
  return execFileSync("tar", ["-xOf", file, `package/${path}`]);
}
function manifest(root, name, version) {
  return JSON.parse(entry(archive(root, name, version), "package.json").toString("utf8"));
}
const previousInventory = JSON.parse(readFileSync(join(previousRoot, "npm-artifacts.json"), "utf8"));
const nextInventory = JSON.parse(readFileSync(join(nextRoot, "npm-artifacts.json"), "utf8"));
const previousVersion = previousInventory.version;
const nextVersion = nextInventory.version;
const exportCounts = {};
const retiredExports = /^0\.2\./.test(previousVersion) && /^0\.3\./.test(nextVersion)
  ? { core: new Set(["./default-ports"]), "partners-gateway": new Set(["./module"]) }
  : {};
const breakingExports = [];
const retiredSdk = previousInventory.artifacts?.some(item => item.package === "@task-weaver/module-sdk")
  && !nextInventory.artifacts?.some(item => item.package === "@task-weaver/module-sdk");
if (retiredSdk && !(/^0\.2\./.test(previousVersion) && /^0\.3\./.test(nextVersion))) {
  throw new Error("Removing the module-sdk package is authorized only for the 0.3 transition");
}
for (const name of packages) {
  const oldManifest = manifest(previousRoot, name, previousVersion);
  const newManifest = manifest(nextRoot, name, nextVersion);
  for (const key of Object.keys(oldManifest.exports)) {
    if (!(key in newManifest.exports)) {
      if (!retiredExports[name]?.has(key)) throw new Error(`${name} removed public export ${key}`);
      breakingExports.push({ package: name, export: key });
    }
  }
  exportCounts[name] = { previous: Object.keys(oldManifest.exports).length, next: Object.keys(newManifest.exports).length };
}

const oldDatabaseArchive = archive(previousRoot, "db", previousVersion);
const newDatabaseArchive = archive(nextRoot, "db", nextVersion);
const oldJournal = JSON.parse(entry(oldDatabaseArchive, "drizzle/meta/_journal.json").toString("utf8"));
const newJournal = JSON.parse(entry(newDatabaseArchive, "drizzle/meta/_journal.json").toString("utf8"));
for (const [index, oldMigration] of oldJournal.entries.entries()) {
  const newMigration = newJournal.entries[index];
  if (!newMigration || JSON.stringify(oldMigration) !== JSON.stringify(newMigration)) {
    throw new Error(`Core migration journal changed at entry ${index}`);
  }
  const file = `drizzle/${oldMigration.tag}.sql`;
  if (!entry(oldDatabaseArchive, file).equals(entry(newDatabaseArchive, file))) {
    throw new Error(`Core migration file changed: ${file}`);
  }
}
const result = {
  schemaVersion: 1,
  previousVersion,
  nextVersion,
  exportCounts,
  breakingExports,
  retiredSdk: Boolean(retiredSdk),
  previousMigrations: oldJournal.entries.length,
  nextMigrations: newJournal.entries.length,
};
writeFileSync(join(nextRoot, "compatibility.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
