import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  TASK_WEAVER_MODULE_API_VERSION,
  composeTaskWeaverModules,
  taskWeaverModuleManifestSchema,
} from "./index";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts") && !path.endsWith(".test.ts")
        ? [path]
        : [];
  });
}

test("exports the module manifest and composition API", () => {
  assert.equal(TASK_WEAVER_MODULE_API_VERSION, "task-weaver.dev/v1alpha1");
  assert.equal(typeof composeTaskWeaverModules, "function");
  assert.equal(taskWeaverModuleManifestSchema.parse({
    apiVersion: TASK_WEAVER_MODULE_API_VERSION,
    id: "example.module",
    name: "Example",
    version: "1.0.0",
    supportedCoreVersion: "^0.1.0",
  }).id, "example.module");
});

test("declares a runtime-neutral dependency and export surface", () => {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    exports?: Record<string, string>;
  };

  assert.deepEqual(packageJson.dependencies, {
    "@task-weaver/contracts": "workspace:^",
    semver: "^7.7.3",
    zod: "^3.24.0",
  });
  assert.deepEqual(Object.keys(packageJson.exports ?? {}).sort(), [".", "./manifest", "./ports"]);
});

test("does not import database, server, or UI framework modules", () => {
  const forbidden = [
    /@task-weaver\/core/,
    /@task-weaver\/db/,
    /@task-weaver\/realtime/,
    /drizzle-orm/,
    /\bpostgres\b/,
    /\bhono\b/,
    /@trpc\//,
    /\bnext\//,
    /\breact\b/,
  ];

  for (const path of sourceFiles(join(packageRoot, "src"))) {
    const source = readFileSync(path, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${path} must remain runtime-neutral`);
    }
  }
});
