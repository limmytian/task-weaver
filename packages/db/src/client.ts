import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import * as schema from "./schema/index";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createDb(
  connectionString: string,
  options: { maxConnections?: number } = {},
) {
  const max = options.maxConnections ?? 10;
  if (!Number.isInteger(max) || max <= 0)
    throw new Error("Maximum database connections must be a positive integer");
  const client = postgres(connectionString, {
    max,
    connection: { search_path: "task_weaver,public" },
  });
  return drizzle(client, { schema });
}

export async function runMigrations(connectionString: string) {
  const migrationsFolder = join(__dirname, "../drizzle");
  const client = postgres(connectionString, {
    max: 1,
    connection: { search_path: "task_weaver,public" },
  });
  try {
    await client`CREATE SCHEMA IF NOT EXISTS task_weaver`;
    const db = drizzle(client);
    await migrate(db, {
      migrationsFolder,
      migrationsTable: "__drizzle_migrations",
      migrationsSchema: "task_weaver",
    });
  } finally {
    await client.end();
  }
}

export type Database = ReturnType<typeof createDb>;
