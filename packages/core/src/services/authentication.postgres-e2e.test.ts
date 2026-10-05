import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createDb,
  runMigrations,
  authUsers,
  authAccounts,
  authSessions,
  authAuditEvents,
  authActivations,
  authInstanceState,
  projects,
  projectMemberships,
} from "@task-weaver/db";
import {
  AuthenticationError,
  AuthenticationRateLimitError,
  AuthorizationError,
  ValidationError,
} from "@task-weaver/contracts";
import { createAuthenticationService } from "./authentication";

const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;
test(
  "account provider enforces closed activation, bounded sessions, live revocation and identity protection",
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
      .set({ initializedByUserId: null, initializedAt: null })
      .where(eq(authInstanceState.id, "instance"));
    const config = {
      secret: "fixture-auth-secret".repeat(3),
      bootstrapSecret: "fixture-bootstrap-secret".repeat(3),
      baseURL: "http://127.0.0.1:3001",
      trustedOrigins: ["http://127.0.0.1:3000"],
    };
    const service = createAuthenticationService(db, config);
    const password = "fixture-only-long-password";
    const email = `${randomUUID()}@example.test`;
    const client = () => {
      const challenge = service.csrfChallenge();
      return new Headers({
        cookie: challenge.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; "),
        origin: config.trustedOrigins[0]!,
        "x-csrf-token": challenge.csrfToken,
      });
    };
    const withSession = (headers: Headers, result: { headers: Headers }) => {
      const next = new Headers(headers);
      next.set(
        "cookie",
        [
          headers.get("cookie"),
          ...result.headers
            .getSetCookie()
            .map((cookie) => cookie.split(";")[0]),
        ]
          .filter(Boolean)
          .join("; "),
      );
      return next;
    };
    const login = async (accountEmail: string, duration?: number) => {
      const headers = client();
      const result = await service.login(
        headers,
        { email: accountEmail, password, sessionDurationSeconds: duration },
        `login-${randomUUID()}`,
      );
      return { headers: withSession(headers, result), result };
    };
    let adminId = "";
    await t.test(
      "explicit Secret bootstrap is atomic and public signup has no service surface",
      async () => {
        assert.equal("provider" in service, false);
        assert.equal("handler" in service, false);
        const outcomes = await Promise.allSettled(
          [0, 1].map(() =>
            service.bootstrap(
              client(),
              {
                email,
                displayName: "Administrator",
                password,
                bootstrapSecret: config.bootstrapSecret,
              },
              `bootstrap-${randomUUID()}`,
            ),
          ),
        );
        assert.equal(
          outcomes.filter((outcome) => outcome.status === "fulfilled").length,
          1,
          outcomes
            .map((outcome) =>
              outcome.status === "rejected" ? String(outcome.reason) : "ok",
            )
            .join("; "),
        );
        const row = await db.select().from(authInstanceState);
        adminId = row[0]!.initializedByUserId!;
        const [account] = await db
          .select()
          .from(authAccounts)
          .where(eq(authAccounts.userId, adminId));
        assert.ok(account?.password && account.password !== password);
        assert.equal(JSON.stringify(outcomes).includes(password), false);
        await assert.rejects(
          service.bootstrap(
            client(),
            {
              email: "other@example.test",
              displayName: "Other",
              password,
              bootstrapSecret: "wrong".repeat(10),
            },
            "wrong-secret",
          ),
          AuthenticationError,
        );
      },
    );
    const administrator = await login(email);
    await t.test(
      "provider login returns safe DTOs and configurable longer sessions",
      async () => {
        const results = await Promise.all([
          login(email, 30 * 86400),
          login(email, 90 * 86400),
        ]);
        for (const [index, result] of results.entries()) {
          const [session] = await db
            .select()
            .from(authSessions)
            .where(eq(authSessions.id, result.result.session.id));
          const days = index === 0 ? 30 : 90;
          assert.equal(
            session!.absoluteExpiresAt.getTime() - session!.createdAt.getTime(),
            days * 86400_000,
          );
          assert.equal(
            session!.idleExpiresAt.getTime() - session!.createdAt.getTime(),
            86400_000,
          );
          assert.ok(
            result.result.headers
              .getSetCookie()
              .some((cookie) => cookie.includes(`Max-Age=${days * 86400}`)),
          );
          const serialized = JSON.stringify({
            account: result.result.account,
            session: result.result.session,
            current: await service.current(result.headers),
          });
          assert.equal(serialized.includes(session!.token), false);
          assert.equal(serialized.includes("password"), false);
          assert.equal(serialized.includes("token"), false);
        }
        await assert.rejects(
          service.login(
            client(),
            { email, password, sessionDurationSeconds: 400 * 86400 },
            "policy",
          ),
          ValidationError,
        );
      },
    );
    await t.test(
      "origin/CSRF checks protect anonymous authentication and cookie mutations",
      async () => {
        await assert.rejects(
          service.login(new Headers(), { email, password }, "missing-csrf"),
          AuthorizationError,
        );
        const wrongOrigin = client();
        wrongOrigin.set("origin", "https://attacker.example");
        await assert.rejects(
          service.login(wrongOrigin, { email, password }, "wrong-origin"),
          AuthorizationError,
        );
        const missing = new Headers(administrator.headers);
        missing.delete("x-csrf-token");
        await assert.rejects(service.logout(missing), AuthorizationError);
        const invalidBearer = new Headers(administrator.headers);
        invalidBearer.set("authorization", "Bearer bad");
        await assert.rejects(
          service.resolve(invalidBearer),
          AuthenticationError,
        );
        const ambiguous = new Headers(administrator.headers);
        ambiguous.set("authorization", `Bearer tw_${"1".repeat(64)}`);
        await assert.rejects(service.resolve(ambiguous), AuthenticationError);
        const forged = new Headers({
          "x-actor-id": administrator.result.account.actorId,
          "x-actor-type": "human",
        });
        await assert.rejects(service.resolve(forged), AuthenticationError);
      },
    );
    await t.test(
      "logout and expired sessions preserve tombstones and cannot authenticate",
      async () => {
        const logged = await login(email);
        const id = logged.result.session.id;
        await service.logout(logged.headers);
        await assert.rejects(
          service.resolve(logged.headers),
          AuthenticationError,
        );
        assert.ok(
          (
            await db.select().from(authSessions).where(eq(authSessions.id, id))
          )[0]!.revokedAt,
        );
        const expired = await login(email);
        const now = Date.now();
        const created = new Date(now - 3600000);
        const expiry = new Date(now - 1000);
        await db
          .update(authSessions)
          .set({
            createdAt: created,
            expiresAt: expiry,
            idleExpiresAt: expiry,
            absoluteExpiresAt: expiry,
            authenticatedAt: created,
          })
          .where(eq(authSessions.id, expired.result.session.id));
        await assert.rejects(
          service.resolve(expired.headers),
          AuthenticationError,
        );
        assert.ok(
          (
            await db
              .select()
              .from(authSessions)
              .where(eq(authSessions.id, expired.result.session.id))
          )[0]!.revokedAt,
        );
      },
    );
    let memberId = "";
    let memberEmail = "";
    await t.test(
      "administrator invitations activate once and recovery preserves stable identity",
      async () => {
        memberEmail = `${randomUUID()}@example.test`;
        const invitation = await service.provision(administrator.headers, {
          email: memberEmail,
          displayName: "Member",
        });
        memberId = invitation.account.id;
        await assert.rejects(
          service.login(
            client(),
            { email: memberEmail, password },
            "before-activation",
          ),
          AuthenticationError,
        );
        assert.equal(
          (
            await db
              .select()
              .from(authAccounts)
              .where(eq(authAccounts.userId, memberId))
          ).length,
          0,
        );
        assert.equal(
          JSON.stringify(await db.select().from(authActivations)).includes(
            invitation.activationToken,
          ),
          false,
        );
        const activated = await service.activate(
          client(),
          { token: invitation.activationToken, password },
          "activation",
        );
        assert.equal(activated.account.actorId, invitation.account.actorId);
        await assert.rejects(
          service.activate(
            client(),
            { token: invitation.activationToken, password },
            "activation-replay",
          ),
          AuthenticationError,
        );
        const old = await login(memberEmail);
        const recovery = await service.recover(administrator.headers, memberId);
        await assert.rejects(service.resolve(old.headers), AuthenticationError);
        await assert.rejects(
          service.login(
            client(),
            { email: memberEmail, password },
            "recovery-old-password",
          ),
          AuthenticationError,
        );
        const restored = await service.activate(
          client(),
          { token: recovery.activationToken, password },
          "recovery",
        );
        assert.equal(restored.account.actorId, invitation.account.actorId);
        await assert.rejects(service.resolve(old.headers), AuthenticationError);
      },
    );
    await t.test(
      "last active administrator and last active human owner cannot be disabled",
      async () => {
        // Earlier additive-key tests created unrelated admin fixtures; disable them directly for this fixture.
        const prior = await db
          .select()
          .from(authUsers)
          .where(eq(authUsers.instanceRole, "admin"));
        for (const user of prior)
          if (user.id !== adminId)
            await db
              .update(authUsers)
              .set({ status: "disabled" })
              .where(eq(authUsers.id, user.id));
        await assert.rejects(
          service.setAccountState(administrator.headers, adminId, {
            status: "disabled",
          }),
          ValidationError,
        );
        await assert.rejects(
          service.setAccountState(administrator.headers, adminId, {
            instanceRole: "user",
          }),
          ValidationError,
        );
        const [member] = await db
          .select()
          .from(authUsers)
          .where(eq(authUsers.id, memberId));
        const [project] = await db
          .insert(projects)
          .values({ name: "Owned fixture", createdBy: member!.actorId })
          .returning();
        await db
          .insert(projectMemberships)
          .values({
            projectId: project!.id,
            actorId: member!.actorId,
            actorType: "human",
            role: "owner",
          });
        await assert.rejects(
          service.setAccountState(administrator.headers, memberId, {
            status: "disabled",
          }),
          ValidationError,
        );
        await db
          .insert(projectMemberships)
          .values({
            projectId: project!.id,
            actorId: administrator.result.account.actorId,
            actorType: "human",
            role: "owner",
          });
        const memberLogin = await login(memberEmail);
        await assert.rejects(
          service.provision(memberLogin.headers, {
            email: "unauthorized@example.test",
            displayName: "Unauthorized",
          }),
          AuthorizationError,
        );
        await service.setAccountState(administrator.headers, memberId, {
          status: "disabled",
        });
        await assert.rejects(
          service.resolve(memberLogin.headers),
          AuthenticationError,
        );
      },
    );
    await t.test(
      "login retries are bounded with generic errors and secret-free audit data",
      async () => {
        for (let attempt = 0; attempt < 10; attempt++)
          await assert.rejects(
            service.login(
              client(),
              { email: "missing@example.test", password },
              "rate-limit-address",
            ),
            AuthenticationError,
          );
        await assert.rejects(
          service.login(
            client(),
            { email: "missing@example.test", password },
            "rate-limit-address",
          ),
          AuthenticationRateLimitError,
        );
        const events = await db.select().from(authAuditEvents);
        assert.ok(events.some((event) => event.action === "account.activated"));
        const serialized = JSON.stringify(events);
        for (const value of [
          password,
          config.secret,
          config.bootstrapSecret,
          email,
        ])
          assert.equal(serialized.includes(value), false);
      },
    );
    await t.test(
      "recent authentication and password changes revoke existing sessions",
      async () => {
        const old = await login(email);
        const created = new Date(Date.now() - 1000000);
        await db
          .update(authSessions)
          .set({ createdAt: created, authenticatedAt: created })
          .where(eq(authSessions.id, old.result.session.id));
        await assert.rejects(
          service.provision(old.headers, {
            email: "fresh@example.test",
            displayName: "Fresh",
          }),
          AuthorizationError,
        );
        await service.reauthenticate(old.headers, { password }, "reauth");
        await service.changePassword(
          old.headers,
          {
            currentPassword: password,
            newPassword: "new-fixture-password-123",
          },
          "password-change",
        );
        await assert.rejects(service.resolve(old.headers), AuthenticationError);
        await assert.rejects(
          service.resolve(administrator.headers),
          AuthenticationError,
        );
      },
    );
  },
);
