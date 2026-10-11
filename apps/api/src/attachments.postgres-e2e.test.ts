import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile, cp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile, execFileSync, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { createDb, runMigrations, documents, documentVersions, documentFileVersions, documentFileGarbage, embeddingProfiles, embeddingJobItems } from "@task-weaver/db";
import { createResourceServices, createRequirementSchema, createTaskSchema, createAttachmentService } from "@task-weaver/core";
import { eq, sql } from "drizzle-orm";
import { resourcePostgresFixture } from "./resource-postgres-fixture";
const databaseUrl = process.env.TW_ATTACHMENTS_E2E_DATABASE_URL;

test("authorized REST and CLI attachment round trips preserve originals and file history", { skip: !databaseUrl, timeout: 120_000 }, async t => {
  const url = new URL(databaseUrl!); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_attachments_e2e");
  await runMigrations(databaseUrl!); await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!); t.after(() => db.$client.end());
  const dir = await mkdtemp(join(tmpdir(), "tw-attachments-e2e-")), previous = process.env.TW_ATTACHMENT_STORAGE_DIR;
  process.env.TW_ATTACHMENT_STORAGE_DIR = join(dir, "storage");
  t.after(async () => { if (previous === undefined) delete process.env.TW_ATTACHMENT_STORAGE_DIR; else process.env.TW_ATTACHMENT_STORAGE_DIR = previous; await rm(dir, { recursive: true, force: true }); });
  await db.execute(await readFile(resolve("../../packages/db/src/setup-search.sql"), "utf8"));
  const f = await resourcePostgresFixture(db, databaseUrl!);
  const api = (path: string, method = "GET", value?: unknown, bytes?: Uint8Array, headers = f.owner.headers) => {
    const h = new Headers(headers);
    if (bytes) h.set("x-tw-attachment-metadata", encodeURIComponent(JSON.stringify(value)));
    return f.app.request(`/api/v1/documents${path}`, { method, headers: h, body: bytes ? new Uint8Array(bytes) : value === undefined ? undefined : JSON.stringify(value) });
  };
  const metadata = { projectId: f.project.id, title: "Attachment fixture", description: "Supplemental material", tags: ["fixture"], originalFilename: "../original.txt", mimeType: "text/plain" };
  const original = Buffer.from("Original bytes\n\u4f60\u597d\n");
  const created = await api("/attachments", "POST", metadata, original); assert.equal(created.status, 201, await created.clone().text());
  const doc: any = await created.json(); assert.equal(doc.form, "attachment"); assert.equal(doc.content, "");
  const downloaded = await api(`/${doc.id}/file`); assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), original); assert.match(downloaded.headers.get("content-disposition")!, /attachment/);
  const preview = await api(`/${doc.id}/file?preview=true`); assert.equal(preview.headers.get("content-type"), "text/plain"); assert.match(preview.headers.get("content-security-policy")!, /sandbox/);
  assert.equal((await api(`/${doc.id}/file`, "GET", undefined, undefined, f.outsider.headers)).status, 404);
  assert.equal((await api(`/${doc.id}/file`, "GET", undefined, undefined, new Headers())).status, 401);
  const edit = await api(`/${doc.id}`, "PATCH", { title: "Edited attachment", expectedVersion: doc.version }); assert.equal(edit.status, 200, await edit.clone().text());
  const edited: any = await edit.json(); assert.equal(edited.currentFileVersionId, doc.currentFileVersionId); assert.equal(edited.version, 2);
  assert.equal((await db.select().from(documentFileVersions).where(eq(documentFileVersions.documentId, doc.id))).length, 1);
  const snapshots = await db.select().from(documentVersions).where(eq(documentVersions.documentId, doc.id));
  assert.equal(snapshots.find(v => v.version === 2)?.title, "Edited attachment");
  assert.ok(snapshots.every(v => v.fileVersionId === doc.currentFileVersionId));
  const detailResponse: any = await (await api(`/${doc.id}`)).json(); assert.equal(detailResponse.file.sha256, doc.file.sha256); assert.equal(detailResponse.file.objectKey, undefined);
  const replacement = Buffer.from("Replacement bytes");
  const replaced = await api(`/${doc.id}/file`, "PUT", { originalFilename: "replacement.txt", mimeType: "text/plain", expectedVersion: edited.version }, replacement);
  assert.equal(replaced.status, 200, await replaced.clone().text()); const current: any = await replaced.json(); assert.equal(current.version, 3); assert.equal(current.file.version, 2);
  assert.deepEqual(Buffer.from(await (await api(`/${doc.id}/file?fileVersion=1`)).arrayBuffer()), original);
  assert.deepEqual(Buffer.from(await (await api(`/${doc.id}/file`)).arrayBuffer()), replacement);
  assert.equal((await api(`/${doc.id}/file?fileVersion=1`, "GET", undefined, undefined, f.outsider.headers)).status, 404);
  assert.equal((await api(`/${doc.id}/file`, "PUT", { originalFilename: "stale.txt", expectedVersion: edited.version }, original)).status, 409);
  const races = await Promise.all([1, 2].map(n => api(`/${doc.id}/file`, "PUT", { originalFilename: `race-${n}.txt`, mimeType: "text/plain", expectedVersion: current.version }, Buffer.from(String(n)))));
  assert.deepEqual(races.map(r => r.status).sort(), [200, 409]);
  const files: any = await (await api(`/${doc.id}/files`)).json(); assert.equal(files.length, 3);
  const html = await api("/attachments", "POST", { ...metadata, originalFilename: "unsafe.html", mimeType: "text/html" }, Buffer.from("<script>alert(1)</script>"));
  const htmlDoc: any = await html.json(); const unsafe = await api(`/${htmlDoc.id}/file?preview=true`);
  assert.equal(unsafe.headers.get("content-type"), "application/octet-stream"); assert.match(unsafe.headers.get("content-disposition")!, /attachment/);

  const count = (await db.select().from(documents)).length;
  const savedLimit = process.env.TW_ATTACHMENT_MAX_BYTES;
  process.env.TW_ATTACHMENT_MAX_BYTES = "4";
  assert.equal((await api("/attachments", "POST", metadata, original)).status, 413);
  if (savedLimit === undefined) delete process.env.TW_ATTACHMENT_MAX_BYTES; else process.env.TW_ATTACHMENT_MAX_BYTES = savedLimit;
  const interrupted = Readable.from((async function* () { yield Buffer.from("part"); throw new Error("Interrupted fixture"); })());
  await assert.rejects(createAttachmentService(f.owner.context).create(db, metadata, interrupted), /Interrupted/);
  const storageRoot = process.env.TW_ATTACHMENT_STORAGE_DIR!;
  const badRoot = join(dir, "unavailable"); await writeFile(badRoot, "not a directory");
  process.env.TW_ATTACHMENT_STORAGE_DIR = badRoot;
  assert.equal((await api("/attachments", "POST", metadata, original)).status, 503);
  process.env.TW_ATTACHMENT_STORAGE_DIR = storageRoot;
  // A test-only database constraint fails publication after bytes have been received.
  await db.execute(sql`ALTER TABLE documents ADD CONSTRAINT fixture_publication_failure CHECK (title <> 'Reject publication')`);
  assert.equal((await api("/attachments", "POST", { ...metadata, title: "Reject publication" }, original)).status, 503);
  await db.execute(sql`ALTER TABLE documents DROP CONSTRAINT fixture_publication_failure`);
  assert.equal((await db.select().from(documents)).length, count);
  assert.equal((await readdir(storageRoot, { recursive: true })).filter(name => name.endsWith(".tmp")).length, 0);
  const existingFiles = await db.select().from(documentFileVersions);
  const storageFiles = (await readdir(storageRoot, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
  assert.equal(storageFiles.length, existingFiles.length);
  assert.equal((await api(`/${doc.id}`, "PATCH", { content: "Do not index", expectedVersion: 4 })).status, 400);

  const deletedFiles = await db.select().from(documentFileVersions).where(eq(documentFileVersions.documentId, htmlDoc.id));
  assert.equal((await api(`/${htmlDoc.id}`, "DELETE")).status, 200);
  assert.equal((await api(`/${htmlDoc.id}/file`)).status, 404);
  for (const file of deletedFiles) await assert.rejects(readFile(join(storageRoot, file.objectKey)));
  assert.equal((await db.select().from(documentFileGarbage)).length, 0);
  const key = await f.identity.issueKey(f.owner.headers, f.owner.account.actorId, { name: "CLI attachment fixture", expiresAt: null, grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read", "resource.write"] }, { scope: "personal", actorId: f.owner.account.actorId, permissions: ["resource.read", "resource.write"] }] });
  const server = serve({ fetch: f.app.fetch, hostname: "127.0.0.1", port: 0 });
  t.after(async () => { if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const source = join(dir, "cli.txt"), destination = join(dir, "download.txt"); await writeFile(source, original);
  const cli = async (...args: string[]) => {
    const result = await promisify(execFile)("pnpm", ["exec", "tsx", "src/index.ts", "doc", ...args, "--json"], { cwd: resolve("../cli"), env: { ...process.env, TW_CONFIG_DIR: join(dir, "cli-config"), TW_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, TW_API_KEY: key.rawKey }, timeout: 20_000 });
    return JSON.parse(result.stdout);
  };
  const uploaded = await cli("upload", source, "--project", f.project.id, "--mime-type", "text/plain"); assert.equal(uploaded.form, "attachment");
  await cli("download", uploaded.id, "--output", destination); assert.deepEqual(await readFile(destination), original);
  await assert.rejects(cli("download", uploaded.id, "--output", destination)); assert.deepEqual(await readFile(destination), original);
  const cliEdited = await cli("update", uploaded.id, "--summary", "CLI metadata edit", "--tags", "cli,metadata", "--expected-version", String(uploaded.version));
  assert.equal((await cli("files", uploaded.id)).length, 1);
  await writeFile(source, replacement);
  await cli("replace-file", uploaded.id, source, "--expected-version", String(cliEdited.version), "--mime-type", "text/plain");
  const historical = join(dir, "historical.txt"); await cli("download", uploaded.id, "--file-version", "1", "--output", historical); assert.deepEqual(await readFile(historical), original);
  assert.equal((await cli("files", uploaded.id)).length, 2);
  const personal = await cli("upload", source); assert.equal(personal.projectId, null); assert.equal(personal.personalOwnerId, f.owner.account.actorId);
  assert.equal((await api(`/${personal.id}/file`, "GET", undefined, undefined, f.outsider.headers)).status, 404);
  const services = createResourceServices(f.owner.context);
  const actor = { id: f.owner.account.actorId, type: "human" as const };
  const requirement = await services.requirementService.createRequirement(db, createRequirementSchema.parse({ projectId: f.project.id, title: "Attachment links" }), actor);
  const task = await services.taskService.createTask(db, createTaskSchema.parse({ projectId: f.project.id, requirementId: requirement.id, title: "Linked task" }), actor);
  const markdown = await services.documentService.createDocument(db, { projectId: f.project.id, title: "Markdown regression", content: "Searchable markdown body" }, actor);
  await services.documentService.linkDocumentToTask(db, doc.id, task.id, "references", actor);
  await services.requirementService.linkDocumentToRequirement(db, requirement.id, doc.id, "references", actor);
  await services.documentService.linkDocuments(db, doc.id, markdown.id, "reference", actor);
  const detail = await services.documentService.getDocumentDetail(db, doc.id);
  assert.equal(detail.taskLinks.length, 1); assert.equal(detail.requirementLinks.length, 1); assert.equal(detail.outgoingLinks.length, 1);
  const search = (query: string, mode: "keyword" | "fulltext" = "keyword") => services.documentService.searchDocuments(db, { query, mode, projectId: f.project.id, includeGlobal: false, includePersonal: false, limit: 20, keywordWeight: 0.3, fulltextWeight: 0.7 });
  for (const query of ["Edited", "Supplemental", "fixture"]) assert.ok((await search(query)).some(row => row.id === doc.id));
  assert.ok((await search("Supplemental", "fulltext")).some(row => row.id === doc.id));
  assert.equal((await search("Original bytes")).length, 0);
  assert.ok((await search("Searchable markdown body")).some(row => row.id === markdown.id));
  const [profile] = await db.insert(embeddingProfiles).values({ name: "Attachment exclusion", scope: "project", projectId: f.project.id, status: "enabled", provider: "openai_compatible", baseUrl: "http://127.0.0.1:1", model: "fixture", dimensions: 3, secretRef: "env:FIXTURE", configurationHash: "fixture", createdBy: actor.id, createdByType: actor.type, updatedBy: actor.id, updatedByType: actor.type }).returning();
  const previewCoverage = await services.embeddingService.previewEmbeddingRebuild(db, profile!.id);
  assert.equal(previewCoverage.totalDocuments, 1);
  const fresh = (await db.select().from(documents).where(eq(documents.id, doc.id)))[0]!;
  await services.documentService.updateDocument(db, doc.id, { summary: "Metadata only", expectedVersion: fresh.version }, actor);
  assert.equal((await db.select().from(embeddingJobItems)).length, 0);
  if (process.env.TW_ATTACHMENTS_WEB_TEST === "1") {
    const reservation = createServer(); await new Promise<void>(r => reservation.listen(0, "127.0.0.1", r));
    const webPort = (reservation.address() as { port: number }).port; await new Promise<void>(r => reservation.close(() => r()));
    const web = spawn(process.execPath, [resolve("../web/node_modules/next/dist/bin/next"), "start", "-p", String(webPort)], { cwd: resolve("../web"), stdio: "ignore", env: { ...process.env, DATABASE_URL: databaseUrl!, TW_AUTH_SECRET: f.configuration.secret, TW_AUTH_BASE_URL: f.configuration.baseURL, TW_AUTH_TRUSTED_ORIGINS: f.configuration.trustedOrigins.join(",") } });
    t.after(() => web.kill("SIGTERM"));
    const base = `http://127.0.0.1:${webPort}`;
    let ready = false;
    for (let n = 0; n < 100; n++) { try { ready = (await fetch(`${base}/api/auth/csrf`)).ok; } catch {} if (ready) break; await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, "Built Web server must start");
    const wh = new Headers(f.owner.headers); wh.set("x-tw-attachment-metadata", encodeURIComponent(JSON.stringify(metadata)));
    const upload = await fetch(`${base}/api/attachments`, { method: "POST", headers: wh, body: original }); assert.equal(upload.status, 201, await upload.clone().text());
    const webDoc: any = await upload.json();
    const webGet = await fetch(`${base}/api/attachments/${webDoc.id}`, { headers: f.owner.headers }); assert.deepEqual(Buffer.from(await webGet.arrayBuffer()), original);
    assert.equal((await fetch(`${base}/api/attachments/${webDoc.id}/files`, { headers: f.owner.headers })).status, 200);
    assert.equal((await fetch(`${base}/api/attachments/${webDoc.id}`, { headers: f.outsider.headers })).status, 404);
    assert.equal((await fetch(`${base}/api/attachments/${webDoc.id}`)).status, 401);
    const noCsrf = new Headers(wh); noCsrf.delete("x-csrf-token");
    assert.equal((await fetch(`${base}/api/attachments`, { method: "POST", headers: noCsrf, body: original })).status, 403);
    wh.set("origin", "https://untrusted.example"); assert.equal((await fetch(`${base}/api/attachments`, { method: "POST", headers: wh, body: original })).status, 403);
    web.kill("SIGTERM");
  }
  if (process.env.TW_ATTACHMENTS_API_TEST_IMAGE) {
    const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const image = process.env.TW_ATTACHMENTS_API_TEST_IMAGE, databaseContainer = process.env.TW_ATTACHMENTS_DB_CONTAINER!;
    const runtimePaths: Record<string, string> = JSON.parse(docker("run", "--rm", "--entrypoint", "node", image, "-e", "const fs=require('fs');console.log(JSON.stringify(Object.fromEntries(['core','contracts','db','realtime'].map(p=>[p,fs.realpathSync('node_modules/@task-weaver/'+p)]))))"));
    const container = `tw-attachment-api-${Date.now()}`;
    t.after(() => { try { docker("rm", "-f", container); } catch {} });
    const start = async (root: string, connection: string) => {
      const args = ["run", "--rm", "-d", "--name", container, "--user", "0", "--link", `${databaseContainer}:fixture-db`, "-p", "127.0.0.1::3001", "-e", `DATABASE_URL=${connection}`, "-e", `TW_AUTH_SECRET=${f.configuration.secret}`, "-e", `TW_AUTH_BASE_URL=${f.configuration.baseURL}`, "-e", `TW_AUTH_TRUSTED_ORIGINS=${f.configuration.trustedOrigins.join(",")}`, "-e", "TW_PRESET_SKILLS_SYNC=disabled", "-e", "TW_ATTACHMENT_STORAGE_DIR=/attachment-data", "--mount", `type=bind,source=${root},target=/attachment-data`, "--mount", `type=bind,source=${resolve("src")},target=/app/src,readonly`];
      for (const [pkg, target] of Object.entries(runtimePaths)) args.push("--mount", `type=bind,source=${resolve(`../../packages/${pkg}/src`)},target=${target}/src,readonly`);
      args.push("--mount", `type=bind,source=${resolve("../../packages/db/drizzle")},target=${runtimePaths.db}/drizzle,readonly`, image);
      docker(...args);
      const port = JSON.parse(docker("inspect", container))[0].NetworkSettings.Ports["3001/tcp"][0].HostPort;
      const base = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let n = 0; n < 100; n++) { try { ready = (await fetch(`${base}/health`)).ok; } catch {} if (ready) break; await new Promise(r => setTimeout(r, 100)); }
      assert.ok(ready, "Isolated API container must start"); return base;
    };
    const connection = "postgres://fixture:fixture-only@fixture-db:5432/tw_attachments_e2e";
    for (let n = 0; n < 2; n++) {
      const base = await start(storageRoot, connection);
      const restoredFile = await fetch(`${base}/api/v1/documents/${doc.id}/file?fileVersion=1`, { headers: f.owner.headers });
      assert.equal(restoredFile.status, 200); assert.deepEqual(Buffer.from(await restoredFile.arrayBuffer()), original);
      docker("rm", "-f", container);
    }
    // No writes run between this database dump and the matching file snapshot.
    const dump = docker("exec", databaseContainer, "pg_dump", "-U", "fixture", "-d", "tw_attachments_e2e", "--no-owner", "--no-acl");
    const backup = join(dir, "backup.sql"); await writeFile(backup, dump);
    const restoredRoot = join(dir, "restored-storage"); await cp(storageRoot, restoredRoot, { recursive: true });
    docker("exec", databaseContainer, "createdb", "-U", "fixture", "tw_attachments_restored");
    docker("cp", backup, `${databaseContainer}:/tmp/attachments-backup.sql`);
    docker("exec", databaseContainer, "psql", "-U", "fixture", "-d", "tw_attachments_restored", "-v", "ON_ERROR_STOP=1", "-f", "/tmp/attachments-backup.sql");
    const base = await start(restoredRoot, connection.replace("tw_attachments_e2e", "tw_attachments_restored"));
    for (const version of [1, 2, 3]) {
      const response = await fetch(`${base}/api/v1/documents/${doc.id}/file?fileVersion=${version}`, { headers: f.owner.headers }); assert.equal(response.status, 200);
      const expected = await api(`/${doc.id}/file?fileVersion=${version}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(await expected.arrayBuffer()));
    }
    docker("rm", "-f", container);
  }
  assert.ok((await db.select().from(documents)).filter(d => d.form === "attachment").every(d => d.content === ""));
});
