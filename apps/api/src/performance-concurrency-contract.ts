import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { mock } from "node:test";
import { eq, sql } from "drizzle-orm";
import { createDb, runMigrations, authInstanceState, requirements, tasks, documents, documentTaskLinks, measureDatabaseWork } from "@task-weaver/db";
import { createAuthenticationService, createIdentityManagementService, createResourceServices } from "@task-weaver/core";
import { AuthenticationError, AuthorizationError, NotFoundError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { resourcePostgresFixture } from "./resource-postgres-fixture";

const databaseUrl = process.env.TW_PERFORMANCE_DATABASE_URL!;
const url = new URL(databaseUrl);
assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/tw_performance");
const files = ["apps/api/src/performance-concurrency-contract.ts", "apps/api/src/resource-postgres-fixture.ts",
  "scripts/performance-local-postgres.mjs", "packages/core/src/services/auth-security.ts",
  "packages/core/src/services/resource-services.ts", "packages/core/src/services/api-keys.ts",
  "packages/core/src/services/identity-management.ts", "packages/core/src/services/authentication.ts"];
const sourceHash = () => {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(readFileSync(file));
  return hash.digest("hex");
};
const source = { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()), implementationSha256: sourceHash() };
const db = createDb(databaseUrl, { maxConnections: 1, measureQueries: true });
const reader = createDb(databaseUrl, { maxConnections: 1, measureQueries: true });
const writer = createDb(databaseUrl, { maxConnections: 1, measureQueries: true });
const observer = createDb(databaseUrl, { maxConnections: 1 });
type Outcome = { ok: true; value: unknown } | { ok: false; error: "authentication" | "authorization" | "not_found" | "unexpected" };
const cases: Array<Record<string, unknown>> = [];
let currentCase = "preflight";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const observe = (work: () => Promise<unknown>) => measureDatabaseWork<Outcome>(async () => {
  try { return { ok: true, value: await work() }; }
  catch (error) { return { ok: false, error: error instanceof AuthenticationError ? "authentication"
    : error instanceof AuthorizationError ? "authorization" : error instanceof NotFoundError ? "not_found" : "unexpected" }; }
});
try {
  console.log("TW_PERFORMANCE_STAGE preflight");
  const inventory = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    and c.relkind in ('r','p','v','m','S','f')`);
  assert.equal(inventory[0]?.count, 0, "Concurrency fixture requires an empty database");
  await runMigrations(databaseUrl);
  console.log("TW_PERFORMANCE_STAGE fixture");
  const f = await resourcePostgresFixture(db, databaseUrl);
  const writerAuth = createAuthenticationService(writer, f.configuration);
  const policy = createIdentityManagementService(writer, writerAuth);
  const member = await f.createHuman();
  await f.identity.setMembership(f.owner.headers, f.project.id, member.context.actor.id, { role: "viewer" });
  const other = await f.identity.createProject(f.outsider.headers, { name: "Other synthetic project" });
  await f.identity.setMembership(f.outsider.headers, other.id, f.owner.context.actor.id, { role: "member" });
  const requirementId = randomUUID(), taskId = randomUUID(), documentId = randomUUID();
  // Direct writes are fixture setup only, after the empty disposable-database check.
  await db.insert(requirements).values({ id: requirementId, projectId: f.project.id, title: "Synthetic requirement", createdBy: f.owner.context.actor.id });
  await db.insert(tasks).values({ id: taskId, projectId: f.project.id, requirementId, title: "Synthetic task", createdBy: f.owner.context.actor.id });
  await db.insert(documents).values({ id: documentId, projectId: f.project.id, title: "Synthetic document", content: "Synthetic private fixture body", createdBy: f.owner.context.actor.id });
  await db.insert(documentTaskLinks).values({ documentId, taskId, linkType: "references" });
  const pid = async (connection: typeof db) => {
    const rows = await connection.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`);
    assert.ok(rows[0]?.pid); return rows[0]!.pid;
  };
  const gatePid = await pid(db), readPid = await pid(reader), writePid = await pid(writer);
  const list = (context: VerifiedRequestContext, connection = reader, projectId = f.project.id) =>
    createResourceServices(context).requirementService.listRequirements(connection, { projectId, view: "summary" });
  async function blocked(target: number, allowedBlockers: number[]) {
    const started = performance.now();
    while (performance.now() - started < 2000) {
      const rows = await observer.execute<{ blockers: number[]; event: string | null }>(sql`
        select pg_blocking_pids(pid) as blockers,wait_event_type as event from pg_stat_activity where pid=${target}`);
      const row = rows[0];
      if (row?.event === "Lock" && row.blockers.some(value => allowedBlockers.includes(value)))
        return { observedBlockers: row.blockers.length,
          predecessorObserved: allowedBlockers.length > 1 && row.blockers.includes(allowedBlockers[1]!),
          observationMs: performance.now() - started };
      await delay(5);
    }
    throw new Error("Expected causal lock barrier was not observed");
  }
  async function ordered(name: string, firstPid: number, first: () => Promise<unknown>, secondPid: number,
    second: () => Promise<unknown>, beforeRelease?: () => void) {
    currentCase = name;
    const held = deferred<void>(), release = deferred<void>();
    const operations: Array<ReturnType<typeof observe>> = [];
    const gate = db.transaction(async tx => {
      await tx.select().from(authInstanceState).where(eq(authInstanceState.id, "instance")).for("update");
      held.resolve(); await release.promise;
    });
    void gate.catch(held.reject);
    const barriers = [];
    try {
      await held.promise;
      operations.push(observe(first)); barriers.push(await blocked(firstPid, [gatePid]));
      operations.push(observe(second)); barriers.push(await blocked(secondPid, [gatePid, firstPid]));
      assert.equal(barriers[1]!.predecessorObserved, true, "Second participant did not queue behind its predecessor");
      beforeRelease?.();
    } finally { release.resolve(); await gate; await Promise.all(operations); }
    const results = await Promise.all(operations);
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.value.ok || result.value.error !== "unexpected"), "Unexpected operation failure");
    cases.push({ name, barriers, outcomes: results.map(result => result.value.ok ? "allowed" : result.value.error),
      measurements: results.map(result => result.measurement) });
    return results.map(result => result.value) as [Outcome, Outcome];
  }
  const denied = (outcome: Outcome) => assert.equal(outcome.ok, false, "Revoked or expired authority returned data");
  const allowed = (outcome: Outcome) => assert.equal(outcome.ok, true, "Authorized operation failed");
  for (const order of ["read-first", "revoke-first"] as const) {
    await f.identity.setMembership(f.owner.headers, f.project.id, member.context.actor.id, { role: "viewer" });
    const read = () => list(member.context), revoke = () => policy.removeMembership(f.owner.headers, f.project.id, member.context.actor.id);
    const [first, second] = order === "read-first"
      ? await ordered(`membership.${order}`, readPid, read, writePid, revoke)
      : await ordered(`membership.${order}`, writePid, revoke, readPid, read);
    allowed(first); if (order === "read-first") allowed(second); else denied(second);
    denied((await observe(read)).value);
    cases.at(-1)!.staleContextDeniedAfterCommit = true;
  }
  await f.identity.setMembership(f.owner.headers, f.project.id, member.context.actor.id, { role: "viewer" });
  for (const order of ["read-first", "revoke-first"] as const) {
    const key = await f.identity.issueKey(f.owner.headers, f.owner.context.actor.id, { name: "Synthetic race key",
      grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read"] }], expiresAt: null });
    const context = await f.auth.resolve(new Headers({ authorization: `Bearer ${key.rawKey}` }));
    const read = () => list(context), revoke = () => policy.revokeKey(f.owner.headers, f.owner.context.actor.id, key.id);
    const [first, second] = order === "read-first"
      ? await ordered(`key.${order}`, readPid, read, writePid, revoke)
      : await ordered(`key.${order}`, writePid, revoke, readPid, read);
    allowed(first); if (order === "read-first") allowed(second); else denied(second);
    denied((await observe(read)).value);
    cases.at(-1)!.staleContextDeniedAfterCommit = true;
  }
  for (const order of ["read-first", "revoke-first"] as const) {
    const subject = await f.createHuman();
    await f.identity.setMembership(f.owner.headers, f.project.id, subject.context.actor.id, { role: "viewer" });
    const read = () => list(subject.context), revoke = () => writerAuth.revokeSession(subject.headers, subject.context.credential.id);
    const [first, second] = order === "read-first"
      ? await ordered(`session.${order}`, readPid, read, writePid, revoke)
      : await ordered(`session.${order}`, writePid, revoke, readPid, read);
    allowed(first); if (order === "read-first") allowed(second); else denied(second);
    denied((await observe(read)).value);
    cases.at(-1)!.staleContextDeniedAfterCommit = true;
  }
  // Logout is an unguarded monotonic invalidation, unlike explicit revokeSession.
  currentCase = "logout.monotonic-invalidation";
  const loggingOut = await f.createHuman();
  await f.identity.setMembership(f.owner.headers, f.project.id, loggingOut.context.actor.id, { role: "viewer" });
  const logoutHeld = deferred<void>(), logoutRelease = deferred<void>();
  const logoutGate = db.transaction(async tx => {
    await tx.select().from(authInstanceState).where(eq(authInstanceState.id, "instance")).for("update");
    logoutHeld.resolve(); await logoutRelease.promise;
  });
  void logoutGate.catch(logoutHeld.reject);
  let queuedLogoutRead: ReturnType<typeof observe> | undefined;
  try {
    await logoutHeld.promise;
    const loggedOut = await observe(() => writerAuth.logout(loggingOut.headers));
    allowed(loggedOut.value);
    assert.equal(loggedOut.measurement.phases.identityLock.count, 0);
    queuedLogoutRead = observe(() => list(loggingOut.context));
    const barrier = await blocked(readPid, [gatePid]);
    cases.push({ name: currentCase, completedWhileGateHeld: true, barrier,
      logoutMeasurement: loggedOut.measurement });
  } finally { logoutRelease.resolve(); await logoutGate; if (queuedLogoutRead) await queuedLogoutRead; }
  assert.ok(queuedLogoutRead); denied((await queuedLogoutRead).value);
  cases.at(-1)!.staleContextDeniedAfterLogout = true;
  const ownerActor = { id: f.owner.context.actor.id, type: f.owner.context.actor.type };
  const containsDocument = (outcome: Outcome) => outcome.ok && Boolean((outcome.value as { documentLinks: unknown[] }).documentLinks.length);
  for (const order of ["read-first", "move-first"] as const) {
    await createResourceServices(f.owner.context).documentService.updateDocument(db, documentId, { projectId: f.project.id }, ownerActor);
    const read = () => createResourceServices(member.context).taskService.getTaskDetail(reader, taskId);
    const move = () => createResourceServices(f.owner.context).documentService.updateDocument(writer, documentId, { projectId: other.id }, ownerActor);
    const [first, second] = order === "read-first"
      ? await ordered(`nested.${order}`, readPid, read, writePid, move)
      : await ordered(`nested.${order}`, writePid, move, readPid, read);
    allowed(first); allowed(second);
    assert.equal(containsDocument(order === "read-first" ? first : second), order === "read-first");
    assert.equal(containsDocument((await observe(read)).value), false);
    cases.at(-1)!.movedNestedRelationHiddenAfterCommit = true;
  }
  const [crossFirst, crossSecond] = await ordered("cross-project.read-serialization", readPid,
    () => list(f.owner.context), writePid, () => list(f.outsider.context, writer, other.id));
  allowed(crossFirst); allowed(crossSecond);
  const expiry = Date.now() + 60_000;
  const key = await f.identity.issueKey(f.owner.headers, f.owner.context.actor.id, { name: "Synthetic expiry key",
    grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read"] }], expiresAt: new Date(expiry).toISOString() });
  const expiring = await f.auth.resolve(new Headers({ authorization: `Bearer ${key.rawKey}` }));
  try {
    const [expired, unaffected] = await ordered("expiry.queued-before-validation", readPid, () => list(expiring), writePid,
      () => list(f.owner.context, writer), () => mock.timers.enable({ apis: ["Date"], now: expiry + 1 }));
    denied(expired); allowed(unaffected);
  } finally { mock.timers.reset(); }
  await policy.revokeKey(f.owner.headers, f.owner.context.actor.id, key.id);
  currentCase = "pool.authentication-outside-transaction";
  const authenticationEntered = deferred<void>(), continueAuthentication = deferred<void>();
  let transactionActive = false, authenticationInsideTransaction = false;
  const transaction = reader.transaction.bind(reader);
  const instrumented = new Proxy(reader, { get(target, property, receiver) {
    if (property !== "transaction") return Reflect.get(target, property, receiver);
    return (work: Parameters<typeof transaction>[0]) => transaction(async tx => {
      transactionActive = true;
      try { return await work(tx); } finally { transactionActive = false; }
    });
  } });
  const readerAuth = createAuthenticationService(reader, f.configuration);
  const admissionAuth = { ...readerAuth, resolve: async (headers: Headers) => {
    authenticationInsideTransaction = transactionActive;
    authenticationEntered.resolve(); await continueAuthentication.promise;
    // Abort an observed self-dependency before submitting the query that would wait for its own pool.
    if (authenticationInsideTransaction) throw new Error("Controlled single-pool reentry rejection");
    return readerAuth.resolve(headers);
  } };
  const admissionPolicy = createIdentityManagementService(instrumented, admissionAuth);
  const admission = observe(() => admissionPolicy.listAssignees(f.owner.headers, f.project.id));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let backendIdleInTransaction = false;
  try {
    await Promise.race([authenticationEntered.promise, admission.then(() => { throw new Error("Authentication admission was not observed"); }),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Authentication admission deadline")), 2000); })]);
    const state = await observer.execute<{ inside: boolean }>(sql`select state='idle in transaction' as inside from pg_stat_activity where pid=${readPid}`);
    backendIdleInTransaction = state[0]?.inside ?? false;
  } finally { clearTimeout(deadline); continueAuthentication.resolve(); await admission; }
  const admitted = (await admission).value;
  cases.push({ name: currentCase, authenticationInsideTransaction, backendIdleInTransaction,
    controlledAbort: authenticationInsideTransaction, completed: admitted.ok, poolMax: 1 });
  assert.equal(authenticationInsideTransaction, false, "Authentication reused a fully reserved transaction pool");
  assert.equal(backendIdleInTransaction, false);
  allowed(admitted);
  assert.ok(admitted.ok);
  assert.deepEqual((admitted.value as Array<{ id: string }>).map(actor => actor.id), [f.owner.context.actor.id]);
  const assignees = createIdentityManagementService(reader, readerAuth);
  const [membershipWrite, membershipRead] = await ordered("assignees.membership-revoke-first", writePid,
    () => policy.removeMembership(f.owner.headers, f.project.id, member.context.actor.id), readPid,
    () => assignees.listAssignees(member.headers, f.project.id));
  allowed(membershipWrite); denied(membershipRead);
  await f.identity.setMembership(f.owner.headers, f.project.id, member.context.actor.id, { role: "viewer" });
  const assigneeKey = await f.identity.issueKey(f.owner.headers, f.owner.context.actor.id, { name: "Synthetic assignee key",
    grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read"] }], expiresAt: null });
  const assigneeKeyHeaders = new Headers({ authorization: `Bearer ${assigneeKey.rawKey}` });
  const [keyWrite, keyRead] = await ordered("assignees.key-revoke-first", writePid,
    () => policy.revokeKey(f.owner.headers, f.owner.context.actor.id, assigneeKey.id), readPid,
    () => assignees.listAssignees(assigneeKeyHeaders, f.project.id));
  allowed(keyWrite); denied(keyRead);
  const assigneeSubject = await f.createHuman();
  await f.identity.setMembership(f.owner.headers, f.project.id, assigneeSubject.context.actor.id, { role: "viewer" });
  const [sessionWrite, sessionRead] = await ordered("assignees.session-revoke-first", writePid,
    () => writerAuth.revokeSession(assigneeSubject.headers, assigneeSubject.context.credential.id), readPid,
    () => assignees.listAssignees(assigneeSubject.headers, f.project.id));
  allowed(sessionWrite); denied(sessionRead);
  const assigneeExpiry = Date.now() + 60_000;
  const expiringAssigneeKey = await f.identity.issueKey(f.owner.headers, f.owner.context.actor.id, { name: "Synthetic assignee expiry key",
    grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read"] }], expiresAt: new Date(assigneeExpiry).toISOString() });
  try {
    const [expiredRead, unaffectedRead] = await ordered("assignees.expiry-while-queued", readPid,
      () => assignees.listAssignees(new Headers({ authorization: `Bearer ${expiringAssigneeKey.rawKey}` }), f.project.id),
      writePid, () => list(f.owner.context, writer), () => mock.timers.enable({ apis: ["Date"], now: assigneeExpiry + 1 }));
    denied(expiredRead); allowed(unaffectedRead);
  } finally { mock.timers.reset(); }
  await policy.revokeKey(f.owner.headers, f.owner.context.actor.id, expiringAssigneeKey.id);
  currentCase = "assignees.personal-scope";
  const personalAssignees = await observe(() => assignees.listAssignees(f.owner.headers));
  allowed(personalAssignees.value);
  assert.ok(personalAssignees.value.ok);
  assert.deepEqual((personalAssignees.value.value as Array<{ id: string }>).map(actor => actor.id), [f.owner.context.actor.id]);
  cases.push({ name: currentCase, outcome: "allowed", measurement: personalAssignees.measurement });
  currentCase = "assignees.credential-ceiling";
  const scopedKey = await f.identity.issueKey(f.owner.headers, f.owner.context.actor.id, { name: "Synthetic scope key",
    grants: [{ scope: "project", projectId: f.project.id, permissions: ["resource.read"] }], expiresAt: null });
  const scopedHeaders = new Headers({ authorization: `Bearer ${scopedKey.rawKey}` });
  const personalDenied = await observe(() => assignees.listAssignees(scopedHeaders));
  const otherDenied = await observe(() => assignees.listAssignees(scopedHeaders, other.id));
  denied(personalDenied.value); denied(otherDenied.value);
  cases.push({ name: currentCase, personalDenied: true, otherProjectDenied: true });
  await policy.revokeKey(f.owner.headers, f.owner.context.actor.id, scopedKey.id);
  assert.equal(sourceHash(), source.implementationSha256, "Measured source changed during execution");
  console.log("TW_PERFORMANCE_RECEIPT " + JSON.stringify({ source, contract: "Existing exclusive identity lifecycle lock; no production locking change",
    connections: { gate: 1, reader: 1, writer: 1, observer: 1 }, fixture: { projects: 2, requirements: 1, tasks: 1, documents: 1 },
    cases, passed: cases.length, limits: ["Positive observed PostgreSQL lock barriers; polling delays do not assert completion",
      "Lifecycle-query duration includes wait/execution,not independently measured pure lock wait", "Not a throughput,saturation,network-delivery or unbounded writer-fairness claim",
      "One test process with independent connection pools,not a complete multi-process failure/restart test", "Only queued expiry before authority validation is exercised"] }));
} catch {
  console.log("TW_PERFORMANCE_FAILURE unexpected");
  console.log("TW_PERFORMANCE_PARTIAL " + JSON.stringify({ source, currentCase, cases }));
  process.exitCode = 1;
} finally {
  mock.timers.reset();
  await Promise.all([db, reader, writer, observer].map(connection => connection.$client.end({ timeout: 2 })));
}
