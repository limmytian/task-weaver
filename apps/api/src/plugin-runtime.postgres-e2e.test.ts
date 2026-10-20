import assert from "node:assert/strict";
import test from "node:test";
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
  const [installation] = await db.insert(pluginInstallations).values({ projectId: f.project.id, createdBy: f.owner.context.actor.id, pluginId: manifest.pluginId, status: "active", manifest, manifestHash: capabilityDigest(manifest) }).returning();
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
