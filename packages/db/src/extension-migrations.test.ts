import assert from "node:assert/strict";
import test from "node:test";
import type { ComposedMigrationContribution } from "@task-weaver/module-sdk";
import {
  ExtensionMigrationError,
  RESERVED_EXTENSION_MIGRATION_SCHEMA,
  applyExtensionMigrations,
  runMigrationPhases,
  type AppliedExtensionMigration,
  type ExtensionMigrationAdapter,
  type ExtensionMigrationTransaction,
} from "./extension-migrations";

class MemoryMigrationAdapter implements ExtensionMigrationAdapter {
  journals = new Map<string, AppliedExtensionMigration[]>();
  statements: string[] = [];

  async transaction<T>(
    operation: (transaction: ExtensionMigrationTransaction) => Promise<T>,
  ): Promise<T> {
    const workingJournals = new Map(
      [...this.journals].map(([schema, rows]) => [schema, rows.map((row) => ({ ...row }))]),
    );
    const workingStatements = [...this.statements];
    const transaction: ExtensionMigrationTransaction = {
      ensureJournal: async (schema) => {
        if (!workingJournals.has(schema)) workingJournals.set(schema, []);
      },
      readJournal: async (schema) => workingJournals.get(schema) ?? [],
      execute: async (statement) => {
        workingStatements.push(statement);
        if (statement === "FAIL") throw new Error("simulated failure");
        return [];
      },
      recordMigration: async (schema, migration) => {
        workingJournals.get(schema)?.push({ ...migration });
      },
    };

    const result = await operation(transaction);
    this.journals = workingJournals;
    this.statements = workingStatements;
    return result;
  }
}

function plan(
  overrides: Partial<ComposedMigrationContribution> = {},
): ComposedMigrationContribution {
  return {
    moduleId: "example.audit",
    moduleVersion: "1.2.0",
    supportedCoreVersion: ">=0.1.0 <0.2.0",
    namespace: "audit",
    schema: "task_weaver_audit",
    migrations: [
      {
        id: "create_events",
        version: 1,
        up: async (context) => {
          const migrationContext = context as { execute(statement: string): Promise<unknown> };
          await migrationContext.execute("CREATE EVENTS");
        },
      },
    ],
    ...overrides,
  };
}

function expectMigrationError(
  code: ExtensionMigrationError["code"],
  action: () => Promise<unknown>,
  message: RegExp,
): Promise<void> {
  return assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ExtensionMigrationError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  });
}

test("applies extension migrations in one transaction with independent journals", async () => {
  const adapter = new MemoryMigrationAdapter();
  const plans = [
    plan(),
    plan({
      moduleId: "example.pro",
      namespace: "pro",
      schema: RESERVED_EXTENSION_MIGRATION_SCHEMA,
      migrations: [{
        id: "create_accounts",
        version: 1,
        up: async (context) => {
          const migrationContext = context as { execute(statement: string): Promise<unknown> };
          await migrationContext.execute("CREATE ACCOUNTS");
        },
      }],
    }),
  ];

  await applyExtensionMigrations(adapter, plans, { coreVersion: "0.1.0" });

  assert.deepEqual(adapter.statements, ["CREATE EVENTS", "CREATE ACCOUNTS"]);
  assert.equal(adapter.journals.get("task_weaver_audit")?.[0]?.migrationId, "create_events");
  assert.equal(adapter.journals.get(RESERVED_EXTENSION_MIGRATION_SCHEMA)?.[0]?.migrationId, "create_accounts");

  await applyExtensionMigrations(adapter, plans, { coreVersion: "0.1.0" });
  assert.deepEqual(adapter.statements, ["CREATE EVENTS", "CREATE ACCOUNTS"]);
});

