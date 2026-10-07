import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

// Run after pnpm build. This is an offline database-owner tool, not an API identity bypass.
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { createDb } = require("@task-weaver/db");
const { inspectOwnershipMigration, applyOwnershipMigration, ownershipMigrationManifestSchema } = require("@task-weaver/core");
let db: ReturnType<typeof createDb> | undefined;
try {
  const { values } = parseArgs({ options: {
    help: { type: "boolean", default: false },
    manifest: { type: "string" }, before: { type: "string" }, expect: { type: "string" },
    apply: { type: "boolean", default: false },
    "ack-maintenance": { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("Usage: pnpm exec tsx scripts/auth-ownership-migration.mts --before <UTC-cutoff> | --manifest <file> [--expect <inventory-hash>] [--apply --ack-maintenance]");
    console.log("Defaults to dry run. Use the offline database-owner environment TW_AUTH_MIGRATION_DATABASE_URL after schema migration. Apply only during maintenance with a verified pre-upgrade backup. Legacy keys must be reissued through authenticated scoped credential management.");
    process.exit(0);
  }
  const url = process.env.TW_AUTH_MIGRATION_DATABASE_URL;
  if (!url) throw new Error("Missing database configuration");
  if (values.apply && (!values.manifest || !values.expect || !values["ack-maintenance"])) throw new Error("Apply requires manifest, inventory fingerprint and maintenance acknowledgement");
  db = createDb(url, { maxConnections: 1 });
  if (values.manifest) {
    const manifest = ownershipMigrationManifestSchema.parse(JSON.parse(await readFile(values.manifest, "utf8")));
    const expected = values.expect ?? (await inspectOwnershipMigration(db, manifest.legacyBefore)).fingerprint;
    console.log(JSON.stringify(await applyOwnershipMigration(db, manifest, expected, !values.apply), null, 2));
  } else {
    if (!values.before) throw new Error("Inventory requires an explicit legacy cutoff timestamp");
    console.log(JSON.stringify(await inspectOwnershipMigration(db, values.before), null, 2));
  }
} catch {
  // Database errors can contain private row contents, connection strings and constraints.
  console.error("Ownership migration failed. Check configuration, manifest, target identities and a fresh inventory; no partial transaction was committed.");
  process.exitCode = 1;
} finally {
  await db?.$client.end();
}
