import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, pluginInstallations, pluginStorage, pluginInvocationReceipts } from "@task-weaver/db";
import { capabilityDigest, createResourceServices, registerSkillPackageSchema, skillPackageStorageService, pluginManifestSchema, pluginSigningPayload, type PluginManifest, invokeInstalledPlugin, preparePluginWorker } from "@task-weaver/core";
import { resourcePostgresFixture } from "./resource-postgres-fixture";

const databaseUrl = process.env.TW_MCP_E2E_DATABASE_URL;
test("plugin broker persists isolated worker state with CAS, live authority and replay protection", { skip: !databaseUrl, timeout: 120000 }, async t => {
  assert.equal(new URL(databaseUrl!).hostname, "127.0.0.1");
  assert.equal(new URL(databaseUrl!).pathname, "/tw_mcp_e2e");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!); t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: "Plugin caller" });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "member", explicitPermissions: ["mcp.invoke"] });
  const agentKey = await f.identity.issueKey(f.owner.headers, agent.id, { name: "Plugin invocation", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read", "resource.write", "mcp.invoke"] }] });
  const context = await f.auth.resolve(new Headers({ authorization: `Bearer ${agentKey.rawKey}` }));
  const directory = await mkdtemp(join(tmpdir(), "tw-plugin-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new skillPackageStorageService.LocalSkillPackageStorageAdapter(directory);
  const image = process.env.TW_SKILL_RUNTIME_TEST_IMAGE!;
  assert.match(image, /@sha256:[a-f0-9]{64}$/);
  const profile = { id: "plugin-shell", image, interpreter: "shell", timeoutMs: 5000 };
  const script = `set -eu
payload=$(cat)
test "$(id -u)" = 65534
test -z "\${TW_API_KEY:-}"
test -z "\${DATABASE_URL:-}"
test ! -S /var/run/docker.sock
if touch /work/root/changed 2>/dev/null; then exit 12; fi
if grep -q eth0 /proc/net/dev; then exit 13; fi
pair=$(printf '%s' "$payload" | sed -n 's/.*"key":"counter","version":\\([0-9]*\\),"value":\\([0-9]*\\).*/\\1 \\2/p')
version=0; count=0
if [ -n "$pair" ]; then set -- $pair; version=$1; count=$2; fi
sleep 1
printf '{"result":%s,"storageChanges":[{"key":"counter","expectedVersion":%s,"operation":"put","value":%s}]}' "$((count+1))" "$version" "$((count+1))"
`;
  const pkg = await createResourceServices(f.owner.context).skillPackageService.registerPackage(db, registerSkillPackageSchema.parse({ projectId: f.project.id, name: "Counter plugin artifact", version: "1.0", files: [{ path: "SKILL.md", contentBase64: Buffer.from("Counter plugin fixture").toString("base64") }, { path: "backend.sh", contentBase64: Buffer.from(script).toString("base64") }] }), f.owner.context.actor, storage);
  const resolved = await createResourceServices(f.owner.context).skillPackageService.getPackage(db, pkg.id);
  assert.equal(resolved.id, pkg.id);
  // Resolve through the actual authenticated capability endpoint used by clients.
  const credential = await f.identity.issueKey(f.owner.headers, f.owner.context.actor.id, { name: "Plugin resolution", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read"] }] });
  const resolveResponse = await f.app.request("http://127.0.0.1:3001/api/v1/mcp-server/tools/tw_skill_packages_resolve", { method: "POST", headers: { authorization: `Bearer ${credential.rawKey}`, "content-type": "application/json" }, body: JSON.stringify({ packageId: pkg.id, version: "1.0" }) });
  assert.equal(resolveResponse.status, 200, await resolveResponse.clone().text());
  const artifact = (await resolveResponse.json() as any).structuredContent.data;
  assert.ok(artifact.manifestHash);
  const key = generateKeyPairSync("ed25519");
  const unsigned = pluginManifestSchema.parse({ schemaVersion: 1, pluginId: "fixture/counter", version: "1.0.0", displayName: "Counter", artifact: { packageId: pkg.id, version: "1.0", manifestHash: artifact.manifestHash }, backend: { profileId: profile.id, profileHash: capabilityDigest(profile), entryPath: "backend.sh" }, permissions: ["backend.execute", "storage.read", "storage.write"], methods: [{ name: "increment", access: "write" }, { name: "read", access: "read" }] });
  const manifest = { ...unsigned, signature: { algorithm: "ed25519" as const, keyId: "fixture-key", value: sign(null, Buffer.from(pluginSigningPayload(unsigned)), key.privateKey).toString("base64") } };
  const [installation] = await db.insert(pluginInstallations).values({ projectId: f.project.id, scopeKey: `project:${f.project.id}`, createdBy: f.owner.context.actor.id, pluginId: manifest.pluginId, status: "active", manifest, manifestHash: capabilityDigest(manifest) }).returning();
  let config = { profiles: JSON.stringify([profile]), keys: { "fixture-key": { publisher: "fixture", publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString() } } };
  const signal = AbortSignal.timeout(100000);
  const request = (key = randomUUID(), method = "increment") => ({ method, input: {}, confirmed: true, expectedRevision: 1, idempotencyKey: key });
  const prepare = (value: PluginManifest, s: AbortSignal) => preparePluginWorker(db, context, value, storage, () => config, s);
  const invoke = (input = request()) => invokeInstalledPlugin(db, context, installation!.id, input, prepare, signal);
  const first = request();
  assert.equal((await invoke(first)).result, 1);
  assert.equal((await invoke(first)).replayed, true);
  assert.equal((await invoke()).result, 2, "fresh container must read durable state from the broker");
  await assert.rejects(invoke({ ...first, input: { changed: true } }), /already used/);
  await assert.rejects(invoke(request(randomUUID(), "read")), /cannot write/);
  await assert.rejects(invokeInstalledPlugin(db, f.outsider.context, installation!.id, request(), prepare, signal), /not found/i);
  const concurrent = await Promise.allSettled([invoke(), invoke()]);
  assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
  assert.match((concurrent.find(result => result.status === "rejected") as PromiseRejectedResult).reason.message, /version changed/);
  const same = request();
  const replay = await Promise.all([invoke(same), invoke(same)]);
  assert.deepEqual(replay.map(result => result.result), [4, 4]);
  assert.equal(replay.filter(result => result.replayed).length, 1);
  const pending = invoke();
  await new Promise(resolve => setTimeout(resolve, 500));
  await db.update(pluginInstallations).set({ status: "disabled", revision: 2 }).where(eq(pluginInstallations.id, installation!.id));
  await assert.rejects(pending, /inactive or changed|abort/i);
  const [state] = await db.select().from(pluginStorage).where(eq(pluginStorage.installationId, installation!.id));
  assert.equal(state?.value, 4);
  await db.update(pluginInstallations).set({ status: "active", revision: 1 }).where(eq(pluginInstallations.id, installation!.id));
  const callerPending = invoke();
  await new Promise(resolve => setTimeout(resolve, 500));
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "viewer", explicitPermissions: [] });
  await assert.rejects(callerPending, /denied|abort/i);
  await assert.rejects(invoke(first), /denied/);
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "member", explicitPermissions: ["mcp.invoke"] });
  await assert.rejects(invokeInstalledPlugin(db, context, installation!.id, first, async (value, s) => {
    const execution = await prepare(value, s);
    await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "viewer", explicitPermissions: [] });
    return execution;
  }, signal), /denied/, "cached results must recheck authority after asynchronous preparation");
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "member", explicitPermissions: ["mcp.invoke"] });
  config = { ...config, keys: {} as typeof config.keys };
  await assert.rejects(invoke(first), /untrusted/);
  const receipts = await db.select().from(pluginInvocationReceipts).where(eq(pluginInvocationReceipts.installationId, installation!.id));
  assert.equal(receipts.length, 4);
  t.diagnostic("Actual PostgreSQL migration, pinned artifact, signed publisher and fresh offline containers verified; browser/lifecycle acceptance remains pending.");
});