test("rolls back every pending extension migration when one fails", async () => {
  const adapter = new MemoryMigrationAdapter();
  const migrationPlan = plan({
    migrations: [
      {
        id: "create_events",
        version: 1,
        up: async (context) => {
          const migrationContext = context as { execute(statement: string): Promise<unknown> };
          await migrationContext.execute("CREATE EVENTS");
        },
      },
      {
        id: "fail_index",
        version: 2,
        up: async (context) => {
          const migrationContext = context as { execute(statement: string): Promise<unknown> };
          await migrationContext.execute("FAIL");
        },
      },
    ],
  });

  await expectMigrationError(
    "execution_error",
    () => applyExtensionMigrations(adapter, [migrationPlan], { coreVersion: "0.1.0" }),
    /transaction was rolled back/,
  );
  assert.deepEqual(adapter.statements, []);
  assert.equal(adapter.journals.size, 0);
});

test("rejects incompatible Core versions and rewritten migration history", async () => {
  const adapter = new MemoryMigrationAdapter();
  await expectMigrationError(
    "compatibility_error",
    () => applyExtensionMigrations(adapter, [plan()], { coreVersion: "0.2.0" }),
    /does not support Core 0\.2\.0/,
  );

  adapter.journals.set("task_weaver_audit", [{
    moduleId: "example.audit",
    moduleVersion: "1.2.0",
    coreVersion: "0.1.0",
    namespace: "audit",
    migrationId: "old_create_events",
    version: 1,
    appliedAt: new Date().toISOString(),
  }]);
  await expectMigrationError(
    "compatibility_error",
    () => applyExtensionMigrations(adapter, [plan()], { coreVersion: "0.1.0" }),
    /history.*does not match/,
  );
});

test("rejects extension schema ownership violations and downgrades", async () => {
  const adapter = new MemoryMigrationAdapter();
  await expectMigrationError(
    "invalid_plan",
    () => applyExtensionMigrations(adapter, [plan({ schema: "task_weaver_other" })], {
      coreVersion: "0.1.0",
    }),
    /must own extension schema 'task_weaver_audit'/,
  );

  adapter.journals.set("task_weaver_audit", [
    {
      moduleId: "example.audit",
      moduleVersion: "1.2.0",
      coreVersion: "0.1.0",
      namespace: "audit",
      migrationId: "create_events",
      version: 1,
      appliedAt: new Date().toISOString(),
    },
    {
      moduleId: "example.audit",
      moduleVersion: "1.3.0",
      coreVersion: "0.1.0",
      namespace: "audit",
      migrationId: "add_index",
      version: 2,
      appliedAt: new Date().toISOString(),
    },
  ]);
  await expectMigrationError(
    "compatibility_error",
    () => applyExtensionMigrations(adapter, [plan()], { coreVersion: "0.1.0" }),
    /cannot downgrade migration namespace/,
  );

  adapter.journals.set("task_weaver_audit", [{
    moduleId: "example.audit",
    moduleVersion: "1.3.0",
    coreVersion: "0.1.0",
    namespace: "audit",
    migrationId: "create_events",
    version: 1,
    appliedAt: new Date().toISOString(),
  }]);
  await expectMigrationError(
    "compatibility_error",
    () => applyExtensionMigrations(adapter, [plan()], { coreVersion: "0.1.0" }),
    /cannot downgrade from 1\.3\.0 to 1\.2\.0/,
  );
});

test("rejects duplicate migration owners before opening a transaction", async () => {
  const adapter = new MemoryMigrationAdapter();
  await expectMigrationError(
    "invalid_plan",
    () => applyExtensionMigrations(adapter, [plan(), plan({ moduleId: "example.other" })], {
      coreVersion: "0.1.0",
    }),
    /must have one owner/,
  );
  assert.equal(adapter.journals.size, 0);
  assert.deepEqual(adapter.statements, []);
});

test("runs Core migrations before extension migrations and stops on Core failure", async () => {
  const order: string[] = [];
  await runMigrationPhases({
    core: async () => { order.push("core"); },
    extensions: async () => { order.push("extensions"); },
  });
  assert.deepEqual(order, ["core", "extensions"]);

  order.length = 0;
  await assert.rejects(() => runMigrationPhases({
    core: async () => {
      order.push("core");
      throw new Error("core failed");
    },
    extensions: async () => { order.push("extensions"); },
  }), /core failed/);
  assert.deepEqual(order, ["core"]);
});
