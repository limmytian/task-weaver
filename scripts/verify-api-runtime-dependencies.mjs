import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const [directory] = process.argv.slice(2);
assert.ok(directory, "Usage: node scripts/verify-api-runtime-dependencies.mjs <deployment-directory>");
const packages = readdirSync(resolve(directory, "node_modules/.pnpm"));
assert.ok(!packages.some(name => name.startsWith("drizzle-kit@")), "Database schema generation tooling must not be delivered in the API runtime");
console.log("API runtime excludes optional database schema generation tooling.");
