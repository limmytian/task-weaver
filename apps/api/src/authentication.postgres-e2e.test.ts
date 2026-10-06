import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, authInstanceState } from "@task-weaver/db";
import { apiKeyService } from "@task-weaver/core";
import { createApiApplication } from "./application";

const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;
test(
  "HTTP authentication enforces shared identity and closed resource activation",
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
    const secret = randomBytes(32).toString("hex");
    const bootstrapSecret = randomBytes(32).toString("hex");
    const password = randomBytes(24).toString("hex");
    const origin = "http://127.0.0.1:3000";
    const app = createApiApplication({
      db,
      databaseUrl: databaseUrl!,
      env: {
        TW_AUTH_SECRET: secret,
        TW_AUTH_BOOTSTRAP_SECRET: bootstrapSecret,
        TW_AUTH_BASE_URL: "http://127.0.0.1:3001",
        TW_AUTH_TRUSTED_ORIGINS: origin,
        TW_PRESET_SKILLS_SYNC: "disabled",
      },
    }).app;
    async function client() {
      const response = await app.request("/api/v1/auth/csrf", {
        headers: { origin },
      });
      const body: any = await response.json();
      assert.equal(response.status, 200);
      return new Headers({
        origin,
        "x-csrf-token": body.csrfToken,
        cookie: response.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; "),
      });
    }
    async function call(
      path: string,
      headers: Headers,
      method = "GET",
      input?: unknown,
    ) {
      const response = await app.request(`/api/v1/${path}`, {
        method,
        headers,
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      assert.equal(response.headers.get("cache-control"), "no-store");
      return { response, body: (await response.json()) as any };
    }
    async function login(email: string) {
      const headers = await client();
      const { response, body } = await call("auth/login", headers, "POST", {
        email,
        password,
        sessionDurationSeconds: 90 * 86400,
      });
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.ok(
        response.headers
          .getSetCookie()
          .some((cookie) => cookie.includes("HttpOnly")),
      );
      headers.set(
        "cookie",
        [
          headers.get("cookie"),
          ...response.headers
            .getSetCookie()
            .map((cookie) => cookie.split(";")[0]),
        ].join("; "),
      );
      return { headers, account: body.account, session: body.session };
    }
    const email = `${randomUUID()}@example.test`;
    await t.test(
      "bootstrap/login expose safe DTOs and propagate session cookies",
      async () => {
        const { response, body } = await call(
          "auth/bootstrap",
          await client(),
          "POST",
          { email, password, displayName: "HTTP fixture", bootstrapSecret },
        );
        assert.equal(response.status, 201, JSON.stringify(body));
        assert.equal(JSON.stringify(body).includes(password), false);
        assert.equal("headers" in body, false);
      },
    );
    const admin = await login(email);
    const invitation = await call("auth/accounts", admin.headers, "POST", {
      email: `${randomUUID()}@example.test`,
      displayName: "Member fixture",
    });
    assert.equal(invitation.response.status, 201);
    const activation = await call("auth/activate", await client(), "POST", {
      token: invitation.body.activationToken,
      password,
    });
    assert.equal(activation.response.status, 200);
    const member = await login(invitation.body.account.email);
    await t.test(
      "forged headers never change a session principal; CSRF and admin boundaries hold",
      async () => {
        const forged = new Headers(member.headers);
        forged.set("X-Actor-Id", admin.account.actorId);
        forged.set("X-Actor-Type", "agent");
        const current = await call("auth/me", forged);
        assert.equal(current.body.actor.id, member.account.actorId);
        assert.equal(current.body.actor.type, "human");
        assert.equal(
          (await call("auth/accounts", forged)).response.status,
          403,
        );
        forged.delete("x-csrf-token");
        assert.equal(
          (await call("auth/logout", forged, "POST", {})).response.status,
          403,
        );
        forged.set("origin", "https://evil.example");
        assert.equal((await call("auth/me", forged)).response.status, 403);
      },
    );
    let key: any;
    await t.test(
      "only scoped subject-bound keys are issued; omission and legacy credentials fail closed",
      async () => {
        const input = {
          name: "HTTP key",
          expiresAt: null,
          grants: [
            {
              scope: "personal",
              actorId: member.account.actorId,
              permissions: ["resource.read"],
            },
          ],
        };
        const result = await call("api-keys", member.headers, "POST", input);
        assert.equal(result.response.status, 201, JSON.stringify(result.body));
        key = result.body;
        assert.equal(key.actorId, member.account.actorId);
        const listing = await call("api-keys", member.headers);
        assert.equal(JSON.stringify(listing.body).includes(key.rawKey), false);
        const { expiresAt: _, ...omitted } = input;
        assert.equal(
          (await call("api-keys", member.headers, "POST", omitted)).response
            .status,
          400,
        );
        assert.equal(
          (
            await call("api-keys", member.headers, "POST", {
              name: "Legacy",
              permissions: {},
            })
          ).response.status,
          400,
        );
        const old = await apiKeyService.createApiKey(db, {
          name: "Unbound fixture",
        });
        assert.equal(
          (
            await call(
              "auth/me",
              new Headers({ authorization: `Bearer ${old.rawKey}` }),
            )
          ).response.status,
          401,
        );
        assert.equal(
          (
            await call(
              `api-keys?actorId=${admin.account.actorId}`,
              member.headers,
            )
          ).response.status,
          403,
        );
      },
    );
    await t.test(
      "key identity stays human and mixed credentials are rejected",
      async () => {
        const bearer = new Headers({
          authorization: `Bearer ${key.rawKey}`,
          "x-actor-id": admin.account.actorId,
          "x-actor-type": "agent",
        });
        const current = await call("auth/me", bearer);
        assert.equal(current.response.status, 200);
        assert.equal(current.body.actor.id, member.account.actorId);
        assert.equal(current.body.actor.type, "human");
        const mixed = new Headers(member.headers);
        mixed.set("authorization", `Bearer ${key.rawKey}`);
        assert.equal((await call("auth/me", mixed)).response.status, 401);
      },
    );
    await t.test(
      "discovery and execution remain closed even to an instance administrator",
      async () => {
        for (const path of [
          "tasks",
          "search?q=test",
          "daemons/events",
          "ti/worker/status",
          "observability",
        ]) {
          assert.equal(
            (await call(path, admin.headers)).response.status,
            path === "daemons/events" ? 404 : 403,
            path,
          );
          assert.equal(
            (await call(path, new Headers())).response.status,
            401,
            path,
          );
        }
        assert.equal(
          (await call("auth/sign-up/email", admin.headers, "POST", {})).response
            .status,
          404,
        );
        const project = await call("auth/projects", member.headers, "POST", {
          name: "Guarded project",
        });
        assert.equal(project.response.status, 201);
        assert.equal(
          (
            await call(
              `auth/projects/${project.body.id}/members`,
              admin.headers,
            )
          ).response.status,
          403,
        );
        const members = await call(
          `auth/projects/${project.body.id}/members`,
          member.headers,
        );
        assert.equal(members.body[0].actor.id, member.account.actorId);
        assert.equal(members.body[0].role, "owner");
      },
    );
    await t.test(
      "logout and key deletion invalidate subsequent requests immediately",
      async () => {
        assert.equal(
          (await call(`api-keys/${key.id}`, member.headers, "DELETE")).response
            .status,
          200,
        );
        assert.equal(
          (
            await call(
              "auth/me",
              new Headers({ authorization: `Bearer ${key.rawKey}` }),
            )
          ).response.status,
          401,
        );
        const logout = await call("auth/logout", member.headers, "POST", {});
        assert.equal(logout.response.status, 200);
        assert.ok(
          logout.response.headers
            .getSetCookie()
            .some((cookie) => cookie.includes("Max-Age=0")),
        );
        assert.equal(
          (await call("auth/me", member.headers)).response.status,
          401,
        );
      },
    );
    await t.test(
      "login retries return safe 429 and ignore forwarded actor/address claims",
      async () => {
        const headers = await client();
        const badPassword = randomBytes(24).toString("hex");
        let last: Awaited<ReturnType<typeof call>> | undefined;
        for (let attempt = 0; attempt < 11; attempt++) {
          headers.set("x-forwarded-for", `192.0.2.${attempt}`);
          last = await call("auth/login", headers, "POST", {
            email: `${email}.missing`,
            password: badPassword,
          });
        }
        assert.equal(last!.response.status, 429);
        assert.ok(Number(last!.response.headers.get("retry-after")) > 0);
        assert.equal(JSON.stringify(last!.body).includes(badPassword), false);
      },
    );
  },
);
