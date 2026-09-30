import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  ModuleCompositionError,
  TASK_WEAVER_MODULE_API_VERSION,
  composeTaskWeaverModules,
  defineTaskWeaverModule,
  type AnyTaskWeaverModule,
} from "./index";

function createModule(
  id: string,
  overrides: Partial<AnyTaskWeaverModule> = {},
): AnyTaskWeaverModule {
  return {
    manifest: {
      apiVersion: TASK_WEAVER_MODULE_API_VERSION,
      id,
      name: id,
      version: "1.0.0",
      supportedCoreVersion: ">=0.1.0 <0.2.0",
      capabilities: [],
      permissions: [],
      ...overrides.manifest,
    },
    ...overrides,
  };
}

function expectCompositionError(
  code: ModuleCompositionError["code"],
  action: () => unknown,
  message: RegExp,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ModuleCompositionError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  });
}

test("defines and composes every supported contribution type", () => {
  const module = defineTaskWeaverModule(createModule("example.audit", {
    manifest: {
      apiVersion: TASK_WEAVER_MODULE_API_VERSION,
      id: "example.audit",
      name: "Audit",
      version: "1.2.0",
      supportedCoreVersion: "^0.1.0",
      capabilities: ["audit.read"],
      permissions: [{ id: "audit.export", description: "Export audit events" }],
      migrationNamespace: "audit",
    },
    configuration: {
      schema: z.object({ enabled: z.boolean() }),
      defaultValue: { enabled: true },
    },
    apiRoutes: [{ id: "list-events", method: "GET", path: "/api/v1/audit", route: {} }],
    trpcRouters: [{ namespace: "audit", router: {} }],
    workers: [{ id: "audit-retention", start: () => undefined }],
    eventSubscribers: [{
      id: "audit-task-events",
      eventTypes: ["task_updated"],
      handle: () => undefined,
    }],
    healthChecks: [{ id: "audit-storage", check: () => ({ status: "healthy" }) }],
    migrations: {
      namespace: "audit",
      schema: "task_weaver_audit",
      migrations: [{ id: "create_events", version: 1, up: async () => undefined }],
    },
    web: {
      navigation: [{ id: "audit-nav", label: "Audit", href: "/audit" }],
      pages: [{ id: "audit-page", route: "/audit", page: {} }],
      settings: [{ id: "audit-settings", settings: {} }],
    },
  }));

  const composed = composeTaskWeaverModules([module], { coreVersion: "0.1.0" });

  assert.deepEqual(composed.configuration, { "example.audit": { enabled: true } });
  assert.equal(composed.apiRoutes.length, 1);
  assert.equal(composed.trpcRouters.length, 1);
  assert.equal(composed.workers.length, 1);
  assert.equal(composed.eventSubscribers.length, 1);
  assert.equal(composed.healthChecks.length, 1);
  assert.equal(composed.migrations.length, 1);
  assert.deepEqual(
    {
      moduleId: composed.migrations[0]?.moduleId,
      moduleVersion: composed.migrations[0]?.moduleVersion,
      supportedCoreVersion: composed.migrations[0]?.supportedCoreVersion,
    },
    {
      moduleId: "example.audit",
      moduleVersion: "1.2.0",
      supportedCoreVersion: "^0.1.0",
    },
  );
  assert.equal(composed.web.navigation.length, 1);
  assert.equal(composed.web.pages.length, 1);
  assert.equal(composed.web.settings.length, 1);
});

test("preserves adapter-specific contribution types", () => {
  interface WorkerContext {
    serviceName: string;
  }

  const module = defineTaskWeaverModule({
    manifest: {
      apiVersion: TASK_WEAVER_MODULE_API_VERSION,
      id: "example.typed",
      name: "Typed adapters",
      version: "1.0.0",
      supportedCoreVersion: "^0.1.0",
    },
    workers: [{
      id: "typed-worker",
      start: (context: WorkerContext) => {
        assert.equal(context.serviceName, "api");
      },
    }],
    web: {
      pages: [{ id: "typed-page", route: "/typed", page: "page-component" }],
    },
  });

  const composed = composeTaskWeaverModules([module], { coreVersion: "0.1.0" });
  assert.equal(composed.workers[0]?.id, "typed-worker");
  assert.equal(composed.web.pages[0]?.page, "page-component");
});

