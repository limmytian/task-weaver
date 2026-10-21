import { randomBytes, randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createDb, runMigrations } from "@task-weaver/db";
import { createResourceServices, registerSkillPackageSchema, skillPackageStorageService, capabilityDigest, pluginManifestSchema, pluginSigningPayload } from "@task-weaver/core";
import { resourcePostgresFixture } from "./resource-postgres-fixture";
import { createApiApplication } from "./application";

let stopFixture: () => Promise<void> = async () => {};
process.once("SIGTERM", () => { void stopFixture().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void stopFixture().finally(() => process.exit(0)); });

/** Run explicitly against the guarded disposable database; never seed an operator's instance. */
async function main() {
  const databaseUrl = process.env.TW_PLUGIN_BROWSER_DATABASE_URL;
  const image = process.env.TW_SKILL_RUNTIME_TEST_IMAGE;
  if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1" || new URL(databaseUrl).pathname !== "/tw_plugin_browser" || !image?.match(/@sha256:[a-f0-9]{64}$/)) throw new Error("Browser fixture requires an explicit disposable loopback database and pinned image");
  const freePort = async () => {
    const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const address = probe.address(); if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
    await new Promise<void>(resolve => probe.close(() => resolve())); return address.port;
  };
  const apiPort = await freePort(), webPort = await freePort(), artifactPort = await freePort();
  const apiOrigin = `http://127.0.0.1:${apiPort}`, webOrigin = `http://127.0.0.1:${webPort}`;
  const directory = await mkdtemp(join(tmpdir(), "tw-plugin-browser-")), packageDirectory = join(directory, "packages");
  const db = createDb(databaseUrl), password = randomBytes(24).toString("base64url");
  stopFixture = async () => { await db.$client.end(); await rm(directory, { recursive: true, force: true }); };
  await runMigrations(databaseUrl);
  const fixture = await resourcePostgresFixture(db, databaseUrl, { password, apiOrigin, webOrigin });
  await fixture.identity.setMembership(fixture.owner.headers, fixture.project.id, fixture.admin.context.actor.id, { role: "maintainer", explicitPermissions: ["mcp.invoke"] });
  const signer = generateKeyPairSync("ed25519"), profile = { id: "browser-counter", image, interpreter: "shell", timeoutMs: 5000 };
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, SKILL_PACKAGE_STORAGE_DIR: packageDirectory, TW_AUTH_SECRET: fixture.configuration.secret, TW_AUTH_BASE_URL: apiOrigin, TW_AUTH_TRUSTED_ORIGINS: webOrigin, TW_API_URL: apiOrigin, TW_PRESET_SKILLS_SYNC: "disabled", TW_PLUGIN_WEB_ORIGIN: webOrigin, TW_PLUGIN_ARTIFACT_ORIGIN: `http://localhost:${artifactPort}`, TW_PLUGIN_ARTIFACT_PORT: String(artifactPort), TW_PLUGIN_RUNTIME_PROFILES: JSON.stringify([profile]), TW_PLUGIN_PUBLISHER_KEYS: JSON.stringify({ "browser-publisher": { publisher: "fixture", publicKey: signer.publicKey.export({ type: "spki", format: "pem" }).toString() } }) };
  const application = createApiApplication({ db, databaseUrl, env });
  stopFixture = async () => { await application.stop(); await db.$client.end(); await rm(directory, { recursive: true, force: true }); };
  await application.start();
  const apiServer = serve({ fetch: application.app.fetch, hostname: "127.0.0.1", port: apiPort }) as Server;
  await once(apiServer, "listening");
  stopFixture = async () => { apiServer.closeAllConnections(); await new Promise<void>(resolve => apiServer.close(() => resolve())); await application.stop(); await db.$client.end(); await rm(directory, { recursive: true, force: true }); };
  const storage = new skillPackageStorageService.LocalSkillPackageStorageAdapter(packageDirectory);
  const script = `set -eu
payload=$(cat)
case "$payload" in *'"method":"__tw_preflight"'*) printf '{"result":{"ready":true}}'; exit 0;; esac
pair=$(printf '%s' "$payload" | sed -n 's/.*"key":"counter","version":\\([0-9]*\\),"value":\\([0-9]*\\).*/\\1 \\2/p')
version=0; count=0
if [ -n "$pair" ]; then set -- $pair; version=$1; count=$2; fi
case "$payload" in *'"method":"read"'*) printf '{"result":%s}' "$count";; *) printf '{"result":%s,"storageChanges":[{"key":"counter","expectedVersion":%s,"operation":"put","value":%s}]}' "$((count+1))" "$version" "$((count+1))";; esac
`;
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>Counter</title></head><body><h1>Counter</h1><p>Persistent plugin-owned state</p><output data-tw-result>0</output><button data-tw-method="increment">Add one</button><button data-tw-method="read">Refresh</button></body></html>';
  const pkg = await createResourceServices(fixture.owner.context).skillPackageService.registerPackage(db, registerSkillPackageSchema.parse({ projectId: fixture.project.id, name: "Browser counter artifact", version: "1.0", files: [{ path: "SKILL.md", contentBase64: Buffer.from("Installed browser counter fixture").toString("base64") }, { path: "run.sh", contentBase64: Buffer.from(script).toString("base64") }, { path: "page.html", contentBase64: Buffer.from(html).toString("base64") }] }), fixture.owner.context.actor, storage);
  const key = await fixture.identity.issueKey(fixture.admin.headers, fixture.admin.context.actor.id, { name: "Disposable browser installation", expiresAt: null, grants: [{ scope: "project", projectId: fixture.project.id, permissions: ["resource.read", "resource.write", "mcp.manage", "mcp.invoke"] }] });
  const headers = { authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" };
  const resolution = await application.app.request(`${apiOrigin}/api/v1/mcp-server/tools/tw_skill_packages_resolve`, { method: "POST", headers, body: JSON.stringify({ packageId: pkg.id, version: "1.0" }) });
  const artifact = (await resolution.json() as any).structuredContent.data;
  const unsigned = pluginManifestSchema.parse({ schemaVersion: 1, pluginId: "fixture/counter", version: "1.0.0", displayName: "Counter", artifact: { packageId: pkg.id, version: "1.0", manifestHash: artifact.manifestHash }, permissions: ["ui.render", "backend.execute", "storage.read", "storage.write"], frontend: { entryPath: "page.html" }, backend: { profileId: profile.id, profileHash: capabilityDigest(profile), entryPath: "run.sh" }, methods: [{ name: "increment", access: "write" }, { name: "read", access: "read" }] });
  const manifest = { ...unsigned, signature: { algorithm: "ed25519" as const, keyId: "browser-publisher", value: sign(null, Buffer.from(pluginSigningPayload(unsigned)), signer.privateKey).toString("base64") } };
  const installation = await application.app.request(`${apiOrigin}/api/v1/plugins`, { method: "POST", headers, body: JSON.stringify({ scope: { kind: "project", projectId: fixture.project.id }, manifest, confirmedManifestHash: capabilityDigest(manifest), confirmed: true, idempotencyKey: randomUUID() }) });
  if (installation.status !== 201) throw new Error("Browser fixture plugin installation failed: " + await installation.text());
  const installed = await installation.json() as { installationId: string };
  const next = spawn(process.execPath, [fileURLToPath(new URL("../../web/node_modules/next/dist/bin/next", import.meta.url)), "start", "-H", "127.0.0.1", "-p", String(webPort)], { cwd: fileURLToPath(new URL("../../web/", import.meta.url)), env, stdio: ["ignore", "pipe", "pipe"] });
  const log = createWriteStream(join(directory, "web.log"), { mode: 0o600 }); next.stdout.pipe(log); next.stderr.pipe(log);
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true;
    next.kill("SIGTERM"); await Promise.race([once(next, "exit"), delay(3000)]); if (next.exitCode === null) next.kill("SIGKILL"); log.end();
    apiServer.closeAllConnections(); await new Promise<void>(resolve => apiServer.close(() => resolve()));
    await application.stop(); await db.$client.end(); await rm(directory, { recursive: true, force: true });
  };
  stopFixture = stop;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (next.exitCode !== null) break;
    try { if ((await fetch(webOrigin + "/login")).ok) { ready = true; break; } } catch { /* The actual Next application is still starting. */ }
    await delay(200);
  }
  if (!ready) { await stop(); throw new Error("Actual Next application did not become ready; build it before running the browser fixture"); }
  const accessPath = join(directory, "access.json");
  await writeFile(accessPath, JSON.stringify({ webOrigin, loginUrl: webOrigin + "/login", viewerUrl: `${webOrigin}/plugins/${installed.installationId}`, email: fixture.admin.account.email, password, installationId: installed.installationId, projectId: fixture.project.id, manifestHash: capabilityDigest(manifest), image, artifactOrigin: env.TW_PLUGIN_ARTIFACT_ORIGIN }), { mode: 0o600 });
  console.log("PLUGIN_BROWSER_FIXTURE_READY " + accessPath);
}
main().catch(async error => { console.error(error instanceof Error ? error.message : "Browser fixture failed"); try { await stopFixture(); } finally { process.exit(1); } });
