import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkModuleBoundaries, sourceBoundaryViolations } from "./check-module-boundaries.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("public workspace dependencies follow the declared direction", () => {
  assert.deepEqual(checkModuleBoundaries(), []);
});

test("static checks reject hidden namespaces, reversed imports, and dynamic imports", () => {
  assert.match(
    sourceBoundaryViolations("packages/contracts/src/example.ts", "import '@task-weaver/core'")[0],
    /cannot import/,
  );
  assert.match(
    sourceBoundaryViolations("apps/web/lib/example.ts", "export { value } from '@task-weaver/api'")[0],
    /cannot import/,
  );
  assert.match(
    sourceBoundaryViolations("packages/core/src/example.ts", "await import('@task-weaver/private/adapter')")[0],
    /non-public import/,
  );
  assert.match(
    sourceBoundaryViolations("packages/module-sdk/src/example.ts", "import '../../core/src/index'")[0],
    /cannot import/,
  );
  assert.match(
    sourceBoundaryViolations("packages/core/src/example.ts", "import '../../hidden/src/index'")[0],
    /unregistered workspace/,
  );
});

test("public package export maps point only to existing source files", () => {
  const packages = [
    "contracts", "module-sdk", "partners-gateway", "core", "db", "realtime",
  ];
  for (const name of packages) {
    const packageRoot = join(repositoryRoot, "packages", name);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    for (const [specifier, target] of Object.entries(metadata.exports ?? {})) {
      assert.equal(typeof target, "string", `${name} export '${specifier}' must have a source target`);
      if (specifier.includes("*")) continue;
      assert.ok(target.startsWith("./src/"), `${name} export '${specifier}' must target src`);
      assert.ok(existsSync(join(packageRoot, target)), `${name} export '${specifier}' is missing`);
    }
  }
  const gateway = JSON.parse(readFileSync(join(repositoryRoot, "packages/partners-gateway/package.json"), "utf8"));
  assert.deepEqual(Object.keys(gateway.exports).sort(), [".", "./module", "./worker"]);
});
