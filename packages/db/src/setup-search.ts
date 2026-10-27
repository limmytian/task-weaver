import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./client";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const db = createDb(databaseUrl, { maxConnections: 1 });
  const sql = readFileSync(resolve(__dirname, "setup-search.sql"), "utf-8");

  try {
    console.log("Setting up full-text search...");
    await db.execute(sql);
    console.log("Full-text search setup complete.");
  } finally {
    await db.$client.end({ timeout: 2 });
  }
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
