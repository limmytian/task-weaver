import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  NotFoundError,
  AuthenticationError,
  AuthorizationError,
  principalSchema,
  createTaskSchema,
  realtimeEventSchema,
  taskStatusSchema,
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

test("exports schemas, event contracts, and shared errors", () => {
  assert.equal(taskStatusSchema.parse("in_progress"), "in_progress");
  assert.equal(createTaskSchema.parse({
    projectId: "00000000-0000-4000-8000-000000000001",
    requirementId: "00000000-0000-4000-8000-000000000002",
    title: "Contract test",
  }).title, "Contract test");
  assert.equal(realtimeEventSchema.parse({
    type: "task_updated",
    projectId: null,
    taskId: "00000000-0000-4000-8000-000000000003",
  }).type, "task_updated");
  assert.equal(new NotFoundError("missing").name, "NotFoundError");
  assert.equal(new AuthenticationError().code, "authentication_required");
  assert.equal(new AuthorizationError().code, "permission_denied");
  assert.equal(principalSchema.safeParse({ id: "anonymous", type: "human" }).success, false);
});

test("declares a database-free dependency and export surface", () => {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    exports?: Record<string, string>;
  };

  assert.deepEqual(packageJson.dependencies, { zod: "^3.24.0" });
  assert.deepEqual(Object.keys(packageJson.exports ?? {}).sort(), [
    ".",
    "./errors",
    "./events",
    "./schemas",
    "./schemas/*",
    "./types",
  ]);
});

test("does not import database or server runtime modules", () => {
  const forbidden = [
    /@task-weaver\/core/,
    /@task-weaver\/db/,
    /@task-weaver\/realtime/,
    /drizzle-orm/,
    /\bpostgres\b/,
  ];

  for (const path of sourceFiles(join(packageRoot, "src"))) {
    const source = readFileSync(path, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${path} must remain database-free`);
    }
  }
});
