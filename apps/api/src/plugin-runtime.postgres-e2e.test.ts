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
  const { createAuthorizedMcpExecutor } = await import("@task-weaver/core/mcp-server/executor");
  const { setMcpInvocationPolicy } = await import("@task-weaver/core");
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const executor = createAuthorizedMcpExecutor(db, context, storage, undefined, false, undefined, { prepare: async (value, workerSignal) => {
    const execution = await prepare(value, workerSignal);
    return { ...execution, execute: async (input, runningSignal) => { markStarted(); return execution.execute(input, runningSignal); } };
  } });
  const deniedRun = assert.rejects(executor("tw_plugins_call", { installationId: installation!.id, ...request() }, signal), /denied|abort/i);
  await started;
  await setMcpInvocationPolicy(db, f.owner.context, { projectId: f.project.id }, "tw_plugins_call", "deny");
  await deniedRun;
  assert.equal((await db.select().from(pluginStorage).where(eq(pluginStorage.installationId, installation!.id)))[0]?.value, 4, "policy revocation cannot commit a late worker patch");
  await setMcpInvocationPolicy(db, f.owner.context, { projectId: f.project.id }, "tw_plugins_call", "allow");
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
  const outsiderKey = await f.identity.issueKey(f.outsider.headers, f.outsider.context.actor.id, { name: "Unrelated plugin reader", expiresAt: null, grants: [{ scope: "personal", actorId: f.outsider.context.actor.id, permissions: ["resource.read"] }] });
  const signer = generateKeyPairSync("ed25519");
  const profile = { id: "lifecycle-shell", image: process.env.TW_SKILL_RUNTIME_TEST_IMAGE!, interpreter: "shell", timeoutMs: 5000 };
  const env: Record<string, string> = { TW_AUTH_SECRET: f.configuration.secret, TW_AUTH_BASE_URL: f.configuration.baseURL, TW_AUTH_TRUSTED_ORIGINS: f.configuration.trustedOrigins[0]!, TW_PRESET_SKILLS_SYNC: "disabled", TW_MCP_ALLOWED_HOSTS: "127.0.0.1:3001", TW_PLUGIN_RUNTIME_PROFILES: JSON.stringify([profile]), TW_PLUGIN_PUBLISHER_KEYS: JSON.stringify({ "lifecycle-key": { publisher: "fixture", publicKey: signer.publicKey.export({ type: "spki", format: "pem" }).toString() } }) };
  const app = createApiApplication({ db, databaseUrl: databaseUrl!, env }).app;
  const call = async (path: string, body?: unknown, rawKey = credential.rawKey) => {
    const response = await app.request(`http://127.0.0.1:3001/api/v1/plugins${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };
  const mcpCall = async (name: string, input: unknown, rawKey = credential.rawKey) => {
    const response = await app.request(`http://127.0.0.1:3001/api/v1/mcp-server/tools/${name}`, { method: "POST", headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    const result = await response.json() as any;
    return result.structuredContent ?? result;
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
  const { pluginDirectoryReviewHash } = await import("@task-weaver/core");
  const reviewedEntry = { id: "lifecycle-counter", maintainer: "Fixture maintenance", sourceUrl: "https://github.com/limmytian/task-weaver", sourceRevision: "a".repeat(40), reviewedAt: new Date().toISOString(), manifest };
  const directoryEntry = { ...reviewedEntry, reviewHash: pluginDirectoryReviewHash(reviewedEntry) };
  const hiddenEntry = { ...reviewedEntry, id: "private-artifact", manifest: { ...manifest, artifact: { ...manifest.artifact, packageId: randomUUID() } } };
  env.TW_PLUGIN_DIRECTORY = JSON.stringify([directoryEntry, { ...hiddenEntry, reviewHash: pluginDirectoryReviewHash(hiddenEntry) }]);
  const directoryConfig = env.TW_PLUGIN_DIRECTORY;
  const catalog = await call(`/directory?scope=project&projectId=${f.project.id}`);
  assert.equal(catalog.status, 200); assert.equal(catalog.data.items.length, 1);
  assert.equal(catalog.data.items[0].manifest, undefined); assert.equal(catalog.data.items[0].publisherTrust, "verified");
  assert.equal((await call(`/directory?scope=project&projectId=${f.project.id}`, undefined, outsiderKey.rawKey)).data.items.length, 0);
  const inspected = await call(`/directory/lifecycle-counter?scope=project&projectId=${f.project.id}`);
  assert.equal(inspected.data.availability.state, "review_required", JSON.stringify(inspected.data));
  assert.equal((await call(`/directory/lifecycle-counter?scope=project&projectId=${f.project.id}`, undefined, readCredential.rawKey)).data.availability.state, "unavailable");
  assert.equal((await db.select().from(pluginInstallations).where(eq(pluginInstallations.projectId, f.project.id))).length, 0, "discovery and readiness cannot install a plugin");
  const install = { directory: { entryId: directoryEntry.id, reviewHash: directoryEntry.reviewHash }, scope: { kind: "project", projectId: f.project.id }, manifest, confirmedManifestHash: capabilityDigest(manifest), confirmed: true, idempotencyKey: randomUUID() };
  assert.equal((await call("", install, readCredential.rawKey)).status, 403);
  env.TW_PLUGIN_DIRECTORY = "[]";
  assert.equal((await call("", install)).status, 409, "withdrawn entries cannot install from cached reviews");
  env.TW_PLUGIN_DIRECTORY = directoryConfig;
  const installed = await Promise.all([call("", install), call("", install)]);
  for (const result of installed) assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(installed.filter(result => result.data.replayed).length, 1);
  const id = installed[0]!.data.installationId;
  env.TW_PLUGIN_DIRECTORY = "[]";
  assert.equal((await call("", install)).status, 409, "old install receipts must recheck directory selection");
  env.TW_PLUGIN_DIRECTORY = directoryConfig;

  assert.equal(installed[1]!.data.installationId, id);
  const managementList = (await call(`?scope=project&projectId=${f.project.id}`)).data;
  assert.equal(managementList.items.length, 1);
  assert.equal(managementList.items[0].displayName, manifest.displayName);
  assert.equal(managementList.items[0].manifest, undefined);
  assert.deepEqual(managementList.permissions, { manage: true, activate: true });
  assert.deepEqual((await call(`?scope=project&projectId=${f.project.id}`, undefined, readCredential.rawKey)).data.permissions, { manage: false, activate: false });
  assert.equal((await call(`/${id}`)).data.manifestHash, install.confirmedManifestHash);
  const invocation = { expectedRevision: 1, method: "increment", input: {}, confirmed: true, idempotencyKey: randomUUID() };
  const summaries = await mcpCall("tw_plugins_list", { scope: "project", projectId: f.project.id });
  assert.equal(summaries.data.items[0].id, id);
  assert.equal(summaries.data.items[0].manifest, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(summaries.data)) <= 16384);
  assert.equal((await mcpCall("tw_plugins_get", { installationId: id })).data.manifestHash, install.confirmedManifestHash);
  assert.equal((await mcpCall("tw_plugins_list", { scope: "personal" })).ok, false);
  assert.equal((await mcpCall("tw_plugins_get", { installationId: id }, outsiderKey.rawKey)).ok, false);
  assert.equal((await mcpCall("tw_plugins_call", { installationId: id, ...invocation }, readCredential.rawKey)).ok, false);
  assert.equal((await mcpCall("tw_plugins_call", { installationId: id, ...invocation, expectedRevision: 2 })).ok, false);
  const executed = await mcpCall("tw_plugins_call", { installationId: id, ...invocation });
  assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.equal(executed.data.result, 7);
  assert.equal(executed.data.untrustedOutput, true);
  assert.equal((await call(`/${id}/invoke`, invocation)).data.replayed, true, "REST and MCP share the same receipt");
  assert.equal((await mcpCall("tw_plugins_call", { installationId: id, ...invocation })).data.replayed, true);
  assert.equal((await mcpCall("tw_plugins_call", { installationId: id, ...invocation, input: { changed: true } })).ok, false);
  const { setMcpInvocationPolicy } = await import("@task-weaver/core");
  await setMcpInvocationPolicy(db, f.owner.context, { projectId: f.project.id }, "tw_plugins_call", "deny");
  assert.equal((await mcpCall("tw_plugins_call", { installationId: id, ...invocation })).ok, false);
  await setMcpInvocationPolicy(db, f.owner.context, { projectId: f.project.id }, "tw_plugins_call", "approval");
  assert.equal((await mcpCall("tw_plugins_call", { installationId: id, ...invocation })).error.code, "approval_required");
  await setMcpInvocationPolicy(db, f.owner.context, { projectId: f.project.id }, "tw_plugins_call", "allow");
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
  assert.equal((await mcpCall("tw_plugins_call", { installationId: id, ...invocation })).ok, false);
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
  let networkApp = app;
  const server = serve({ fetch: request => networkApp.fetch(request), hostname: "127.0.0.1", port: 0 }) as import("node:http").Server;
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => { server.closeIdleConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  networkApp = createApiApplication({ db, databaseUrl: databaseUrl!, env: { ...env, TW_MCP_ALLOWED_HOSTS: `127.0.0.1:${address.port}` } }).app;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const httpClient = new Client({ name: "plugin-http", version: "1" });
  await httpClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/api/v1/mcp-server`), { requestInit: { headers: { authorization: `Bearer ${credential.rawKey}` } } }));
  t.after(() => httpClient.close());
  const localClient = new Client({ name: "plugin-stdio", version: "1" });
  await localClient.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)), "mcp", "serve"], env: { PATH: "/no-local-tools", TW_CONFIG_DIR: directory, TW_API_URL: `http://127.0.0.1:${address.port}`, TW_API_KEY: credential.rawKey }, stderr: "pipe" }));
  t.after(() => localClient.close());
  const commonRequest = { installationId: fresh.data.installationId, ...invocation, idempotencyKey: randomUUID() };
  for (const [index, client] of [httpClient, localClient].entries()) {
    assert.ok((await client.listTools()).tools.some(tool => tool.name === "tw_plugins_call"));
    const summary = (await client.callTool({ name: "tw_plugins_list", arguments: { scope: "project", projectId: f.project.id } })).structuredContent as any;
    assert.equal(summary.data.items.length, 2);
    const result = (await client.callTool({ name: "tw_plugins_call", arguments: commonRequest })).structuredContent as any;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.result, 7);
    assert.equal(result.data.replayed, index === 1);
  }
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)), "plugin", ...args, "--json"], { timeout: 15000, env: { ...process.env, PATH: "/no-local-tools", TW_CONFIG_DIR: directory, TW_API_URL: `http://127.0.0.1:${address.port}`, TW_API_KEY: credential.rawKey } })).stdout);
  const { createDocumentSchema } = await import("@task-weaver/core");
  const bindingDocument = await createResourceServices(f.owner.context).documentService.createDocument(db, createDocumentSchema.parse({ projectId: f.project.id, title: "CLI skill binding", docType: "skill", content: "Hosted CLI guidance" }), f.owner.context.actor);
  const binding = await cli("skill-binding", bindingDocument.id, "--name", "guidance");
  assert.deepEqual(binding, { name: "guidance", documentId: bindingDocument.id, version: bindingDocument.version, contentHash: capabilityDigest({ content: bindingDocument.content }) });
  assert.equal((await cli("directory", "--project", f.project.id)).items.length, 1);
  assert.equal((await cli("directory", "lifecycle-counter", "--project", f.project.id)).availability.reason, "installed");
  assert.equal((await cli("list", "--project", f.project.id)).items.length, 2);
  assert.equal((await cli("get", fresh.data.installationId)).revision, 1);
  assert.equal((await cli("generations", fresh.data.installationId)).items.length, 1);
  assert.equal((await cli("generation", fresh.data.installationId, manifest.version)).manifestHash, capabilityDigest(manifest));
  const invocationFile = join(directory, "invoke.json");
  await writeFile(invocationFile, JSON.stringify({ ...invocation, idempotencyKey: commonRequest.idempotencyKey }));
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

