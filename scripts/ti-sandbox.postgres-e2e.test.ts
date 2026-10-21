import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createPartnersMcpAdapter, type PartnersMcpCall } from "../packages/core/src/services/partners-mcp";
import { createTiSandboxService } from "../packages/core/src/services/ti-sandboxes";
import { createTiSandboxCleanup } from "../packages/core/src/services/ti-sandbox-cleanup";
import type { TiSandboxScope } from "../packages/core/src/services/ti-sandbox-authorization";
const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { createDb, runMigrations, tiSandboxWorkspaces: w, tiSandboxOperations: o, assistantConversations } = require("./src/index.ts");
const { eq } = require("drizzle-orm");
const url = process.env.TW_TI_SANDBOX_E2E_DATABASE_URL;

test("durable sandbox ownership, uncertain submission, cleanup retry and isolation", { skip: !url, timeout: 60_000 }, async t => {
  assert.equal(new URL(url!).hostname, "127.0.0.1");
  assert.equal(new URL(url!).pathname, "/tw_ti_e2e");
  await runMigrations(url!);
  const db = createDb(url!);
  t.after(() => db.$client.end());
  const projectId = randomUUID();
  const scope = (ownerId = randomUUID(), conversationId = randomUUID()): TiSandboxScope => ({ ownerId, ownerType: "human", projectId, conversationId, runId: null, attempt: 1 });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const jobs = new Map<string, { sessionId: string; state: string }>();
  const sessions = new Map<string, string>();
  let loseSubmit = false, failDelete = false;
  const call: PartnersMcpCall = async (name, args) => {
    calls.push({ name, args });
    let output: unknown;
    if (name === "session_create") {
      const requestId = String(args.requestId);
      const sessionId = sessions.get(requestId) ?? `session-${randomUUID()}`;
      sessions.set(requestId, sessionId);
      output = { sessionId, state: "active", expiresAt: Date.now() + 1800_000, quarantined: false, capabilities: { bash_exec: true, file_ops: true }, limits: {} };
    } else if (name === "bash_exec") {
      const jobId = `job-${randomUUID()}`;
      jobs.set(jobId, { sessionId: String(args.sessionId), state: "running" });
      if (loseSubmit) { loseSubmit = false; throw new Error("Lost response"); }
      output = { jobId, sessionId: args.sessionId, state: "accepted" };
    } else if (name === "job_get" || name === "job_cancel") {
      const job = jobs.get(String(args.jobId)); assert.ok(job);
      if (name === "job_cancel") job.state = "cancelled";
      output = { jobId: args.jobId, ...job, exitCode: null, terminalReason: null, outputTruncated: false,
        ...(name === "job_get" ? { stdout: "", stderr: "", nextCursor: "0:0", truncated: false, artifactRefs: [] } : {}) };
    } else if (name === "session_delete") {
      if (failDelete) { failDelete = false; throw new Error("Provider unavailable"); }
      if ([...jobs.values()].some(job => job.sessionId === args.sessionId && job.state === "running")) return { isError: true, structuredContent: { code: "SESSION_BUSY", retryable: true } };
      output = { sessionId: args.sessionId, state: "deleted", expiresAt: null, quarantined: false, capabilities: { bash_exec: true, file_ops: true }, limits: {} };
    }
    return { structuredContent: output };
  };
  const binding = { id: randomUUID(), tenantId: "tenant", projectId: "provider-project", adapter: createPartnersMcpAdapter(call) };
  const aScope = scope(), bScope = scope();
  const a = createTiSandboxService(db, async () => aScope, binding);
  const b = createTiSandboxService(db, async () => bScope, binding);
  await a.execute("command", { command: "true" });
  await b.execute("command", { command: "true" });
  const rows = await db.query.tiSandboxWorkspaces.findMany();
  const aRow = rows.find((r: any) => r.ownerId === aScope.ownerId)!;
  const bRow = rows.find((r: any) => r.ownerId === bScope.ownerId)!;
  assert.notEqual(aRow.sessionId, bRow.sessionId);
  const aOp = await db.query.tiSandboxOperations.findFirst({ where: eq(o.workspaceId, aRow.id) });
  const bOp = await db.query.tiSandboxOperations.findFirst({ where: eq(o.workspaceId, bRow.id) });
  const before = calls.length;
  await assert.rejects(a.getJob(bOp!.id));
  assert.equal(calls.length, before);
  await a.getJob("command");
  assert.equal(calls.at(-1)!.args.jobId, aOp!.jobId);
  await a.requestCleanup(true);
  failDelete = true;
  const cleaner = createTiSandboxCleanup(db, async id => { assert.equal(id, binding.id); return binding; });
  await cleaner.runOnce();
  const debt = await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.id, aRow.id) });
  assert.equal(debt!.state, "cleanup_pending");
  assert.equal(jobs.get(aOp!.jobId)!.state, "cancelled");
  assert.equal(jobs.get(bOp!.jobId)!.state, "running");
  await db.update(w).set({ nextCleanupAt: new Date(0) }).where(eq(w.id, aRow.id));
  // A fresh cleaner simulates process restart; it uses persisted cancellation and cleanup intent.
  await createTiSandboxCleanup(db, async () => binding).runOnce();
  assert.equal((await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.id, aRow.id) }))!.state, "deleted");
  assert.equal((await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.id, bRow.id) }))!.state, "active");
  const uncertainScope = scope();
  const uncertain = createTiSandboxService(db, async () => uncertainScope, binding);
  loseSubmit = true;
  await assert.rejects(uncertain.execute("lost", { command: "echo once" }));
  const submits = calls.filter(c => c.name === "bash_exec").length;
  await assert.rejects(uncertain.execute("lost", { command: "echo once" }));
  assert.equal(calls.filter(c => c.name === "bash_exec").length, submits);
  await uncertain.requestCleanup(true);
  await cleaner.runOnce();
  assert.equal(calls.filter(c => c.name === "bash_exec").length, submits, "Cleanup must not start an uncertain command");
  await db.insert(assistantConversations).values({ id: bScope.conversationId!, projectId: null, createdBy: bScope.ownerId, createdByType: bScope.ownerType });
  const [orphan] = await db.insert(w).values({ ownerId: randomUUID(), ownerType: "human", runId: randomUUID(), attempt: 1,
    bindingId: binding.id, tenantId: binding.tenantId, providerProjectId: binding.projectId, sessionId: `orphan-${randomUUID()}`, state: "active", expiresAt: new Date(Date.now() + 1800_000) }).returning();
  await cleaner.reconcileOrphans();
  assert.equal((await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.id, orphan.id) }))!.state, "cleanup_pending");
  await cleaner.runOnce();
  assert.equal((await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.id, orphan.id) }))!.state, "deleted");
  assert.equal((await db.query.tiSandboxWorkspaces.findFirst({ where: eq(w.id, bRow.id) }))!.state, "active");
  assert.ok(!calls.some(call => call.name.includes("list")), "No provider-wide resource sweep");
  assert.ok((await cleaner.metrics()).length > 0);
});