test("parses supplied module configuration", () => {
  const module = createModule("example.config", {
    configuration: { schema: z.object({ retries: z.number().int().min(0) }) },
  });

  const composed = composeTaskWeaverModules([module], {
    coreVersion: "0.1.0",
    configuration: { "example.config": { retries: 3 } },
  });

  assert.deepEqual(composed.configuration["example.config"], { retries: 3 });
});

test("rejects invalid Core versions", () => {
  expectCompositionError(
    "core_version_invalid",
    () => composeTaskWeaverModules([], { coreVersion: "development" }),
    /not a valid semantic version/,
  );
});

test("rejects modules outside their supported Core version range", () => {
  expectCompositionError(
    "core_version_unsupported",
    () => composeTaskWeaverModules([createModule("example.future", {
      manifest: {
        apiVersion: TASK_WEAVER_MODULE_API_VERSION,
        id: "example.future",
        name: "Future",
        version: "2.0.0",
        supportedCoreVersion: ">=2.0.0",
        capabilities: [],
        permissions: [],
      },
    })], { coreVersion: "0.1.0" }),
    /example\.future.*>=2\.0\.0.*0\.1\.0/,
  );
});

test("rejects invalid module semantic versions and Core ranges", () => {
  expectCompositionError(
    "manifest_invalid",
    () => composeTaskWeaverModules([createModule("example.invalid-version", {
      manifest: {
        ...createModule("example.invalid-version").manifest,
        version: "release-one",
      },
    })], { coreVersion: "0.1.0" }),
    /version 'release-one'.*not a valid semantic version/,
  );

  expectCompositionError(
    "manifest_invalid",
    () => composeTaskWeaverModules([createModule("example.invalid-range", {
      manifest: {
        ...createModule("example.invalid-range").manifest,
        supportedCoreVersion: "not-a-range",
      },
    })], { coreVersion: "0.1.0" }),
    /invalid supported Core range/,
  );
});

test("rejects duplicate module ids", () => {
  expectCompositionError(
    "duplicate_module",
    () => composeTaskWeaverModules(
      [createModule("example.same"), createModule("example.same")],
      { coreVersion: "0.1.0" },
    ),
    /Module id 'example\.same'.*conflicts/,
  );
});

test("rejects duplicate API routes after path normalization", () => {
  expectCompositionError(
    "duplicate_api_route",
    () => composeTaskWeaverModules([
      createModule("example.one", {
        apiRoutes: [{ id: "one", method: "GET", path: "/api/v1/items/", route: {} }],
      }),
      createModule("example.two", {
        apiRoutes: [{ id: "two", method: "GET", path: "/api/v1/items", route: {} }],
      }),
    ], { coreVersion: "0.1.0" }),
    /GET \/api\/v1\/items.*example\.two.*example\.one/,
  );
});

test("allows the same API path for different methods", () => {
  const composed = composeTaskWeaverModules([
    createModule("example.reader", {
      apiRoutes: [{ id: "read", method: "GET", path: "/api/v1/items", route: {} }],
    }),
    createModule("example.writer", {
      apiRoutes: [{ id: "write", method: "POST", path: "/api/v1/items", route: {} }],
    }),
  ], { coreVersion: "0.1.0" });

  assert.equal(composed.apiRoutes.length, 2);
});

test("rejects duplicate capabilities and permissions", () => {
  const first = createModule("example.one", {
    manifest: {
      apiVersion: TASK_WEAVER_MODULE_API_VERSION,
      id: "example.one",
      name: "One",
      version: "1.0.0",
      supportedCoreVersion: "^0.1.0",
      capabilities: ["shared.read"],
      permissions: [{ id: "one.admin", description: "Administer one" }],
    },
  });

  expectCompositionError(
    "duplicate_capability",
    () => composeTaskWeaverModules([first, createModule("example.two", {
      manifest: {
        apiVersion: TASK_WEAVER_MODULE_API_VERSION,
        id: "example.two",
        name: "Two",
        version: "1.0.0",
        supportedCoreVersion: "^0.1.0",
        capabilities: ["shared.read"],
        permissions: [],
      },
    })], { coreVersion: "0.1.0" }),
    /Capability 'shared\.read'/,
  );

  expectCompositionError(
    "duplicate_permission",
    () => composeTaskWeaverModules([first, createModule("example.two", {
      manifest: {
        apiVersion: TASK_WEAVER_MODULE_API_VERSION,
        id: "example.two",
        name: "Two",
        version: "1.0.0",
        supportedCoreVersion: "^0.1.0",
        capabilities: [],
        permissions: [{ id: "one.admin", description: "Duplicate" }],
      },
    })], { coreVersion: "0.1.0" }),
    /Permission 'one\.admin'/,
  );
});