test("plugin REST lifecycle preflights immutable generations and retains state across recovery", { skip: !databaseUrl, timeout: 120000 }, async t => {
  const { createApiApplication } = await import("./application");
  const { pluginPermissionDiff } = await import("@task-weaver/core");
  const { pluginGenerations } = await import("@task-weaver/db");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!); t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const directory = await mkdtemp(join(tmpdir(), "tw-plugin-lifecycle-"));
  const oldStorage = process.env.SKILL_PACKAGE_STORAGE_DIR;
  process.env.SKILL_PACKAGE_STORAGE_DIR = directory;
  t.after(async () => { if (oldStorage === undefined) delete process.env.SKILL_PACKAGE_STORAGE_DIR; else process.env.SKILL_PACKAGE_STORAGE_DIR = oldStorage; await rm(directory, { recursive: true, force: true }); });
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: "Plugin lifecycle manager" });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "maintainer", explicitPermissions: ["mcp.invoke"] });
  const credential = await f.identity.issueKey(f.owner.headers, agent.id, { name: "Plugin management", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read", "resource.write", "mcp.manage", "mcp.invoke"] }] });
  const readCredential = await f.identity.issueKey(f.owner.headers, agent.id, { name: "Plugin read only", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read"] }] });
  const signer = generateKeyPairSync("ed25519");
  const profile = { id: "lifecycle-shell", image: process.env.TW_SKILL_RUNTIME_TEST_IMAGE!, interpreter: "shell", timeoutMs: 5000 };
  const env: Record<string, string> = { TW_AUTH_SECRET: f.configuration.secret, TW_AUTH_BASE_URL: f.configuration.baseURL, TW_AUTH_TRUSTED_ORIGINS: f.configuration.trustedOrigins[0]!, TW_PRESET_SKILLS_SYNC: "disabled", TW_PLUGIN_RUNTIME_PROFILES: JSON.stringify([profile]), TW_PLUGIN_PUBLISHER_KEYS: JSON.stringify({ "lifecycle-key": { publisher: "fixture", publicKey: signer.publicKey.export({ type: "spki", format: "pem" }).toString() } }) };
  const app = createApiApplication({ db, databaseUrl: databaseUrl!, env }).app;
  const call = async (path: string, body?: unknown, rawKey = credential.rawKey) => {
    const response = await app.request(`http://127.0.0.1:3001/api/v1/plugins${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };
  const storage = new skillPackageStorageService.LocalSkillPackageStorageAdapter(directory);
  const script = `set -eu
payload=$(cat)
case "$payload" in *'"method":"__tw_preflight"'*) sleep 1; printf '{"result":{"ready":true}}'; exit 0;; esac
printf '{"result":7,"storageChanges":[{"key":"counter","expectedVersion":0,"operation":"put","value":7}]}'
`;
  const makeManifest = async (version: string, text = script, overrides: Record<string, unknown> = {}) => {
    const pkg = await createResourceServices(f.owner.context).skillPackageService.registerPackage(db, registerSkillPackageSchema.parse({ projectId: f.project.id, name: `Lifecycle artifact ${version}`, version, files: [{ path: "SKILL.md", contentBase64: Buffer.from("Plugin lifecycle fixture").toString("base64") }, { path: "backend.sh", contentBase64: Buffer.from(text).toString("base64") }] }), f.owner.context.actor, storage);
    const resolved = await app.request("http://127.0.0.1:3001/api/v1/mcp-server/tools/tw_skill_packages_resolve", { method: "POST", headers: { authorization: `Bearer ${readCredential.rawKey}`, "content-type": "application/json" }, body: JSON.stringify({ packageId: pkg.id, version }) });
    const artifact = (await resolved.json() as any).structuredContent.data;
    const unsigned = pluginManifestSchema.parse({ schemaVersion: 1, pluginId: "fixture/lifecycle", version, displayName: "Lifecycle counter", artifact: { packageId: pkg.id, version, manifestHash: artifact.manifestHash }, backend: { profileId: profile.id, profileHash: capabilityDigest(profile), entryPath: "backend.sh" }, permissions: ["backend.execute", "storage.read", "storage.write"], methods: [{ name: "increment", access: "write" }], ...overrides });
    return { ...unsigned, signature: { algorithm: "ed25519" as const, keyId: "lifecycle-key", value: sign(null, Buffer.from(pluginSigningPayload(unsigned)), signer.privateKey).toString("base64") } };
  };
  const manifest = await makeManifest("1.0.0");
  const install = { scope: { kind: "project", projectId: f.project.id }, manifest, confirmedManifestHash: capabilityDigest(manifest), confirmed: true, idempotencyKey: randomUUID() };
  assert.equal((await call("", install, readCredential.rawKey)).status, 403);
  const installed = await Promise.all([call("", install), call("", install)]);
  for (const result of installed) assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(installed.filter(result => result.data.replayed).length, 1);
  const id = installed[0]!.data.installationId;
  assert.equal(installed[1]!.data.installationId, id);
  assert.equal((await call(`?scope=project&projectId=${f.project.id}`)).data.items.length, 1);
  assert.equal((await call(`/${id}`)).data.manifestHash, install.confirmedManifestHash);
  const invocation = { expectedRevision: 1, method: "increment", input: {}, confirmed: true, idempotencyKey: randomUUID() };
  assert.equal((await call(`/${id}/invoke`, invocation)).data.result, 7);
  const resign = (overrides: Record<string, unknown>) => {
    const unsigned = pluginManifestSchema.parse({ ...manifest, ...overrides, signature: undefined });
    return { ...unsigned, signature: { algorithm: "ed25519" as const, keyId: "lifecycle-key", value: sign(null, Buffer.from(pluginSigningPayload(unsigned)), signer.privateKey).toString("base64") } };
  };
  const bad = await makeManifest("1.0.1", "printf '{\"result\":null,\"storageChanges\":[{\"key\":\"bad\",\"operation\":\"put\",\"value\":1,\"expectedVersion\":0}]}'\n");
  const upgrade = (next: PluginManifest, expectedRevision = 1, previous: PluginManifest = manifest) => ({ manifest: next, expectedRevision, confirmedManifestHash: capabilityDigest(next), confirmedPermissionDiffHash: pluginPermissionDiff(previous, next).hash, confirmed: true, idempotencyKey: randomUUID() });
  assert.equal((await call(`/${id}/upgrade`, upgrade(bad))).status, 400);
  assert.equal((await call(`/${id}/upgrade`, upgrade(resign({ version: "2.0.0", storageSchemaVersion: 2 })))).status, 400);
  const unsigned = pluginManifestSchema.parse({ ...manifest, version: "2.0.0", signature: undefined });
  env.TW_PLUGIN_ALLOW_UNVERIFIED = "true";
  assert.equal((await call(`/${id}/upgrade`, upgrade(unsigned))).status, 400);
  delete env.TW_PLUGIN_ALLOW_UNVERIFIED;
  const frontend = resign({ version: "2.0.0", permissions: [...manifest.permissions, "ui.render"], frontend: { entryPath: "ui/index.html" } });
  assert.equal((await call(`/${id}/upgrade`, upgrade(frontend))).status, 400);
  assert.equal((await call(`/${id}/core`, {})).status, 403);
  assert.equal((await call(`/${id}`)).data.revision, 1);
  assert.equal((await db.select().from(pluginGenerations).where(eq(pluginGenerations.installationId, id))).length, 1);
  const next = await makeManifest("1.1.0", script, { permissions: ["backend.execute", "storage.write"] });
  assert.equal((await call(`/${id}/upgrade`, { ...upgrade(next), confirmedPermissionDiffHash: "f".repeat(64) })).status, 409);
  const upgraded = await Promise.all([call(`/${id}/upgrade`, upgrade(next)), call(`/${id}/upgrade`, upgrade(next))]);
  assert.deepEqual(upgraded.map(result => result.status).sort(), [200, 409]);
  assert.equal((await call(`/${id}`)).data.revision, 2);
  assert.equal((await call(`/${id}/generations`)).data.items.length, 2);
  assert.equal((await call(`/${id}/generations/${manifest.version}`)).data.manifestHash, capabilityDigest(manifest));
  assert.equal((await db.select().from(pluginStorage).where(eq(pluginStorage.installationId, id)))[0]?.value, 7);
  const replaced = { ...next, displayName: "Changed same version" };
  assert.equal((await call(`/${id}/upgrade`, upgrade(replaced, 2, next))).status, 409);
  const statusRequest = (action: string, expectedRevision: number) => ({ action, expectedRevision, confirmed: true, idempotencyKey: randomUUID() });
  const disabled = statusRequest("disable", 2);
  // Emergency disable must work even after the trusted publisher key disappears.
  const publisherKeys = env.TW_PLUGIN_PUBLISHER_KEYS!;
  env.TW_PLUGIN_PUBLISHER_KEYS = "{}";
  assert.equal((await call(`/${id}/status`, disabled)).status, 200);
  assert.equal((await call(`/${id}/status`, disabled)).data.replayed, true);
  env.TW_PLUGIN_PUBLISHER_KEYS = publisherKeys;
  assert.equal((await call(`/${id}/invoke`, { ...invocation, expectedRevision: 3, idempotencyKey: randomUUID() })).status, 409);
  const recovered = await call(`/${id}/recover`, { version: manifest.version, expectedRevision: 3, confirmedManifestHash: capabilityDigest(manifest), confirmedPermissionDiffHash: pluginPermissionDiff(next, manifest).hash, confirmed: true, idempotencyKey: randomUUID() });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  assert.equal(recovered.data.currentRevision, 4);
  assert.equal((await db.select().from(pluginStorage).where(eq(pluginStorage.installationId, id)))[0]?.value, 7);
  assert.equal((await call(`/${id}/status`, statusRequest("uninstall", 4))).status, 200);
  assert.equal((await db.select().from(pluginStorage).where(eq(pluginStorage.installationId, id))).length, 1);
  assert.equal((await call(`/${id}/status`, statusRequest("purge", 5))).status, 200);
  assert.equal((await db.select().from(pluginStorage).where(eq(pluginStorage.installationId, id))).length, 0);
  const [receipt] = await db.select().from(pluginInvocationReceipts).where(eq(pluginInvocationReceipts.installationId, id));
  assert.equal(receipt?.result, null); assert.ok(receipt?.payloadHash);
  assert.equal((await call("", install)).status, 409);
  const fresh = await call("", { ...install, idempotencyKey: randomUUID() });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.data));
  assert.notEqual(fresh.data.installationId, id);
  assert.equal((await call(`/${id}/invoke`, invocation)).status, 409);
  assert.equal((await db.select().from(pluginStorage).where(eq(pluginStorage.installationId, fresh.data.installationId))).length, 0);
  const { serve } = await import("@hono/node-server");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { writeFile } = await import("node:fs/promises");
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as import("node:http").Server;
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => { server.closeIdleConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)), "plugin", ...args, "--json"], { timeout: 15000, env: { ...process.env, PATH: "/no-local-tools", TW_CONFIG_DIR: directory, TW_API_URL: `http://127.0.0.1:${address.port}`, TW_API_KEY: credential.rawKey } })).stdout);
  assert.equal((await cli("list", "--project", f.project.id)).items.length, 2);
  assert.equal((await cli("get", fresh.data.installationId)).revision, 1);
  assert.equal((await cli("generations", fresh.data.installationId)).items.length, 1);
  assert.equal((await cli("generation", fresh.data.installationId, manifest.version)).manifestHash, capabilityDigest(manifest));
  const invocationFile = join(directory, "invoke.json");
  await writeFile(invocationFile, JSON.stringify({ ...invocation, idempotencyKey: randomUUID() }));
  assert.equal((await cli("invoke", fresh.data.installationId, "--file", invocationFile)).result, 7);
  assert.equal((await cli("invoke", fresh.data.installationId, "--file", invocationFile)).replayed, true);
  const oversized = await app.request("http://127.0.0.1:3001/api/v1/plugins", { method: "POST", headers: { authorization: `Bearer ${credential.rawKey}`, "content-type": "application/json" }, body: "x".repeat(131073) });
  assert.equal(oversized.status, 413);
  t.diagnostic("Actual REST install, concurrent immutable upgrade, failed preflight, permission review, disable, recovery, retained uninstall and anti-resurrection purge verified.");
});

test("dedicated plugin artifact host binds tickets to live scoped installations without Core credentials", { skip: !databaseUrl, timeout: 120000 }, async t => {
  const { createApiApplication } = await import("./application");
  const { createServer } = await import("node:net");
  const portProbe = createServer(); portProbe.listen(0, "127.0.0.1"); await once(portProbe, "listening");
  const address = portProbe.address(); assert.ok(address && typeof address !== "string");
  const artifactPort = address.port; await new Promise<void>(resolve => portProbe.close(() => resolve()));
  await runMigrations(databaseUrl!); const db = createDb(databaseUrl!); t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const directory = await mkdtemp(join(tmpdir(), "tw-plugin-page-"));
  const previousStorage = process.env.SKILL_PACKAGE_STORAGE_DIR; process.env.SKILL_PACKAGE_STORAGE_DIR = directory;
  t.after(async () => { if (previousStorage === undefined) delete process.env.SKILL_PACKAGE_STORAGE_DIR; else process.env.SKILL_PACKAGE_STORAGE_DIR = previousStorage; await rm(directory, { recursive: true, force: true }); });
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: "Plugin page participant" });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "maintainer", explicitPermissions: ["mcp.invoke"] });
  const key = await f.identity.issueKey(f.owner.headers, agent.id, { name: "Plugin page fixture", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read", "resource.write", "mcp.manage", "mcp.invoke"] }] });
  const signer = generateKeyPairSync("ed25519"), profile = { id: "page-shell", image: process.env.TW_SKILL_RUNTIME_TEST_IMAGE!, interpreter: "shell", timeoutMs: 5000 };
  const env = { TW_AUTH_SECRET: f.configuration.secret, TW_AUTH_BASE_URL: f.configuration.baseURL, TW_AUTH_TRUSTED_ORIGINS: f.configuration.trustedOrigins[0], TW_PRESET_SKILLS_SYNC: "disabled", SKILL_PACKAGE_STORAGE_DIR: directory, TW_PLUGIN_RUNTIME_PROFILES: JSON.stringify([profile]), TW_PLUGIN_PUBLISHER_KEYS: JSON.stringify({ "page-key": { publisher: "fixture", publicKey: signer.publicKey.export({ type: "spki", format: "pem" }).toString() } }), TW_PLUGIN_WEB_ORIGIN: f.configuration.trustedOrigins[0], TW_PLUGIN_ARTIFACT_ORIGIN: `http://localhost:${artifactPort}`, TW_PLUGIN_ARTIFACT_PORT: String(artifactPort) };
  const application = createApiApplication({ db, databaseUrl: databaseUrl!, env, runtimeDependencies: { initRealtime: async () => {}, shutdownRealtime: async () => {}, subscribe: () => () => {} } });
  await application.start(); t.after(() => application.stop());
  const app = application.app;
  const storage = new skillPackageStorageService.LocalSkillPackageStorageAdapter(directory);
  const pkg = await createResourceServices(f.owner.context).skillPackageService.registerPackage(db, registerSkillPackageSchema.parse({ projectId: f.project.id, name: "Page artifact", version: "1.0", files: [{ path: "SKILL.md", contentBase64: Buffer.from("Page fixture").toString("base64") }, { path: "run.sh", contentBase64: Buffer.from('cat >/dev/null; printf \'{"result":1}\'\n').toString("base64") }, { path: "page.html", contentBase64: Buffer.from('<h1>Counter</h1><output data-tw-result>0</output><button data-tw-method="read">Refresh</button>').toString("base64") }] }), f.owner.context.actor, storage);
  const headers = { authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" };
  const resolved = await app.request("http://127.0.0.1:3001/api/v1/mcp-server/tools/tw_skill_packages_resolve", { method: "POST", headers, body: JSON.stringify({ packageId: pkg.id, version: "1.0" }) });
  const artifact = (await resolved.json() as any).structuredContent.data;
  const unsigned = pluginManifestSchema.parse({ schemaVersion: 1, pluginId: "fixture/page", version: "1.0.0", displayName: "Counter page", artifact: { packageId: pkg.id, version: "1.0", manifestHash: artifact.manifestHash }, permissions: ["ui.render", "backend.execute", "storage.read"], frontend: { entryPath: "page.html" }, backend: { profileId: profile.id, profileHash: capabilityDigest(profile), entryPath: "run.sh" }, methods: [{ name: "read", access: "read" }] });
  const manifest = { ...unsigned, signature: { algorithm: "ed25519" as const, keyId: "page-key", value: sign(null, Buffer.from(pluginSigningPayload(unsigned)), signer.privateKey).toString("base64") } };
  const installed = await app.request("http://127.0.0.1:3001/api/v1/plugins", { method: "POST", headers, body: JSON.stringify({ scope: { kind: "project", projectId: f.project.id }, manifest, confirmedManifestHash: capabilityDigest(manifest), confirmed: true, idempotencyKey: randomUUID() }) });
  assert.equal(installed.status, 201, await installed.clone().text());
  const id = (await installed.json() as any).installationId;
  const viewerAbort = new AbortController();
  const viewer = await app.request(`http://127.0.0.1:3001/api/v1/plugins/${id}/viewer`, { headers, signal: viewerAbort.signal });
  assert.equal(viewer.status, 200, await viewer.clone().text());
  const ticket = await viewer.json() as any;
  viewerAbort.abort();
  assert.deepEqual(ticket.allowedMethods, ["read"]);
  assert.ok(ticket.artifactUrl.startsWith(`http://localhost:${artifactPort}/artifacts/`));
  const artifactResponse = await fetch(ticket.artifactUrl, { headers: { cookie: "ignored-core-session=fixture", authorization: "ignored-fixture-value" } });
  assert.equal(artifactResponse.status, 200);
  assert.equal(artifactResponse.headers.get("set-cookie"), null);
  assert.equal(artifactResponse.headers.get("access-control-allow-origin"), null);
  assert.ok(artifactResponse.headers.get("content-security-policy")?.includes("sandbox allow-scripts"));
  assert.ok(artifactResponse.headers.get("content-security-policy")?.includes("connect-src 'none'"));
  const html = await artifactResponse.text();
  assert.ok(html.includes("Counter")); assert.ok(!html.includes(key.rawKey)); assert.ok(!html.includes("ignored-core-session")); assert.ok(!html.includes("ignored-fixture-value"));
  assert.equal((await fetch(ticket.artifactUrl + "?exfil=fixture")).status, 404);
  assert.equal((await fetch(`http://localhost:${artifactPort}/api/v1/projects`)).status, 404);
  const token = ticket.artifactUrl.split("/").at(-1);
  assert.equal((await app.request("http://127.0.0.1:3001/api/v1/projects", { headers: { authorization: `Bearer ${token}` } })).status, 401);
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "viewer", explicitPermissions: [] });
  await db.update(pluginInstallations).set({ status: "disabled", revision: 2 }).where(eq(pluginInstallations.id, id));
  assert.equal((await fetch(ticket.artifactUrl)).status, 404);
  const hidden = await app.request(`http://127.0.0.1:3001/api/v1/plugins/${id}/viewer`, { headers });
  assert.equal(hidden.status, 404);
  t.diagnostic("Actual dedicated artifact listener serves only trusted-rendered pinned markup, strips credential exposure, rejects Core paths/capability-as-key and withholds revoked tickets. Real browser proof remains separate.");
});
