import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyCompiledOutputs } from "./compiled-outputs.mjs";
import { stagePackage } from "./pack-ce.mjs";

const lockModule = new URL("./workspace-build-lock.mjs", import.meta.url).href;
function child(source, env = {}) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", chunk => { output += chunk; });
  proc.stderr.on("data", chunk => { output += chunk; });
  return { proc, result: new Promise((accept, reject) => {
    proc.on("error", reject);
    proc.on("close", (code, signal) => accept({ code, signal, output }));
  }) };
}
const rootFixture = () => mkdtempSync(join(tmpdir(), "tw-build-lock-"));

test("concurrent coordinators serialize cache restore and direct package writers with inherited nesting", { timeout: 15_000 }, async () => {
  const root = rootFixture();
  const journal = join(root, "journal");
  const source = `import {withWorkspaceBuildLock} from ${JSON.stringify(lockModule)};import {appendFileSync} from 'node:fs';
    await withWorkspaceBuildLock(${JSON.stringify(root)},async()=>{
      appendFileSync(${JSON.stringify(journal)},'start\\n');
      await withWorkspaceBuildLock(${JSON.stringify(root)},async()=>{await new Promise(r=>setTimeout(r,100))});
      appendFileSync(${JSON.stringify(journal)},'end\\n');
    });`;
  try {
    const jobs = Array.from({ length: 4 }, () => child(source));
    const results = await Promise.all(jobs.map(job => job.result));
    assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
    assert.equal(readFileSync(journal, "utf8"), "start\nend\n".repeat(4));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale locks fail closed, waiters cancel, and stale inherited context cannot bypass ownership", { timeout: 10_000 }, async () => {
  const root = rootFixture();
  const lock = join(root, ".task-weaver", "build.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2147483647, token: "dead" }));
  try {
    const base = `import {withWorkspaceBuildLock} from ${JSON.stringify(lockModule)};`;
    const stale = await child(`${base}await withWorkspaceBuildLock(${JSON.stringify(root)},()=>{throw Error('must not run')},{timeoutMs:150});`).result;
    assert.notEqual(stale.code, 0);
    assert.match(stale.output, /Verify the owner and all managed writers/);
    const cancelled = await child(`${base}await withWorkspaceBuildLock(${JSON.stringify(root)},()=>{throw Error('must not run')},{signal:AbortSignal.timeout(50)});`).result;
    assert.notEqual(cancelled.code, 0);
    assert.match(cancelled.output, /AbortError/);
    const inherited = await child(`${base}await withWorkspaceBuildLock(${JSON.stringify(root)},()=>{throw Error('must not run')});`, {
      TW_WORKSPACE_BUILD_LOCK: `${lock}:dead`,
    }).result;
    assert.notEqual(inherited.code, 0);
    assert.match(inherited.output, /ESRCH/);
    assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"))).token, "dead");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("action failure releases an owned lock for the next coordinator", async () => {
  const root = rootFixture();
  const base = `import {withWorkspaceBuildLock} from ${JSON.stringify(lockModule)};`;
  try {
    assert.notEqual((await child(`${base}await withWorkspaceBuildLock(${JSON.stringify(root)},()=>{throw Error('fixture failure')});`).result).code, 0);
    assert.equal((await child(`${base}await withWorkspaceBuildLock(${JSON.stringify(root)},()=>{});`).result).code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("packaging rejects missing wildcard outputs and declarations, not just a missing dist directory", () => {
  const root = rootFixture();
  const pkg = join(root, "packages", "contracts");
  mkdirSync(join(pkg, "src", "schemas"), { recursive: true });
  mkdirSync(join(pkg, "dist", "schemas"), { recursive: true });
  mkdirSync(join(pkg, "node_modules"));
  symlinkSync(resolve("node_modules/typescript"), join(pkg, "node_modules", "typescript"), "junction");
  const save = (path, text) => writeFileSync(join(pkg, path), text);
  save("package.json", JSON.stringify({ name: "@task-weaver/contracts", version: "1.0.0", exports: { ".": "./src/index.ts", "./schemas/*": "./src/schemas/*.ts" } }));
  save("tsconfig.json", JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "src", declaration: true }, include: ["src"] }));
  save("src/index.ts", "export const entry = 1;\n");
  save("src/schemas/item.ts", "export const item = 1;\n");
  save("dist/index.js", "export const entry = 1;\n");
  save("dist/index.d.ts", "export declare const entry = 1;\n");
  try {
    assert.throws(() => stagePackage(root, join(root, "stage"), "contracts", "1.0.0"), /Incomplete build output:.*schemas[/\\]item.js/);
    save("dist/schemas/item.js", "export const item = 1;\n");
    assert.throws(() => verifyCompiledOutputs(pkg), /Incomplete build output:.*item.d.ts/);
    save("dist/schemas/item.d.ts", "export declare const item = 1;\n");
    assert.equal(verifyCompiledOutputs(pkg), 4);
    save("dist/schemas/item.js", "");
    assert.throws(() => verifyCompiledOutputs(pkg), /Incomplete build output/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("build coordinator cancellation retains ownership until the managed writer stops", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const root = rootFixture();
  const pkg = join(root, "packages", "fixture");
  mkdirSync(join(root, "scripts"));
  for (const file of ["workspace-build.mjs", "workspace-build-lock.mjs", "compiled-outputs.mjs"]) cpSync(resolve("scripts", file), join(root, "scripts", file));
  mkdirSync(join(pkg, "node_modules", "typescript", "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), "{}");
  writeFileSync(join(pkg, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", version: "0.0.0" }));
  const heartbeat = join(root, "writer");
  writeFileSync(join(pkg, "node_modules", "typescript", "bin", "tsc"), `process.on('SIGTERM',()=>{});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now()));process.stdout.write('writer-ready\\n');setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20);`);
  const proc = spawn(process.execPath, [join(root, "scripts", "workspace-build.mjs"), "package-build"], { cwd: pkg, stdio: ["ignore", "pipe", "pipe"] });
  const finished = new Promise(accept => proc.on("close", (code, signal) => accept({ code, signal })));
  try {
    await Promise.race([
      new Promise(accept => proc.stdout.on("data", chunk => { if (chunk.toString().includes("writer-ready")) accept(); })),
      finished.then(result => { throw Error(`Writer failed before readiness: ${JSON.stringify(result)}`); }),
    ]);
    proc.kill("SIGTERM");
    assert.ok(existsSync(join(root, ".task-weaver", "build.lock")), "ownership remains during cancellation");
    const result = await finished;
    assert.equal(result.code, 130);
    assert.equal(result.signal, null);
    assert.equal(existsSync(join(root, ".task-weaver", "build.lock")), false);
    const stopped = readFileSync(heartbeat, "utf8");
    await new Promise(accept => setTimeout(accept, 150));
    assert.equal(readFileSync(heartbeat, "utf8"), stopped, "writer cannot outlive released ownership");
  } finally {
    proc.kill("SIGTERM");
    await finished;
    rmSync(root, { recursive: true, force: true });
  }
});
