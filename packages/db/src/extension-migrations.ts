import type {
  ComposedMigrationContribution,
  ComposedTaskWeaverModules,
} from "@task-weaver/module-sdk";
import postgres from "postgres";
import { compare, satisfies, valid, validRange } from "semver";
import { runMigrations } from "./client";

export const CORE_MIGRATION_SCHEMA = "task_weaver" as const;
export const EXTENSION_MIGRATION_JOURNAL = "__task_weaver_migrations" as const;
export const RESERVED_EXTENSION_MIGRATION_SCHEMA = "task_weaver_pro" as const;

const namespacePattern = /^[a-z][a-z0-9_]*$/;
const moduleIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const migrationIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export interface AppliedExtensionMigration {
  moduleId: string;
  moduleVersion: string;
  coreVersion: string;
  namespace: string;
  migrationId: string;
  version: number;
  appliedAt: string;
}

export interface ExtensionMigrationContext {
  coreVersion: string;
  moduleId: string;
  moduleVersion: string;
  namespace: string;
  schema: string;
  execute<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<readonly TRow[]>;
}

export interface ExtensionMigrationTransaction {
  ensureJournal(schema: string): Promise<void>;
  readJournal(schema: string): Promise<readonly AppliedExtensionMigration[]>;
  execute<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<readonly TRow[]>;
  recordMigration(schema: string, migration: AppliedExtensionMigration): Promise<void>;
}

export interface ExtensionMigrationAdapter {
  transaction<T>(operation: (transaction: ExtensionMigrationTransaction) => Promise<T>): Promise<T>;
}

export type ExtensionMigrationErrorCode =
  | "compatibility_error"
  | "execution_error"
  | "invalid_plan";

export class ExtensionMigrationError extends Error {
  constructor(
    public readonly code: ExtensionMigrationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExtensionMigrationError";
  }
}

export interface ApplyExtensionMigrationsOptions {
  coreVersion: string;
}

function quoteIdentifier(identifier: string): string {
  if (!namespacePattern.test(identifier)) {
    throw new ExtensionMigrationError(
      "invalid_plan",
      `Migration identifier '${identifier}' must contain only lowercase letters, digits, and underscores`,
    );
  }
  return `"${identifier}"`;
}

function validatePlan(
  plans: readonly ComposedMigrationContribution[],
  coreVersion: string,
): readonly ComposedMigrationContribution[] {
  if (!valid(coreVersion)) {
    throw new ExtensionMigrationError(
      "invalid_plan",
      `Core version '${coreVersion}' is not a valid semantic version`,
    );
  }

  const namespaces = new Set<string>();
  const schemas = new Set<string>();
  for (const plan of plans) {
    if (!moduleIdPattern.test(plan.moduleId) || !valid(plan.moduleVersion)) {
      throw new ExtensionMigrationError(
        "invalid_plan",
        `Migration owner '${plan.moduleId}' must have a valid module id and semantic version`,
      );
    }
    const supportedRange = validRange(plan.supportedCoreVersion);
    if (!supportedRange || !satisfies(coreVersion, supportedRange, { includePrerelease: true })) {
      throw new ExtensionMigrationError(
        "compatibility_error",
        `Module '${plan.moduleId}' version ${plan.moduleVersion} does not support Core ${coreVersion}`,
      );
    }
    if (!namespacePattern.test(plan.namespace)) {
      throw new ExtensionMigrationError(
        "invalid_plan",
        `Module '${plan.moduleId}' has invalid migration namespace '${plan.namespace}'`,
      );
    }
    const expectedSchema = `task_weaver_${plan.namespace}`;
    if (plan.schema !== expectedSchema || plan.schema === CORE_MIGRATION_SCHEMA) {
      throw new ExtensionMigrationError(
        "invalid_plan",
        `Module '${plan.moduleId}' must own extension schema '${expectedSchema}'`,
      );
    }
    if (namespaces.has(plan.namespace) || schemas.has(plan.schema)) {
      throw new ExtensionMigrationError(
        "invalid_plan",
        `Migration namespace '${plan.namespace}' and schema '${plan.schema}' must have one owner`,
      );
    }
    namespaces.add(plan.namespace);
    schemas.add(plan.schema);

    let previousVersion = 0;
    const migrationIds = new Set<string>();
    for (const migration of plan.migrations) {
      if (
        !migrationIdPattern.test(migration.id)
        || migrationIds.has(migration.id)
        || !Number.isSafeInteger(migration.version)
        || migration.version <= previousVersion
      ) {
        throw new ExtensionMigrationError(
          "invalid_plan",
          `Module '${plan.moduleId}' migrations require unique ids and strictly increasing positive versions`,
        );
      }
      migrationIds.add(migration.id);
      previousVersion = migration.version;
    }
  }

  return [...plans].sort((left, right) => left.namespace.localeCompare(right.namespace));
}

function verifyHistory(
  plan: ComposedMigrationContribution,
  applied: readonly AppliedExtensionMigration[],
): void {
  if (applied.length > plan.migrations.length) {
    throw new ExtensionMigrationError(
      "compatibility_error",
      `Module '${plan.moduleId}' cannot downgrade migration namespace '${plan.namespace}'; restore a compatible backup instead`,
    );
  }

  for (const [index, record] of applied.entries()) {
    const declared = plan.migrations[index];
    if (
      record.moduleId !== plan.moduleId
      || record.namespace !== plan.namespace
      || record.version !== declared?.version
      || record.migrationId !== declared.id
    ) {
      throw new ExtensionMigrationError(
        "compatibility_error",
        `Migration history for namespace '${plan.namespace}' does not match module '${plan.moduleId}'`,
      );
    }
    if (!valid(record.moduleVersion) || !valid(record.coreVersion)) {
      throw new ExtensionMigrationError(
        "compatibility_error",
        `Migration history for namespace '${plan.namespace}' contains invalid version metadata`,
      );
    }
    if (compare(record.moduleVersion, plan.moduleVersion) > 0) {
      throw new ExtensionMigrationError(
        "compatibility_error",
        `Module '${plan.moduleId}' cannot downgrade from ${record.moduleVersion} to ${plan.moduleVersion}; restore a compatible backup instead`,
      );
    }
  }
}

