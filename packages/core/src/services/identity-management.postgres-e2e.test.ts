import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import {
  createDb,
  runMigrations,
  authInstanceState,
  authSessions,
  authUsers,
  projectMemberships,
  authAuditEvents,
  authActors,
  apiKeys,
  requirements,
  reassessmentGrants,
  workflowOutputs,
  activityLog,
  executionControls, requirementClaims, workflowInputs, documents, documentFileVersions,
} from "@task-weaver/db";
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from "@task-weaver/contracts";
import { createInterruptedReassessmentService } from "./interrupted-reassessment";
import { createReassessmentDecisionService } from "./reassessment-decisions";
import { createReassessmentGrantService, lockReassessmentGrant } from "./reassessment-grants";
import { createAuthenticationService } from "./authentication";
import { createIdentityManagementService } from "./identity-management";
import { getLiveRequestAuthority } from "./api-keys";
import { getPersonalResourceOwner } from "./auth-principals";
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test(
  "identity management enforces ownership, approval boundaries and live credential ceilings",
  { skip: !databaseUrl, timeout: 150_000 },
  async (t) => {
    const url = new URL(databaseUrl!);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/tw_auth_e2e");
    await runMigrations(databaseUrl!);
    const db = createDb(databaseUrl!);
    t.after(() => db.$client.end());
    await db
      .update(authInstanceState)
      .set({ initializedByUserId: null, initializedAt: null });
    const config = {
      secret: "fixture-auth-secret".repeat(3),
      bootstrapSecret: "fixture-bootstrap-secret".repeat(3),
      baseURL: "http://127.0.0.1:3001",
      trustedOrigins: ["http://127.0.0.1:3000"],
    };
    const auth = createAuthenticationService(db, config);
    const identity = createIdentityManagementService(db, auth);
    const password = randomBytes(24).toString("hex");
    const csrfHeaders = () => {
      const challenge = auth.csrfChallenge();
      return new Headers({
        cookie: challenge.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; "),
        origin: config.trustedOrigins[0]!,
        "x-csrf-token": challenge.csrfToken,
      });
    };
    const login = async (email: string) => {
      const headers = csrfHeaders();
      const result = await auth.login(
        headers,
        { email, password },
        randomUUID(),
      );
      headers.set(
        "cookie",
        [
          headers.get("cookie"),
          ...result.headers
            .getSetCookie()
            .map((cookie) => cookie.split(";")[0]),
        ].join("; "),
      );
      return { headers, account: result.account, session: result.session };
    };
    const adminEmail = `${randomUUID()}@example.test`;
    await auth.bootstrap(
      csrfHeaders(),
      {
        email: adminEmail,
        displayName: "Admin",
        password,
        bootstrapSecret: config.bootstrapSecret,
      },
      "identity-bootstrap",
    );
    const admin = await login(adminEmail);
    const human = async () => {
      const email = `${randomUUID()}@example.test`;
      const invited = await auth.provision(admin.headers, {
        email,
        displayName: "Human",
      });
      await auth.activate(
        csrfHeaders(),
        { token: invited.activationToken, password },
        randomUUID(),
      );
      return login(email);
    };
    const owner = await human();
    const member = await human();
    const maintainer = await human();
    const outsider = await human();
    const project = await identity.createProject(owner.headers, {
      name: "Human-owned project",
    });
    await t.test("reassessment grants enforce scope, live management authority and audited concurrent revocation", async () => {
      const agent = await identity.createAgent(owner.headers, { displayName: "Reassessment agent" });
      const grantProject = await identity.createProject(owner.headers, { name: "Grant project" });
      const otherProject = await identity.createProject(outsider.headers, { name: "Other grant project" });
      const [requirement] = await db.insert(requirements).values({ projectId: grantProject.id, title: "Grant scope", createdBy: owner.account.actorId }).returning();
      const [otherRequirement] = await db.insert(requirements).values({ projectId: otherProject.id, title: "Other scope", createdBy: outsider.account.actorId }).returning();
      const service = createReassessmentGrantService(await auth.resolve(owner.headers));
      const outsiderService = createReassessmentGrantService(await auth.resolve(outsider.headers));
      const input = { projectId: grantProject.id, requirementId: requirement!.id, agentId: agent.id, operations: ["revalidate_evidence"] as ["revalidate_evidence"], expiresAt: new Date(Date.now() + 60_000) };
      await assert.rejects(service.create(db, { ...input, requirementId: otherRequirement!.id }), ValidationError);
      await assert.rejects(service.create(db, { ...input, expiresAt: new Date(0) }), ValidationError);
      await assert.rejects(outsiderService.create(db, input), NotFoundError);
      await identity.grantAgentProjectAccess(owner.headers, { actorId: agent.id, projectIds: [grantProject.id] });
      const key = await identity.issueKey(owner.headers, agent.id, { name: "Reassessment key", expiresAt: null, grants: [{ scope: "project", projectId: grantProject.id, permissions: ["resource.read", "resource.write"] }] });
      const agentContext = await auth.resolve(new Headers({ authorization: `Bearer ${key.rawKey}` }));
      const grant = await service.create(db, input);
      const use = () => db.transaction(tx => lockReassessmentGrant(tx, agentContext, { grantId: grant.id, projectId: grantProject.id, requirementId: requirement!.id, operation: "revalidate_evidence" }));
      assert.equal((await use()).id, grant.id);
      const decisions = createReassessmentDecisionService(agentContext);
      const [output] = await db.insert(workflowOutputs).values({ requirementId: requirement!.id, type: "comment", createdBy: agent.id, createdByType: "agent" }).returning();
      const assessment = { grantId: grant.id, projectId: grantProject.id, requirementId: requirement!.id, expectedRevision: 0,
        decision: "accept" as const, evidence: [{ outputId: output!.id, rationale: "Reviewed output" }], rationale: "Evidence remains relevant", inputsAvailable: true, uncertainExternalEffects: false };
      const recorded = await decisions.record(db, assessment);
      assert.equal(recorded.disposition, "accept");
      const [auditRecord] = await db.select().from(activityLog).where(eq(activityLog.id, recorded.id));
      assert.equal(auditRecord?.actorId, agent.id);
      assert.equal(auditRecord?.actorType, "agent");
      assert.equal((auditRecord?.metadata as { planRevision: number }).planRevision, 0);
      assert.equal((await decisions.record(db, { ...assessment, evidence: [{ outputId: randomUUID(), rationale: "Missing" }] })).disposition, "escalate");
      assert.equal((await decisions.record(db, { ...assessment, uncertainExternalEffects: true })).disposition, "escalate");
      await db.update(requirements).set({ planRevision: 1, evidenceNeedsReview: true }).where(eq(requirements.id, requirement!.id));
      await assert.rejects(decisions.record(db, assessment));
      const [unchanged] = await db.select().from(requirements).where(eq(requirements.id, requirement!.id));
      assert.equal(unchanged?.evidenceNeedsReview, true);

      const interrupted = createInterruptedReassessmentService(agentContext);
      const executionGrant = await service.create(db, { ...input, operations: ["assess_interrupted_execution"] });
      const [control] = await db.insert(executionControls).values({ requirementId: requirement!.id, projectId: grantProject.id, daemonId: randomUUID(), runId: randomUUID(), revision: 0, reason: "Plan changed", phase: "stopped", deadline: new Date() }).returning();
      const inputDirectory = await mkdtemp(join(tmpdir(), "tw-assessment-"));
      const oldStorage = process.env.TW_ATTACHMENT_STORAGE_DIR;
      process.env.TW_ATTACHMENT_STORAGE_DIR = inputDirectory;
      t.after(async () => { if (oldStorage === undefined) delete process.env.TW_ATTACHMENT_STORAGE_DIR; else process.env.TW_ATTACHMENT_STORAGE_DIR = oldStorage; await rm(inputDirectory, { recursive: true, force: true }); });
      await writeFile(join(inputDirectory, "assessment"), "a");
      const [doc] = await db.insert(documents).values({ projectId: grantProject.id, form: "attachment", title: "Input", content: "", createdBy: owner.account.actorId }).returning();
      const [file] = await db.insert(documentFileVersions).values({ documentId: doc!.id, version: 1, originalFilename: "a", mimeType: "text/plain", sizeBytes: 1, sha256: createHash("sha256").update("a").digest("hex"), storageBackend: "local", objectKey: "assessment", createdBy: owner.account.actorId, createdByType: "human" }).returning();
      await db.update(documents).set({ currentFileVersionId: file!.id }).where(eq(documents.id, doc!.id));
      const [fileOutput] = await db.insert(workflowOutputs).values({ requirementId: requirement!.id, type: "attachment", referenceId: doc!.id, attachmentFileVersionId: file!.id, createdBy: agent.id, createdByType: "agent" }).returning();
      const [workflowInput] = await db.insert(workflowInputs).values({ requirementId: requirement!.id, outputId: fileOutput!.id, createdBy: owner.account.actorId }).returning();
      await db.update(requirements).set({ leaseGeneration: 1 }).where(eq(requirements.id, requirement!.id));
      await db.insert(requirementClaims).values({ id: control!.runId, requirementId: requirement!.id, daemonId: control!.daemonId, claimedBy: agent.id, claimedByType: "agent", generation: 1, expiresAt: new Date(Date.now() + 60000) });
      const executionAssessment = { grantId: executionGrant.id, projectId: grantProject.id, requirementId: requirement!.id, expectedRevision: 1, controlId: control!.id, expectedControlUpdatedAt: control!.updatedAt.toISOString(), expectedRunId: control!.runId, expectedLeaseGeneration: 1, decision: "accept" as const, inputs: [{ type: "workflow_input" as const, inputId: workflowInput!.id }], notes: "Reviewed local state", uncertainExternalEffects: false, rationale: "Ready for human review" };
      await assert.rejects(interrupted.record(db, { ...executionAssessment, grantId: grant.id }), AuthorizationError);
      await assert.rejects(interrupted.record(db, { ...executionAssessment, expectedRevision: 0 }));
      await assert.rejects(interrupted.record(db, { ...executionAssessment, expectedLeaseGeneration: 2 }));
      await assert.rejects(interrupted.record(db, { ...executionAssessment, expectedRunId: randomUUID() }));
      await assert.rejects(interrupted.record(db, { ...executionAssessment, projectId: otherProject.id }), AuthorizationError);
      assert.equal((await interrupted.record(db, executionAssessment)).disposition, "escalate");
      const verifiedAssessment = await interrupted.record(db, executionAssessment);
      const consume = { grantId: executionGrant.id, projectId: grantProject.id, requirementId: requirement!.id, assessmentId: verifiedAssessment.id };
      const freshForStale = await interrupted.record(db, executionAssessment);
      await db.update(requirementClaims).set({ id: randomUUID() }).where(eq(requirementClaims.id, control!.runId));
      await assert.rejects(interrupted.consume(db, { ...consume, assessmentId: freshForStale.id }));
      await db.update(requirementClaims).set({ id: control!.runId }).where(eq(requirementClaims.requirementId, requirement!.id));
      await db.update(reassessmentGrants).set({ expiresAt: new Date(0) }).where(eq(reassessmentGrants.id, executionGrant.id));
      await assert.rejects(interrupted.consume(db, { ...consume, assessmentId: freshForStale.id }), AuthorizationError);
      await db.update(reassessmentGrants).set({ expiresAt: input.expiresAt }).where(eq(reassessmentGrants.id, executionGrant.id));
      let releaseChange!: () => void, changed!: () => void;
      const changeReady = new Promise<void>(resolve => { changed = resolve; });
      const changeRelease = new Promise<void>(resolve => { releaseChange = resolve; });
      const change = db.transaction(async tx => {
        await tx.update(executionControls).set({ phase: "manual" }).where(eq(executionControls.id, control!.id));
        changed(); await changeRelease;
      });
      await changeReady;
      const staleRace = assert.rejects(interrupted.consume(db, consume));
      releaseChange(); await change; await staleRace;
      await db.update(executionControls).set({ phase: "stopped" }).where(eq(executionControls.id, control!.id));
      const contenders = await Promise.allSettled([interrupted.consume(db, consume), interrupted.consume(db, consume)]);
      // A stopped phase alone is not authoritative managed-child stop evidence.
      assert.equal(contenders.filter(result => result.status === "fulfilled").length, 0);
      assert.equal(contenders.filter(result => result.status === "rejected").length, 2);
      const consumptions = await db.select().from(activityLog).where(eq(activityLog.action, "interrupted_execution_assessment_consumed"));
      assert.equal(consumptions.length, 0);
      const [verifiedAudit] = await db.select().from(activityLog).where(eq(activityLog.id, verifiedAssessment.id));
      assert.equal((verifiedAudit!.metadata as { managedChildExitEvidence: string }).managedChildExitEvidence, "unavailable");
      const verifiedInputs = (verifiedAudit!.metadata as { inputs: Array<{ sha256?: string; fileVersionId?: string }> }).inputs;
      assert.equal(verifiedInputs[0]!.sha256, file!.sha256);
      assert.equal(verifiedInputs[0]!.fileVersionId, file!.id);
      await db.update(documents).set({ projectId: otherProject.id }).where(eq(documents.id, doc!.id));
      assert.equal((await interrupted.record(db, executionAssessment)).disposition, "escalate");
      await db.update(documents).set({ projectId: grantProject.id }).where(eq(documents.id, doc!.id));
      await writeFile(join(inputDirectory, "assessment"), "b");
      assert.equal((await interrupted.record(db, executionAssessment)).disposition, "escalate");
      await rm(join(inputDirectory, "assessment"));
      assert.equal((await interrupted.record(db, executionAssessment)).disposition, "escalate");
      await writeFile(join(inputDirectory, "assessment"), "a");
      await db.update(documents).set({ currentFileVersionId: randomUUID() }).where(eq(documents.id, doc!.id));
      assert.equal((await interrupted.record(db, executionAssessment)).disposition, "escalate");
      await db.update(documents).set({ currentFileVersionId: file!.id }).where(eq(documents.id, doc!.id));
      let unlockDocument!: () => void, documentLocked!: () => void;
      const lockedDocument = new Promise<void>(resolve => { documentLocked = resolve; });
      const holdDocument = new Promise<void>(resolve => { unlockDocument = resolve; });
      const writer = db.transaction(async tx => {
        await tx.select().from(documents).where(eq(documents.id, doc!.id)).for("update");
        documentLocked(); await holdDocument;
        await tx.update(documents).set({ currentFileVersionId: randomUUID() }).where(eq(documents.id, doc!.id));
      });
      await lockedDocument;
      const concurrentAssessment = interrupted.record(db, executionAssessment);
      unlockDocument(); await writer;
      assert.equal((await concurrentAssessment).disposition, "escalate");
      await db.update(documents).set({ currentFileVersionId: file!.id }).where(eq(documents.id, doc!.id));
      const uncertain = await interrupted.record(db, { ...executionAssessment, uncertainExternalEffects: true });
      assert.equal(uncertain.disposition, "escalate");
      assert.equal((await interrupted.record(db, { ...executionAssessment, inputs: [{ type: "workflow_input" as const, inputId: randomUUID() }] })).disposition, "escalate");
      const [executionAudit] = await db.select().from(activityLog).where(eq(activityLog.id, uncertain.id));
      assert.equal((executionAudit!.metadata as { observedPhase: string }).observedPhase, "stopped");
      await db.update(executionControls).set({ phase: "manual", updatedAt: new Date(Date.now() + 1000) }).where(eq(executionControls.id, control!.id));
      await assert.rejects(interrupted.record(db, executionAssessment));
      const [manualControl] = await db.select().from(executionControls).where(eq(executionControls.id, control!.id));
      assert.equal((await interrupted.record(db, { ...executionAssessment, expectedControlUpdatedAt: manualControl!.updatedAt.toISOString() })).disposition, "escalate");
      await db.update(reassessmentGrants).set({ expiresAt: new Date(0) }).where(eq(reassessmentGrants.id, executionGrant.id));
      await assert.rejects(interrupted.record(db, executionAssessment), AuthorizationError);
      await db.update(reassessmentGrants).set({ expiresAt: input.expiresAt }).where(eq(reassessmentGrants.id, executionGrant.id));
      await service.revoke(db, grantProject.id, executionGrant.id);
      await assert.rejects(interrupted.record(db, executionAssessment), AuthorizationError);
      const [unchangedControl] = await db.select().from(executionControls).where(eq(executionControls.id, control!.id));
      assert.equal(unchangedControl!.phase, "manual");

      await assert.rejects(db.transaction(tx => lockReassessmentGrant(tx, agentContext, { grantId: grant.id, projectId: otherProject.id, requirementId: requirement!.id, operation: "revalidate_evidence" })), AuthorizationError);
      await db.update(reassessmentGrants).set({ expiresAt: new Date(0) }).where(eq(reassessmentGrants.id, grant.id));
      await assert.rejects(use(), AuthorizationError);
      await db.update(reassessmentGrants).set({ expiresAt: input.expiresAt }).where(eq(reassessmentGrants.id, grant.id));
      assert.equal((await service.list(db, grantProject.id)).find(row => row.id === grant.id)?.requirementId, requirement!.id);
      await assert.rejects(outsiderService.revoke(db, otherProject.id, grant.id));
      const revoked = await Promise.all([service.revoke(db, grantProject.id, grant.id), service.revoke(db, grantProject.id, grant.id)]);
      assert.ok(revoked.every(row => row.revokedAt && row.revokedBy === owner.account.actorId));
      await assert.rejects(use(), AuthorizationError);
      await assert.rejects(decisions.record(db, { ...assessment, expectedRevision: 1 }), AuthorizationError);
      const audit = await db.select().from(authAuditEvents).where(eq(authAuditEvents.entityId, grant.id));
      assert.equal(audit.filter(row => row.action === "reassessment_grant.created").length, 1);
      assert.equal(audit.filter(row => row.action === "reassessment_grant.revoked").length, 1);
    });
    await t.test("named Key options are authorized, bounded and retain explicit scope IDs across pages", async () => {
      const manager = await human();
      const target = manager.account.actorId;
      for (let index = 0; index < 25; index++) await identity.createProject(manager.headers, { name: index < 2 ? "Duplicate scope" : `Paged scope ${String(index).padStart(2, "0")}` });
      const first = await identity.pagedKeyGrantOptions(manager.headers, { actorId: target, page: 1, pageSize: 20 });
      const second = await identity.pagedKeyGrantOptions(manager.headers, { actorId: target, page: 2, pageSize: 20 });
      assert.equal(first.items.filter(item => item.grant.scope === "project").length, 20);
      assert.equal(second.items.filter(item => item.grant.scope === "project").length, 5);
      assert.equal(first.hasNext, true); assert.equal(second.hasNext, false);
      assert.equal(first.limit, 100);
      const duplicates = await identity.pagedKeyGrantOptions(manager.headers, { actorId: target, query: "Duplicate scope" });
      assert.equal(duplicates.items.length, 2);
      assert.equal(new Set(duplicates.items.map(item => item.grant.scope === "project" ? item.grant.projectId : "")).size, 2);
      assert.equal((await identity.pagedKeyGrantOptions(manager.headers, { actorId: target, query: "Human-owned" })).items.length, 0);
      assert.equal((await identity.pagedKeyGrantOptions(manager.headers, { actorId: target, query: "%_" })).items.length, 0);
      await assert.rejects(identity.pagedKeyGrantOptions(manager.headers, { actorId: target, pageSize: 51 }));
      const personal = first.items.find(item => item.grant.scope === "personal")!;
      assert.ok(personal.label.includes("Human"));
    });
    await t.test(
      "active humans create projects with an atomic owner; admins have no implicit project access",
      async () => {
        const members = await identity.listMemberships(
          owner.headers,
          project.id,
        );
        assert.equal(members.length, 1);
        assert.equal(members[0]!.actor.id, owner.account.actorId);
        assert.equal(members[0]!.role, "owner");
        await assert.rejects(
          identity.listMemberships(admin.headers, project.id),
          AuthorizationError,
        );
        await assert.rejects(
          identity.setMembership(
            admin.headers,
            project.id,
            outsider.account.actorId,
            { role: "member" },
          ),
          AuthorizationError,
        );
      },
    );
    await t.test(
      "members cannot self-promote; maintainers administer lower roles and approvals remain separate",
      async () => {
        await identity.setMembership(
          owner.headers,
          project.id,
          member.account.actorId,
          { role: "member" },
        );
        await identity.setMembership(
          owner.headers,
          project.id,
          maintainer.account.actorId,
          { role: "maintainer" },
        );
        await assert.rejects(
          identity.setMembership(
            member.headers,
            project.id,
            member.account.actorId,
            { role: "owner" },
          ),
          AuthorizationError,
        );
        await assert.rejects(
          identity.setMembership(
            maintainer.headers,
            project.id,
            maintainer.account.actorId,
            { role: "maintainer", explicitPermissions: ["execution.merge"] },
          ),
          AuthorizationError,
        );
        await assert.rejects(
          identity.setMembership(
            maintainer.headers,
            project.id,
            owner.account.actorId,
            { role: "viewer" },
          ),
          AuthorizationError,
        );
        await identity.setMembership(
          maintainer.headers,
          project.id,
          outsider.account.actorId,
          { role: "viewer", explicitPermissions: ["execution.review"] },
        );
        const authority = await getLiveRequestAuthority(
          db,
          await auth.resolve(outsider.headers),
        );
        assert.ok(
          authority.grants.some(
            (grant) =>
              grant.scope === "project" &&
              grant.projectId === project.id &&
              grant.permissions.includes("execution.review"),
          ),
        );
        const approver = await getLiveRequestAuthority(
          db,
          await auth.resolve(maintainer.headers),
        );
        assert.equal(
          approver.grants.some(
            (grant) =>
              grant.scope === "project" &&
              grant.permissions.includes("execution.review"),
          ),
          false,
        );
        await assert.rejects(
          identity.setMembership(
            maintainer.headers,
            project.id,
            outsider.account.actorId,
            { role: "owner" },
          ),
          AuthorizationError,
        );
      },
    );
    await t.test(
      "scoped keys retain live membership limits and limited management keys cannot widen roles",
      async () => {
        const key = await identity.issueKey(
          owner.headers,
          owner.account.actorId,
          {
            name: "Limited manager",
            expiresAt: null,
            grants: [
              {
                scope: "project",
                projectId: project.id,
                permissions: ["resource.read", "project.members.manage"],
              },
            ],
          },
        );
        const keyHeaders = new Headers({
          authorization: `Bearer ${key.rawKey}`,
        });
        await assert.rejects(
          identity.setMembership(
            keyHeaders,
            project.id,
            member.account.actorId,
            { role: "member" },
          ),
          AuthorizationError,
        );
        await assert.rejects(
          identity.setMembership(
            keyHeaders,
            project.id,
            member.account.actorId,
            { role: "viewer", explicitPermissions: ["execution.merge"] },
          ),
          AuthorizationError,
        );
        await identity.setMembership(
          keyHeaders,
          project.id,
          member.account.actorId,
          { role: "viewer" },
        );
        const memberKey = await identity.issueKey(
          member.headers,
          member.account.actorId,
          {
            name: "Project reader",
            expiresAt: null,
            grants: [
              {
                scope: "project",
                projectId: project.id,
                permissions: ["resource.read"],
              },
            ],
          },
        );
        await identity.removeMembership(
          owner.headers,
          project.id,
          member.account.actorId,
        );
        await assert.rejects(
          auth.resolve(
            new Headers({ authorization: `Bearer ${memberKey.rawKey}` }),
          ),
          AuthorizationError,
        );
      },
    );
    await t.test("Agent lifecycle is bounded, isolated, irreversible and preserves identity history", async () => {
      const agent = await identity.createAgent(owner.headers, { displayName: "Retirement duplicate" });
      await assert.rejects(identity.deleteAgent(owner.headers, agent.id), ValidationError);
      await assert.rejects(identity.agentDetail(outsider.headers, agent.id), NotFoundError);
      const keyInput = { name: "Retirement key", expiresAt: null, grants: [{
        scope: "personal" as const, actorId: owner.account.actorId, permissions: ["resource.read" as const],
      }] };
      await identity.setMembership(owner.headers, project.id, agent.id, { role: "member" });
      const key = await identity.issueKey(owner.headers, agent.id, keyInput);
      const keyHeaders = new Headers({ authorization: `Bearer ${key.rawKey}` });
      await identity.disableAgent(owner.headers, agent.id);
      await assert.rejects(auth.resolve(keyHeaders), AuthenticationError);
      await assert.rejects(identity.disableAgent(owner.headers, agent.id), ValidationError);
      await assert.rejects(identity.issueKey(owner.headers, agent.id, keyInput));
      assert.equal((await identity.listAgents(owner.headers)).some(row => row.id === agent.id), false);
      assert.equal((await identity.listAgents(owner.headers, { status: "disabled", query: "Retirement" }))[0]?.id, agent.id);
      await assert.rejects(identity.deleteAgent(outsider.headers, agent.id), NotFoundError);
      const deleted = await identity.deleteAgent(owner.headers, agent.id);
      assert.ok(deleted.deletedAt);
      assert.equal((await identity.listMemberships(owner.headers, project.id)).some(row => row.actor.id === agent.id), false);
      assert.equal((await identity.listAssignees(owner.headers, project.id)).some(row => row.id === agent.id), false);
      assert.equal((await identity.listAssignees(owner.headers)).some(row => row.id === agent.id), false);
      assert.ok((await db.select().from(projectMemberships).where(eq(projectMemberships.actorId, agent.id))).length);
      await assert.rejects(db.update(authActors).set({ status: "active" }).where(eq(authActors.id, agent.id)));
      assert.equal((await identity.listAgents(owner.headers, { status: "disabled", query: "Retirement" })).length, 0);
      assert.equal((await identity.listAgents(owner.headers, { status: "deleted", query: "Retirement" }))[0]?.id, agent.id);
      await assert.rejects(identity.agentDetail(owner.headers, agent.id), NotFoundError);
      await assert.rejects(identity.disableAgentAsAdministrator(admin.headers, agent.id), NotFoundError);
      await assert.rejects(identity.deleteAgent(owner.headers, agent.id), NotFoundError);
      assert.ok((await db.select().from(authActors).where(eq(authActors.id, agent.id)))[0]?.deletedAt);
      assert.ok((await db.select().from(apiKeys).where(eq(apiKeys.id, key.id)))[0]?.revokedAt);
      assert.ok((await db.select().from(authAuditEvents).where(eq(authAuditEvents.subjectActorId, agent.id))).length >= 3);
      const replacement = await identity.createAgent(owner.headers, { displayName: agent.displayName });
      assert.notEqual(replacement.id, agent.id);
      assert.equal((await identity.agentProjects(owner.headers, { actorId: replacement.id })).length, 0);
      assert.equal((await identity.listKeys(owner.headers, replacement.id)).length, 0);
      await assert.rejects(auth.resolve(keyHeaders), AuthenticationError);
      await db.insert(authActors).values(Array.from({ length: 25 }, (_, index) => ({
        type: "agent" as const, status: "active" as const, displayName: `Paged fixture ${index}`,
        managedByActorId: owner.account.actorId, managedByActorType: "human" as const,
      })));
      const first = await identity.listAgents(owner.headers, { query: "Paged fixture", pageSize: 20 });
      const second = await identity.listAgents(owner.headers, { query: "Paged fixture", pageSize: 20, page: 2 });
      assert.equal(first.length, 20); assert.equal(second.length, 5);
      assert.equal(new Set([...first, ...second].map(row => row.id)).size, 25);
      assert.equal((await identity.listAgents(outsider.headers, { query: "Paged fixture" })).length, 0);
      await assert.rejects(identity.listAgents(owner.headers, { pageSize: 51 }));
      const special = await identity.createAgent(owner.headers, { displayName: "Literal_%" });
      assert.deepEqual((await identity.listAgents(owner.headers, { query: "_%" })).map(row => row.id), [special.id]);
    });
    await t.test("Agent project detail respects directory authorization, live reductions and issued ceilings", async () => {
      const agent = await identity.createAgent(owner.headers, { displayName: "Permission editor fixture" });
      const privateProject = await identity.createProject(outsider.headers, { name: "Invisible project" });
      const available = await identity.agentProjects(owner.headers, { actorId: agent.id, view: "available" });
      assert.ok(available.some(row => row.project.id === project.id));
      assert.equal(available.some(row => row.project.id === privateProject.id), false);
      assert.equal((await identity.agentProjects(owner.headers, { actorId: agent.id, view: "available", query: "Invisible" })).length, 0);
      assert.ok(available.find(row => row.project.id === project.id)?.grantablePermissions.includes("execution.review"));
      await assert.rejects(identity.agentProjects(outsider.headers, { actorId: agent.id }), NotFoundError);
      await identity.setMembership(owner.headers, project.id, agent.id, { role: "member", explicitPermissions: ["execution.run"] });
      const detail = await identity.agentProjects(owner.headers, { actorId: agent.id });
      assert.equal(detail[0]?.membership?.role, "member");
      assert.deepEqual(detail[0]?.membership?.explicitPermissions, ["execution.run"]);
      assert.ok(detail[0]?.rolePermissions.includes("resource.write"));
      const readKey = await identity.issueKey(owner.headers, agent.id, { name: "Finite read ceiling", expiresAt: null, grants: [{
        scope: "project", projectId: project.id, permissions: ["resource.read"],
      }] });
      const headers = new Headers({ authorization: `Bearer ${readKey.rawKey}` });
      await identity.setMembership(owner.headers, project.id, agent.id, { role: "viewer", explicitPermissions: [] });
      let authority = await getLiveRequestAuthority(db, await auth.resolve(headers));
      assert.deepEqual(authority.grants.find(grant => grant.scope === "project")?.permissions, ["resource.read"]);
      await identity.setMembership(owner.headers, project.id, agent.id, { role: "member", explicitPermissions: ["execution.run"] });
      authority = await getLiveRequestAuthority(db, await auth.resolve(headers));
      assert.deepEqual(authority.grants.find(grant => grant.scope === "project")?.permissions, ["resource.read"]);
      await identity.revokeKey(owner.headers, agent.id, readKey.id);
      await identity.removeMembership(owner.headers, project.id, agent.id);
      await identity.setMembership(owner.headers, project.id, agent.id, { role: "member" });
      await assert.rejects(auth.resolve(headers), AuthenticationError);
      await identity.disableAgent(owner.headers, agent.id);
      assert.equal((await identity.agentProjects(owner.headers, { actorId: agent.id }))[0]?.canManage, false);
      await assert.rejects(identity.setMembership(owner.headers, project.id, agent.id, { role: "member" }), NotFoundError);
    });
    await t.test("Agent full access can be granted across projects in one atomic batch", async () => {
      const agent = await identity.createAgent(owner.headers, { displayName: "Bulk permission fixture" });
      const secondProject = await identity.createProject(owner.headers, { name: "Bulk permission second project" });
      const result = await identity.grantAgentProjectAccess(owner.headers, {
        actorId: agent.id,
        projectIds: [project.id, secondProject.id],
      });
      assert.deepEqual(result, { updated: 2, projectIds: [project.id, secondProject.id] });
      for (const projectId of [project.id, secondProject.id]) {
        const [membership] = await db.select().from(projectMemberships).where(and(
          eq(projectMemberships.projectId, projectId), eq(projectMemberships.actorId, agent.id),
        ));
        assert.equal(membership?.role, "maintainer");
        assert.deepEqual(membership?.explicitPermissions, ["execution.run", "execution.review", "execution.merge", "mcp.invoke"]);
      }

      const rollbackAgent = await identity.createAgent(owner.headers, { displayName: "Bulk rollback fixture" });
      const inaccessibleProject = await identity.createProject(outsider.headers, { name: "Bulk inaccessible project" });
      await assert.rejects(identity.grantAgentProjectAccess(owner.headers, {
        actorId: rollbackAgent.id,
        projectIds: [project.id, inaccessibleProject.id],
      }), AuthorizationError);
      assert.equal((await db.select().from(projectMemberships).where(and(
        eq(projectMemberships.projectId, project.id), eq(projectMemberships.actorId, rollbackAgent.id),
      ))).length, 0);

      await identity.setMembership(owner.headers, project.id, maintainer.account.actorId, { role: "maintainer" });
      const managedByMaintainer = await identity.createAgent(maintainer.headers, { displayName: "Maintainer managed Agent" });
      await identity.grantAgentProjectAccess(maintainer.headers, { actorId: managedByMaintainer.id, projectIds: [project.id] });
      const [maintainerGranted] = await db.select().from(projectMemberships).where(and(
        eq(projectMemberships.projectId, project.id), eq(projectMemberships.actorId, managedByMaintainer.id),
      ));
      assert.equal(maintainerGranted?.role, "member");
      assert.deepEqual(maintainerGranted?.explicitPermissions, ["execution.run", "execution.review", "execution.merge", "mcp.invoke"]);
    });
    await t.test("Agent disable serializes with credential issuance and deletion never revives it", async () => {
      const agent = await identity.createAgent(owner.headers, { displayName: "Concurrent retirement" });
      const outcomes = await Promise.allSettled([
        identity.issueKey(owner.headers, agent.id, { name: "Racing key", expiresAt: null, grants: [{
          scope: "personal", actorId: owner.account.actorId, permissions: ["resource.read"],
        }] }),
        identity.disableAgent(owner.headers, agent.id),
      ]);
      assert.equal(outcomes[1]?.status, "fulfilled");
      const issued = outcomes[0];
      if (issued?.status === "fulfilled" && "rawKey" in issued.value)
        await assert.rejects(auth.resolve(new Headers({ authorization: `Bearer ${issued.value.rawKey}` })), AuthenticationError);
      await identity.deleteAgent(owner.headers, agent.id);
      assert.ok((await identity.listAgents(owner.headers, { status: "deleted", query: "Concurrent retirement" })).length);
    });
    await t.test(
      "human and agent credentials preserve human ownership and require explicit personal grants",
      async () => {
        const agent = await identity.createAgent(owner.headers, {
          displayName: "Executor",
        });
        const humanKey = await identity.issueKey(
          owner.headers,
          owner.account.actorId,
          {
            name: "Human key",
            expiresAt: null,
            grants: [
              {
                scope: "personal",
                actorId: owner.account.actorId,
                permissions: [
                  "resource.read",
                  "resource.write",
                  "credential.manage",
                ],
              },
            ],
          },
        );
        const humanHeaders = new Headers({
          authorization: `Bearer ${humanKey.rawKey}`,
          "x-actor-id": agent.id,
          "x-actor-type": "agent",
        });
        const context = await auth.resolve(humanHeaders);
        assert.equal(context.actor.type, "human");
        assert.equal(context.actor.id, owner.account.actorId);
        assert.deepEqual(await getPersonalResourceOwner(db, context.actor.id), {
          personalOwnerId: owner.account.actorId,
          personalOwnerType: "human",
        });
        const agentKey = await identity.issueKey(owner.headers, agent.id, {
          name: "Agent key",
          expiresAt: null,
          grants: [
            {
              scope: "personal",
              actorId: owner.account.actorId,
              permissions: ["resource.read", "resource.write"],
            },
          ],
        });
        const agentHeaders = new Headers({
          authorization: `Bearer ${agentKey.rawKey}`,
        });
        const agentContext = await auth.resolve(agentHeaders);
        assert.equal(agentContext.actor.id, agent.id);
        assert.equal(agentContext.actor.type, "agent");
        assert.deepEqual(
          await getPersonalResourceOwner(db, agentContext.actor.id),
          {
            personalOwnerId: owner.account.actorId,
            personalOwnerType: "human",
          },
        );
        await assert.rejects(
          identity.listKeys(agentHeaders, owner.account.actorId),
          AuthorizationError,
        );
        await assert.rejects(
          identity.createProject(agentHeaders, { name: "Agent project" }),
          AuthorizationError,
        );
        await assert.rejects(
          identity.setMembership(owner.headers, project.id, agent.id, {
            role: "owner",
          }),
          ValidationError,
        );
        await assert.rejects(
          identity.disableAgent(outsider.headers, agent.id),
          NotFoundError,
        );
        await identity.disableAgent(owner.headers, agent.id);
        await assert.rejects(auth.resolve(agentHeaders), AuthenticationError);
        await assert.rejects(
          identity.listKeys(outsider.headers, owner.account.actorId),
          AuthorizationError,
        );
        const child = await identity.issueKey(
          humanHeaders,
          owner.account.actorId,
          {
            name: "Narrow child",
            expiresAt: null,
            grants: [
              {
                scope: "personal",
                actorId: owner.account.actorId,
                permissions: ["resource.read"],
              },
            ],
          },
        );
        await identity.revokeKey(
          owner.headers,
          owner.account.actorId,
          humanKey.id,
        );
        await assert.rejects(
          auth.resolve(
            new Headers({ authorization: `Bearer ${child.rawKey}` }),
          ),
          AuthenticationError,
        );
      },
    );
    await t.test(
      "ownership transfer is atomic, human-only and requires recent authentication",
      async () => {
        const transferProject = await identity.createProject(owner.headers, {
          name: "Transfer",
        });
        await assert.rejects(
          identity.removeMembership(
            owner.headers,
            transferProject.id,
            owner.account.actorId,
          ),
          ValidationError,
        );
        await identity.transferOwnership(
          owner.headers,
          transferProject.id,
          outsider.account.actorId,
        );
        const list = await identity.listMemberships(
          outsider.headers,
          transferProject.id,
        );
        assert.equal(
          list.find((entry) => entry.actor.id === outsider.account.actorId)!
            .role,
          "owner",
        );
        assert.equal(
          list.find((entry) => entry.actor.id === owner.account.actorId)!.role,
          "maintainer",
        );
        const created = new Date(Date.now() - 1_000_000);
        await db
          .update(authSessions)
          .set({ createdAt: created, authenticatedAt: created })
          .where(eq(authSessions.id, outsider.session.id));
        await assert.rejects(
          identity.transferOwnership(
            outsider.headers,
            transferProject.id,
            owner.account.actorId,
          ),
          AuthorizationError,
        );
        await assert.rejects(
          identity.issueKey(outsider.headers, outsider.account.actorId, {
            name: "Stale",
            expiresAt: null,
            grants: [
              {
                scope: "personal",
                actorId: outsider.account.actorId,
                permissions: ["resource.read"],
              },
            ],
          }),
          AuthorizationError,
        );
        await assert.rejects(
          identity.removeMembership(
            outsider.headers,
            transferProject.id,
            owner.account.actorId,
          ),
          AuthorizationError,
        );
        await auth.reauthenticate(
          outsider.headers,
          { password },
          "identity-reauth",
        );
        await identity.removeMembership(
          outsider.headers,
          transferProject.id,
          owner.account.actorId,
        );
      },
    );
    await t.test(
      "concurrent account disablement cannot eliminate the last active project owner",
      async () => {
        const first = await human();
        const second = await human();
        const guarded = await identity.createProject(first.headers, {
          name: "Protected",
        });
        await identity.setMembership(
          first.headers,
          guarded.id,
          second.account.actorId,
          { role: "owner" },
        );
        const results = await Promise.allSettled(
          [first, second].map((human) =>
            auth.setAccountState(admin.headers, human.account.id, {
              status: "disabled",
            }),
          ),
        );
        assert.equal(
          results.filter((result) => result.status === "fulfilled").length,
          1,
        );
        const memberships = await db
          .select({
            actorId: projectMemberships.actorId,
            status: authUsers.status,
          })
          .from(projectMemberships)
          .innerJoin(
            authUsers,
            eq(authUsers.actorId, projectMemberships.actorId),
          )
          .where(
            and(
              eq(projectMemberships.projectId, guarded.id),
              eq(projectMemberships.role, "owner"),
              isNull(projectMemberships.removedAt),
            ),
          );
        assert.equal(
          memberships.filter((membership) => membership.status === "active")
            .length,
          1,
        );
      },
    );
    await t.test(
      "rotation and agent administrative disable keep safe audited history",
      async () => {
        const key = await identity.issueKey(
          owner.headers,
          owner.account.actorId,
          {
            name: "Rotate",
            expiresAt: null,
            grants: [
              {
                scope: "personal",
                actorId: owner.account.actorId,
                permissions: ["resource.read"],
              },
            ],
          },
        );
        const results = await Promise.allSettled(
          [0, 1].map(() =>
            identity.rotateKey(owner.headers, owner.account.actorId, key.id),
          ),
        );
        assert.equal(
          results.filter((result) => result.status === "fulfilled").length,
          1,
        );
        const agent = await identity.createAgent(owner.headers, {
          displayName: "Administrative fixture",
        });
        await assert.rejects(
          identity.disableAgentAsAdministrator(outsider.headers, agent.id),
          AuthorizationError,
        );
        await identity.disableAgentAsAdministrator(admin.headers, agent.id);
        const audits = await db.select().from(authAuditEvents);
        const serialized = JSON.stringify(audits);
        assert.equal(serialized.includes(key.rawKey), false);
        assert.equal(serialized.includes(password), false);
        assert.ok(
          audits.some(
            (audit) => audit.action === "project.ownership_transferred",
          ),
        );
      },
    );
  },
);