test("plugin skill bindings hydrate scoped pinned instructions and recheck revisions before replay/commit", { skip: !databaseUrl, timeout: 120000 }, async t => {
  const { createPluginLifecycle, createDocumentSchema, pluginPermissionDiff } = await import("@task-weaver/core");
  const { resolvePluginSkills } = await import("@task-weaver/core");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!); t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: "Plugin skill consumer" });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "maintainer", explicitPermissions: ["mcp.invoke"] });
  const key = await f.identity.issueKey(f.owner.headers, agent.id, { name: "Pinned plugin skills", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read", "resource.write", "mcp.manage", "mcp.invoke"] }] });
  const context = await f.auth.resolve(new Headers({ authorization: `Bearer ${key.rawKey}` }));
  const directory = await mkdtemp(join(tmpdir(), "tw-plugin-skills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new skillPackageStorageService.LocalSkillPackageStorageAdapter(directory);
  const documents = createResourceServices(f.owner.context).documentService;
  const content = "Hosted guidance";
  const skill = await documents.createDocument(db, createDocumentSchema.parse({ projectId: f.project.id, title: "Pinned plugin guidance", content, docType: "skill" }), f.owner.context.actor);
  const profile = { id: "skill-consumer", image: process.env.TW_SKILL_RUNTIME_TEST_IMAGE!, interpreter: "shell", timeoutMs: 5000 };
  const script = `set -eu
payload=$(cat)
case "$payload" in *'"untrusted":true'*Hosted*guidance*|*Hosted*guidance*'"untrusted":true'*) ;; *) exit 17;; esac
sleep 1
printf '{"result":"skill-used"}'
`;
  const pkg = await createResourceServices(f.owner.context).skillPackageService.registerPackage(db, registerSkillPackageSchema.parse({ projectId: f.project.id, name: "Skill consumer", version: "1.0", files: [{ path: "SKILL.md", contentBase64: Buffer.from("Plugin fixture").toString("base64") }, { path: "backend.sh", contentBase64: Buffer.from(script).toString("base64") }] }), f.owner.context.actor, storage);
  const resolved = await f.app.request("http://127.0.0.1:3001/api/v1/mcp-server/tools/tw_skill_packages_resolve", { method: "POST", headers: { authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" }, body: JSON.stringify({ packageId: pkg.id, version: "1.0" }) });
  const artifactHash = (await resolved.json() as any).structuredContent.data.manifestHash;
  const signer = generateKeyPairSync("ed25519");
  const configuration = () => ({ profiles: JSON.stringify([profile]), keys: { "skills-key": { publisher: "fixture", publicKey: signer.publicKey.export({ type: "spki", format: "pem" }).toString() } } });
  const signManifest = (raw: unknown) => {
    const value = pluginManifestSchema.parse(raw);
    return { ...value, signature: { algorithm: "ed25519" as const, keyId: "skills-key", value: sign(null, Buffer.from(pluginSigningPayload(value)), signer.privateKey).toString("base64") } };
  };
  const manifest = signManifest({ schemaVersion: 1, pluginId: "fixture/skills", version: "1.0.0", displayName: "Skill consumer", artifact: { packageId: pkg.id, version: "1.0", manifestHash: artifactHash }, backend: { profileId: profile.id, profileHash: capabilityDigest(profile), entryPath: "backend.sh" }, permissions: ["backend.execute", "skills.read"], methods: [{ name: "read", access: "read" }], skillBindings: [{ name: "guidance", documentId: skill.id, version: skill.version, contentHash: capabilityDigest({ content }) }] });
  const scope = { projectId: f.project.id };
  const signal = AbortSignal.timeout(100000);
  await assert.rejects(resolvePluginSkills(db, context, manifest, {}), /denied/, "project instructions cannot enter a global installation even with caller read access");
  await assert.rejects(resolvePluginSkills(db, context, manifest, { personalOwnerId: context.actor.id, personalOwnerType: "human" }), /denied/);
  await assert.rejects(resolvePluginSkills(db, context, manifest, { projectId: randomUUID() }), /denied/);
  await assert.rejects(resolvePluginSkills(db, f.outsider.context, manifest, scope), /denied|not found/i);
  const prepare = (value: PluginManifest, workerSignal: AbortSignal) => preparePluginWorker(db, context, value, storage, configuration, workerSignal);
  const lifecycle = createPluginLifecycle(db, context, configuration, prepare);
  const wrongHash = signManifest({ ...manifest, signature: undefined, skillBindings: [{ ...manifest.skillBindings![0], contentHash: "f".repeat(64) }] });
  await assert.rejects(lifecycle.install({ scope: { kind: "project", ...scope }, manifest: wrongHash, confirmedManifestHash: capabilityDigest(wrongHash), confirmed: true, idempotencyKey: randomUUID() }, signal), /content changed/);
  const largeContent = "x".repeat(32700);
  const largeSkill = await documents.createDocument(db, createDocumentSchema.parse({ projectId: f.project.id, title: "Bounded plugin input", content: largeContent, docType: "skill" }), f.owner.context.actor);
  const largeManifest = signManifest({ ...manifest, signature: undefined, skillBindings: [{ name: "large", documentId: largeSkill.id, version: largeSkill.version, contentHash: capabilityDigest({ content: largeContent }) }] });
  await assert.rejects(resolvePluginSkills(db, context, largeManifest, scope), /aggregate budget/);
  const installed = await lifecycle.install({ scope: { kind: "project", ...scope }, manifest, confirmedManifestHash: capabilityDigest(manifest), confirmed: true, idempotencyKey: randomUUID() }, signal);
  const request = { method: "read", input: {}, expectedRevision: 1, confirmed: true, idempotencyKey: randomUUID() };
  const invoke = (input = request) => invokeInstalledPlugin(db, context, installed.installationId, input, prepare, signal);
  assert.equal((await invoke()).result, "skill-used");
  assert.equal((await invoke()).replayed, true);
  const revisedContent = "Hosted guidance revised";
  const revised = await documents.updateDocument(db, skill.id, { expectedVersion: skill.version, content: revisedContent }, f.owner.context.actor);
  await assert.rejects(invoke(), /Skill changed|content changed/, "a cached result cannot bypass the dependency revision guard");
  const next = signManifest({ ...manifest, signature: undefined, version: "1.1.0", skillBindings: [{ ...manifest.skillBindings![0], version: revised.version, contentHash: capabilityDigest({ content: revisedContent }) }] });
  const diff = pluginPermissionDiff(manifest, next);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  const upgrade = { manifest: next, expectedRevision: 1, confirmedManifestHash: capabilityDigest(next), confirmedPermissionDiffHash: pluginPermissionDiff(manifest, manifest).hash, confirmed: true, idempotencyKey: randomUUID() };
  await assert.rejects(lifecycle.activate(installed.installationId, "upgrade", upgrade, signal), /permission diff/);
  await lifecycle.activate(installed.installationId, "upgrade", { ...upgrade, confirmedPermissionDiffHash: diff.hash }, signal);
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const revokedInvocation = assert.rejects(invokeInstalledPlugin(db, context, installed.installationId, { ...request, expectedRevision: 2, idempotencyKey: randomUUID() }, async (value, workerSignal) => {
    const worker = await prepare(value, workerSignal);
    return { ...worker, execute: async (input, executionSignal) => { started(); return worker.execute(input, executionSignal); } };
  }, signal), /Skill changed|content changed|abort/i);
  await running;
  await documents.updateDocument(db, skill.id, { expectedVersion: revised.version, content: "Revoked hosted guidance" }, f.owner.context.actor);
  await revokedInvocation;
  assert.equal((await db.select().from(pluginInvocationReceipts).where(eq(pluginInvocationReceipts.installationId, installed.installationId))).length, 1, "stale dependency results never commit a receipt");
  t.diagnostic("Actual signed installation/preflight and offline containers consumed pinned hosted skill instructions; cross-scope, changed-revision replay, dependency-diff and in-flight commit guards passed.");
});

test("plugin declared MCP reads use the live broker without worker credentials or hidden preflight calls", { skip: !databaseUrl, timeout: 120000 }, async t => {
  const { createApiApplication } = await import("./application");
  const { mcpPool } = await import("./mcp-pool");
  const { configureMcpToolAuthorization, inspectPluginTools, setMcpInvocationPolicy, approveMcpInvocation, pluginPermissionDiff } = await import("@task-weaver/core");
  const { serve } = await import("@hono/node-server");
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!); t.after(() => db.$client.end());
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const agent = await f.identity.createAgent(f.owner.headers, { displayName: "Plugin MCP reader" });
  await f.identity.setMembership(f.owner.headers, f.project.id, agent.id, { role: "maintainer", explicitPermissions: ["mcp.invoke"] });
  const key = await f.identity.issueKey(f.owner.headers, agent.id, { name: "Plugin external reads", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read", "resource.write", "mcp.manage", "mcp.invoke"] }] });
  const context = await f.auth.resolve(new Headers({ authorization: `Bearer ${key.rawKey}` }));
  let calls = 0;
  let received: Record<string, unknown> = {};
  let markStarted = () => {};
  let releaseRemote = () => {};
  const external = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    assert.equal(request.headers.get("x-task-weaver-mcp-hop"), "1");
    assert.equal(request.headers.get("x-private-key"), "fixture-plugin-secret");
    const server = new Server({ name: "plugin-external", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "lookup", inputSchema: { type: "object", properties: { query: { type: "string" }, projectId: { type: "string" } }, required: ["query", "projectId"] } }] }));
    server.setRequestHandler(CallToolRequestSchema, async call => {
      calls++; received = call.params.arguments ?? {};
      assert.equal(received.projectId, f.project.id);
      if (received.query === "slow") { markStarted(); await new Promise<void>(resolve => { releaseRemote = resolve; }); }
      return { content: [{ type: "text", text: received.query === "large" ? "x".repeat(20000) : `host-echo:${received.query}:fixture-plugin-secret` }] };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try { return await transport.handleRequest(request); } finally { await server.close(); }
  } });
  await once(external, "listening");
  t.after(async () => { releaseRemote(); if ("closeAllConnections" in external) external.closeAllConnections(); await new Promise<void>(resolve => external.close(() => resolve())); });
  const registry = createResourceServices(f.owner.context).mcpRegistryService;
  const registered = await registry.registerServer(db, { name: "Plugin declared reader", projectId: f.project.id, transport: "streamable-http", config: { url: `http://127.0.0.1:${(external.address() as { port: number }).port}/mcp`, headers: { "x-private-key": "fixture-plugin-secret" } }, active: true, readOnly: false, tags: [] }, f.owner.context.actor);
  t.after(() => mcpPool.disconnect(registered.id));
  const [tool] = await registry.syncTools(db, registered.id, mcpPool); assert.ok(tool);
  await configureMcpToolAuthorization(db, f.owner.context, tool.id, { readOnly: true, targetProjectArgument: "projectId" });
  const current = await createResourceServices(context).mcpRegistryService.getToolDetail(db, tool.id);
  const schemaHash = capabilityDigest({ name: current.name, inputSchema: current.inputSchema, readOnly: current.readOnly, targetProjectArgument: current.targetProjectArgument });
  const directory = await mkdtemp(join(tmpdir(), "tw-plugin-tools-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new skillPackageStorageService.LocalSkillPackageStorageAdapter(directory);
  const profile = { id: "tool-reader", image: process.env.TW_SKILL_RUNTIME_TEST_IMAGE!, interpreter: "shell", timeoutMs: 5000 };
  const script = `set -eu
payload=$(cat)
case "$payload" in *'"method":"__tw_preflight"'*) printf '{"result":{"ready":true}}'; exit 0;; esac
test -z "\${TW_API_KEY:-}"
if grep -q eth0 /proc/net/dev; then exit 13; fi
case "$payload" in *fixture-plugin-secret*) exit 17;; esac
case "$payload" in *host-echo*'"untrusted":true'*) printf '{"result":"mcp-used"}';; *) exit 18;; esac
`;
  const pkg = await createResourceServices(f.owner.context).skillPackageService.registerPackage(db, registerSkillPackageSchema.parse({ projectId: f.project.id, name: "MCP reader plugin", version: "1.0", files: [{ path: "SKILL.md", contentBase64: Buffer.from("Declared MCP reader").toString("base64") }, { path: "backend.sh", contentBase64: Buffer.from(script).toString("base64") }] }), f.owner.context.actor, storage);
  const signer = generateKeyPairSync("ed25519");
  const env = { TW_AUTH_SECRET: f.configuration.secret, TW_AUTH_BASE_URL: f.configuration.baseURL, TW_AUTH_TRUSTED_ORIGINS: f.configuration.trustedOrigins[0]!, TW_PRESET_SKILLS_SYNC: "disabled", TW_MCP_ALLOWED_HOSTS: "127.0.0.1:3001", SKILL_PACKAGE_STORAGE_DIR: directory, TW_PLUGIN_RUNTIME_PROFILES: JSON.stringify([profile]), TW_PLUGIN_PUBLISHER_KEYS: JSON.stringify({ "tools-key": { publisher: "fixture", publicKey: signer.publicKey.export({ type: "spki", format: "pem" }).toString() } }) };
  const app = createApiApplication({ db, databaseUrl: databaseUrl!, env }).app;
  const json = async (path: string, body: unknown) => {
    const response = await app.request(`http://127.0.0.1:3001/api/v1/${path}`, { method: "POST", headers: { authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };
  const artifact = (await json("mcp-server/tools/tw_skill_packages_resolve", { packageId: pkg.id, version: "1.0" })).data.structuredContent.data;
  const unsigned = pluginManifestSchema.parse({ schemaVersion: 1, pluginId: "fixture/tools", version: "1.0.0", displayName: "Declared MCP reader", artifact: { packageId: pkg.id, version: "1.0", manifestHash: artifact.manifestHash }, backend: { profileId: profile.id, profileHash: capabilityDigest(profile), entryPath: "backend.sh" }, permissions: ["backend.execute", "mcp.read"], methods: [{ name: "read", access: "read" }], toolBindings: [{ name: "constructor", method: "read", toolId: tool.id, schemaHash, arguments: {}, inputArguments: ["query"] }] });
  const manifest = { ...unsigned, signature: { algorithm: "ed25519" as const, keyId: "tools-key", value: sign(null, Buffer.from(pluginSigningPayload(unsigned)), signer.privateKey).toString("base64") } };
  const stale = pluginManifestSchema.parse({ ...manifest, toolBindings: [{ ...manifest.toolBindings![0], schemaHash: "f".repeat(64) }] });
  await assert.rejects(inspectPluginTools(db, context, stale, { projectId: f.project.id }), /schema changed/);
  await configureMcpToolAuthorization(db, f.owner.context, tool.id, { readOnly: false, targetProjectArgument: "projectId" });
  await assert.rejects(inspectPluginTools(db, context, manifest, { projectId: f.project.id }), /denied/);
  await configureMcpToolAuthorization(db, f.owner.context, tool.id, { readOnly: true, targetProjectArgument: "projectId" });
  await assert.rejects(inspectPluginTools(db, context, manifest, {}), /denied/);
  await assert.rejects(inspectPluginTools(db, context, manifest, { projectId: randomUUID() }), /denied/);
  const retargeted = pluginManifestSchema.parse({ ...manifest, toolBindings: [{ ...manifest.toolBindings![0], inputArguments: ["projectId"] }] });
  await assert.rejects(inspectPluginTools(db, context, retargeted, { projectId: f.project.id }), /denied/);
  const modified = pluginManifestSchema.parse({ ...manifest, toolBindings: [{ ...manifest.toolBindings![0], inputArguments: ["other"] }] });
  assert.equal(pluginPermissionDiff(manifest, modified).added.length, 1);
  const installed = await json("plugins", { manifest, scope: { kind: "project", projectId: f.project.id }, confirmedManifestHash: capabilityDigest(manifest), confirmed: true, idempotencyKey: randomUUID() });
  assert.equal(installed.status, 201, JSON.stringify(installed.data)); assert.equal(calls, 0, "preflight must not dispatch external tools");
  const id = installed.data.installationId;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  let cliApp = app;
  const apiServer = serve({ fetch: request => cliApp.fetch(request), hostname: "127.0.0.1", port: 0 }) as import("node:http").Server;
  await once(apiServer, "listening");
  t.after(async () => { apiServer.closeAllConnections(); await new Promise<void>(resolve => apiServer.close(() => resolve())); });
  const address = apiServer.address(); assert.ok(address && typeof address !== "string");
  cliApp = createApiApplication({ db, databaseUrl: databaseUrl!, env: { ...env, TW_MCP_ALLOWED_HOSTS: `127.0.0.1:${address.port}` } }).app;
  const cliResult = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)), "plugin", "tool-binding", tool.id, "--name", "constructor", "--method", "read", "--input-arguments", "query", "--json"], { timeout: 15000, env: { ...process.env, PATH: "/no-local-tools", TW_CONFIG_DIR: directory, TW_API_URL: `http://127.0.0.1:${address.port}`, TW_API_KEY: key.rawKey } });
  assert.deepEqual(JSON.parse(cliResult.stdout), manifest.toolBindings![0]);
  const invocation = { method: "read", expectedRevision: 1, toolApprovals: {}, input: { query: "hello", ignored: "must-not-forward" }, confirmed: true, idempotencyKey: randomUUID() };
  const invoke = (input: Record<string, unknown> = invocation) => json(`plugins/${id}/invoke`, input);
  const first = await invoke(); assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.result, "mcp-used");
  assert.deepEqual(received, { query: "hello", projectId: f.project.id }); assert.equal(calls, 1);
  assert.equal((await invoke()).data.replayed, true); assert.equal(calls, 1);
  const shared = await json("mcp-server/tools/tw_plugins_call", { installationId: id, ...invocation });
  assert.equal(shared.data.structuredContent.data.replayed, true); assert.equal(calls, 1);
  assert.equal((await invoke({ ...invocation, idempotencyKey: randomUUID(), input: {} })).status, 400);
  const large = await invoke({ ...invocation, idempotencyKey: randomUUID(), input: { query: "large" } }); assert.equal(large.status, 400);
  await registry.updateServer(db, registered.id, { config: { url: `http://127.0.0.1:${(external.address() as { port: number }).port}/mcp`, headers: { "x-private-key": "rotated-fixture-secret" } } }, f.owner.context.actor);
  assert.equal((await invoke()).status, 409, "cached results cannot survive a changed registry security binding");
  await registry.updateServer(db, registered.id, { config: { url: `http://127.0.0.1:${(external.address() as { port: number }).port}/mcp`, headers: { "x-private-key": "fixture-plugin-secret" } } }, f.owner.context.actor);
  const beforeApproval = calls;
  await setMcpInvocationPolicy(db, f.owner.context, { projectId: f.project.id }, tool.id, "approval");
  const reviewRequest = { ...invocation, idempotencyKey: randomUUID() };
  const pending = await invoke(reviewRequest); assert.equal(pending.status, 403); assert.equal(pending.data.code, "approval_required"); assert.equal(calls, beforeApproval);
  await approveMcpInvocation(db, f.owner.context, pending.data.approvalId);
  const approved = { ...reviewRequest, toolApprovals: { constructor: pending.data.approvalId } };
  assert.equal((await invoke(approved)).status, 200);
  assert.equal((await invoke(approved)).data.replayed, true); assert.equal(calls, beforeApproval + 1);
  await setMcpInvocationPolicy(db, f.owner.context, { projectId: f.project.id }, tool.id, "allow");
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const inFlight = invoke({ ...invocation, idempotencyKey: randomUUID(), input: { query: "slow" } });
  await started;
  await setMcpInvocationPolicy(db, f.owner.context, { projectId: f.project.id }, tool.id, "deny");
  releaseRemote();
  assert.notEqual((await inFlight).status, 200);
  assert.notEqual((await invoke(approved)).status, 200);
  assert.equal((await db.select().from(pluginInvocationReceipts).where(eq(pluginInvocationReceipts.installationId, id))).length, 2, "denied, oversized and in-flight results cannot create receipts");
  t.diagnostic("Actual remote MCP transport, signed install without external preflight calls and offline worker verified; scoped input selection, secret redaction, shared receipt replay, target approval and in-flight deny passed.");
});