export async function applyExtensionMigrations(
  adapter: ExtensionMigrationAdapter,
  plans: readonly ComposedMigrationContribution[],
  options: ApplyExtensionMigrationsOptions,
): Promise<void> {
  const orderedPlans = validatePlan(plans, options.coreVersion);

  await adapter.transaction(async (transaction) => {
    for (const plan of orderedPlans) {
      await transaction.ensureJournal(plan.schema);
      const applied = [...await transaction.readJournal(plan.schema)]
        .sort((left, right) => left.version - right.version);
      verifyHistory(plan, applied);

      for (const migration of plan.migrations.slice(applied.length)) {
        const context: ExtensionMigrationContext = {
          coreVersion: options.coreVersion,
          moduleId: plan.moduleId,
          moduleVersion: plan.moduleVersion,
          namespace: plan.namespace,
          schema: plan.schema,
          execute: (statement, parameters) => transaction.execute(statement, parameters),
        };
        try {
          await migration.up(context);
          await transaction.recordMigration(plan.schema, {
            moduleId: plan.moduleId,
            moduleVersion: plan.moduleVersion,
            coreVersion: options.coreVersion,
            namespace: plan.namespace,
            migrationId: migration.id,
            version: migration.version,
            appliedAt: new Date().toISOString(),
          });
        } catch (error) {
          throw new ExtensionMigrationError(
            "execution_error",
            `Module '${plan.moduleId}' migration '${migration.id}' failed; the extension migration transaction was rolled back`,
            { cause: error },
          );
        }
      }
    }
  });
}

class PostgresExtensionMigrationTransaction implements ExtensionMigrationTransaction {
  constructor(private readonly transaction: postgres.TransactionSql) {}

  async ensureJournal(schema: string): Promise<void> {
    const quotedSchema = quoteIdentifier(schema);
    const quotedJournal = quoteIdentifier(EXTENSION_MIGRATION_JOURNAL);
    await this.transaction.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
    await this.transaction.unsafe(`
      CREATE TABLE IF NOT EXISTS ${quotedSchema}.${quotedJournal} (
        version integer PRIMARY KEY,
        migration_id text NOT NULL UNIQUE,
        module_id text NOT NULL,
        module_version text NOT NULL,
        core_version text NOT NULL,
        namespace text NOT NULL,
        applied_at timestamp with time zone NOT NULL DEFAULT now()
      )
    `);
  }

  async readJournal(schema: string): Promise<readonly AppliedExtensionMigration[]> {
    const rows = await this.transaction.unsafe<AppliedExtensionMigration[]>(`
      SELECT
        module_id AS "moduleId",
        module_version AS "moduleVersion",
        core_version AS "coreVersion",
        namespace,
        migration_id AS "migrationId",
        version,
        applied_at::text AS "appliedAt"
      FROM ${quoteIdentifier(schema)}.${quoteIdentifier(EXTENSION_MIGRATION_JOURNAL)}
      ORDER BY version
    `);
    return rows;
  }

  async execute<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly TRow[]> {
    const rows = await this.transaction.unsafe(statement, [...parameters] as never[]);
    return rows as unknown as readonly TRow[];
  }

  async recordMigration(schema: string, migration: AppliedExtensionMigration): Promise<void> {
    await this.transaction.unsafe(`
      INSERT INTO ${quoteIdentifier(schema)}.${quoteIdentifier(EXTENSION_MIGRATION_JOURNAL)}
        (version, migration_id, module_id, module_version, core_version, namespace, applied_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
    `, [
      migration.version,
      migration.migrationId,
      migration.moduleId,
      migration.moduleVersion,
      migration.coreVersion,
      migration.namespace,
      migration.appliedAt,
    ]);
  }
}

export async function runExtensionMigrations(
  connectionString: string,
  plans: readonly ComposedMigrationContribution[],
  options: ApplyExtensionMigrationsOptions,
): Promise<void> {
  const client = postgres(connectionString, {
    max: 1,
    connection: { search_path: `${CORE_MIGRATION_SCHEMA},public` },
  });
  try {
    await applyExtensionMigrations({
      transaction: async <T>(operation: (
        transaction: ExtensionMigrationTransaction,
      ) => Promise<T>): Promise<T> => {
        const result = await client.begin(async (transaction) => {
          await transaction.unsafe(
            "SELECT pg_advisory_xact_lock(hashtext('task-weaver-extension-migrations'))",
          );
          return operation(new PostgresExtensionMigrationTransaction(transaction));
        });
        return result as T;
      },
    }, plans, options);
  } finally {
    await client.end();
  }
}

export interface MigrationPhases {
  core(): Promise<void>;
  extensions(): Promise<void>;
}

export async function runMigrationPhases(phases: MigrationPhases): Promise<void> {
  await phases.core();
  await phases.extensions();
}

export async function runCoreAndExtensionMigrations(
  connectionString: string,
  composition: Pick<ComposedTaskWeaverModules, "coreVersion" | "migrations">,
): Promise<void> {
  await runMigrationPhases({
    core: () => runMigrations(connectionString),
    extensions: () => runExtensionMigrations(connectionString, composition.migrations, {
      coreVersion: composition.coreVersion,
    }),
  });
}