test("rejects duplicate tRPC and Web routes", () => {
  expectCompositionError(
    "duplicate_trpc_namespace",
    () => composeTaskWeaverModules([
      createModule("example.one", { trpcRouters: [{ namespace: "audit", router: {} }] }),
      createModule("example.two", { trpcRouters: [{ namespace: "audit", router: {} }] }),
    ], { coreVersion: "0.1.0" }),
    /tRPC namespace 'audit'/,
  );

  expectCompositionError(
    "duplicate_web_route",
    () => composeTaskWeaverModules([
      createModule("example.one", { web: { pages: [{ id: "one", route: "/audit/", page: {} }] } }),
      createModule("example.two", { web: { pages: [{ id: "two", route: "/audit", page: {} }] } }),
    ], { coreVersion: "0.1.0" }),
    /Web route '\/audit'/,
  );
});

test("rejects duplicate migration namespaces", () => {
  const migration = {
    namespace: "audit",
    schema: "task_weaver_audit",
    migrations: [{ id: "initial", version: 1, up: async () => undefined }],
  } as const;
  expectCompositionError(
    "duplicate_migration_namespace",
    () => composeTaskWeaverModules([
      createModule("example.one", {
        manifest: { ...createModule("example.one").manifest, migrationNamespace: "audit" },
        migrations: migration,
      }),
      createModule("example.two", {
        manifest: { ...createModule("example.two").manifest, migrationNamespace: "audit" },
        migrations: migration,
      }),
    ], { coreVersion: "0.1.0" }),
    /Migration namespace 'audit'/,
  );
});

test("rejects migration namespaces that collide with the Core schema", () => {
  expectCompositionError(
    "migration_manifest_mismatch",
    () => composeTaskWeaverModules([createModule("example.core-collision", {
      manifest: { ...createModule("example.core-collision").manifest, migrationNamespace: "core" },
      migrations: { namespace: "core", schema: "task_weaver", migrations: [] },
    })], { coreVersion: "0.1.0" }),
    /migration schema must be 'task_weaver_core'/,
  );
});

test("requires migration manifest parity and deterministic ordering", () => {
  expectCompositionError(
    "migration_manifest_mismatch",
    () => composeTaskWeaverModules([createModule("example.audit", {
      migrations: { namespace: "audit", schema: "audit", migrations: [] },
    })], { coreVersion: "0.1.0" }),
    /same migration namespace/,
  );

  expectCompositionError(
    "migration_order_invalid",
    () => composeTaskWeaverModules([createModule("example.audit", {
      manifest: { ...createModule("example.audit").manifest, migrationNamespace: "audit" },
      migrations: {
        namespace: "audit",
        schema: "task_weaver_audit",
        migrations: [
          { id: "second", version: 2, up: async () => undefined },
          { id: "first", version: 1, up: async () => undefined },
        ],
      },
    })], { coreVersion: "0.1.0" }),
    /strictly increasing/,
  );

  expectCompositionError(
    "migration_manifest_mismatch",
    () => composeTaskWeaverModules([createModule("example.audit", {
      manifest: { ...createModule("example.audit").manifest, migrationNamespace: "audit" },
      migrations: {
        namespace: "audit",
        schema: "audit",
        migrations: [],
      },
    })], { coreVersion: "0.1.0" }),
    /migration schema must be 'task_weaver_audit'/,
  );
});

test("returns actionable configuration failures", () => {
  expectCompositionError(
    "configuration_invalid",
    () => composeTaskWeaverModules([createModule("example.config", {
      configuration: { schema: z.object({ endpoint: z.string().url() }) },
    })], {
      coreVersion: "0.1.0",
      configuration: { "example.config": { endpoint: "not-a-url" } },
    }),
    /example\.config.*endpoint.*Invalid url/,
  );
});
