import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiApplication } from "../apps/api/src/application";
import {
  createTRPCContextFactory,
  getWebAuthenticationRuntime,
} from "../apps/web/trpc/init";
import { appRouter } from "../apps/web/trpc/routers/_app";
import { resolveWebSession } from "../apps/web/lib/authenticated-session";
import { GET as nextCsrf } from "../apps/web/app/api/auth/csrf/route";
import { GET as nextEvents } from "../apps/web/app/api/events/route";
import { GET as nextTRPC } from "../apps/web/app/api/trpc/[trpc]/route";

const apiRequire = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { createDb, runMigrations, authInstanceState, authSessions } =
  apiRequire("@task-weaver/db");
const { createAuthenticationRuntime } = apiRequire("@task-weaver/core");
const { eq } = apiRequire("drizzle-orm");
const { fetchRequestHandler } = webRequire("@trpc/server/adapters/fetch");
const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;

test(
  "REST, tRPC, GraphQL and SSR share verified credentials and fail closed",
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
    const configuration = {
      secret,
      bootstrapSecret,
      baseURL: "http://127.0.0.1:3001",
      trustedOrigins: [origin],
    };
    const auth = createAuthenticationRuntime(db, configuration);
  const nextEnvironment = {
    TW_VERSION_CHECK_ENABLED: "false",
      DATABASE_URL: databaseUrl!,
      TW_AUTH_SECRET: secret,
      TW_AUTH_BASE_URL: configuration.baseURL,
      TW_AUTH_TRUSTED_ORIGINS: origin,
    };
    const previousEnvironment = Object.fromEntries(
      Object.keys(nextEnvironment).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, nextEnvironment);
    t.after(async () => {
      await getWebAuthenticationRuntime().db.$client.end();
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    const api = createApiApplication({
      db,
      databaseUrl: databaseUrl!,
      env: {
        TW_AUTH_SECRET: secret,
        TW_AUTH_BASE_URL: configuration.baseURL,
        TW_AUTH_BOOTSTRAP_SECRET: bootstrapSecret,
        TW_AUTH_TRUSTED_ORIGINS: origin,
        TW_PRESET_SKILLS_SYNC: "disabled",
      },
    }).app;
    async function client() {
      const response = await api.request("/api/v1/auth/csrf");
      const body: any = await response.json();
      return new Headers({
        origin,
        "x-csrf-token": body.csrfToken,
        cookie: response.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; "),
      });
    }
    async function rest(
      path: string,
      headers: Headers,
      method = "GET",
      body?: unknown,
    ) {
      const response = await api.request(`/api/v1/${path}`, {
        headers,
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, body: (await response.json()) as any };
    }
    async function trpc(
      path: string,
      headers: Headers,
      method = "GET",
      input?: unknown,
    ) {
      const requestHeaders = new Headers(headers);
      requestHeaders.set("content-type", "application/json");
      const request = new Request(`${origin}/api/trpc/${path}`, {
        headers: requestHeaders,
        method,
        ...(input === undefined
          ? {}
          : { body: JSON.stringify({ json: input }) }),
      });
      const response = await fetchRequestHandler({
        endpoint: "/api/trpc",
        req: request,
        router: appRouter,
        createContext: createTRPCContextFactory({ db, auth }),
      });
      return { response, body: (await response.json()) as any };
    }
    async function graphql(headers: Headers, query: string) {
      const requestHeaders = new Headers(headers);
      requestHeaders.set("content-type", "application/json");
      return rest("graphql", requestHeaders, "POST", { query });
    }
    const email = `${randomUUID()}@example.test`;
    const bootstrap = await rest("auth/bootstrap", await client(), "POST", {
      email,
      password,
      displayName: "Transport fixture",
      bootstrapSecret,
    });
    assert.equal(bootstrap.response.status, 201);
    const adminHeaders = await client();
    const login = await rest("auth/login", adminHeaders, "POST", {
      email,
      password,
      sessionDurationSeconds: 90 * 86400,
    });
    assert.equal(login.response.status, 200);
    adminHeaders.set(
      "cookie",
      [
        adminHeaders.get("cookie"),
        ...login.response.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0]),
      ].join("; "),
    );
    const actorId = login.body.account.actorId;
    await t.test(
      "REST-issued session resolves identically in tRPC, GraphQL and human SSR",
      async () => {
        const forged = new Headers(adminHeaders);
        forged.set("x-actor-id", randomUUID());
        forged.set("x-actor-type", "agent");
        const next = await trpc("auth.current", forged);
        assert.equal(next.response.status, 200, JSON.stringify(next.body));
        assert.equal(next.body.result.data.json.actor.id, actorId);
        assert.equal(next.response.headers.get("cache-control"), "no-store");
        const graph = await graphql(
          forged,
          "{ currentActor { id type status } }",
        );
        assert.equal(graph.response.status, 200, JSON.stringify(graph.body));
        assert.equal(graph.body.data.currentActor.id, actorId);
        assert.equal(graph.body.data.currentActor.type, "human");
        assert.deepEqual(await resolveWebSession(forged, auth), {
          id: actorId,
          type: "human",
        });
        const actualNext = await nextTRPC(
          new Request(`${origin}/api/trpc/auth.current`, { headers: forged }),
        );
        assert.equal(actualNext.status, 200);
        assert.equal(
          (await actualNext.json()).result.data.json.actor.id,
          actorId,
        );
        const csrf = await nextCsrf(
          new Request(`${origin}/api/auth/csrf`, { headers: { origin } }),
        );
        assert.equal(csrf.status, 200);
        assert.ok((await csrf.json()).csrfToken);
        assert.ok(
          csrf.headers
            .getSetCookie()
            .some((cookie) => cookie.includes("HttpOnly")),
        );
        assert.equal(
          (await nextEvents(new Request(`${origin}/api/events`))).status,
          401,
        );
        const events = await nextEvents(
          new Request(`${origin}/api/events`, { headers: forged }),
        );
        assert.equal(events.status, 200);
        assert.equal(events.headers.get("cache-control"), "no-store");
        const reader = events.body!.getReader();
        assert.ok(new TextDecoder().decode((await reader.read()).value).includes("resync"));
        await reader.cancel();
        await webRequire("@task-weaver/realtime").shutdown();
      },
    );
    await t.test(
      "direct anonymous, malformed and mixed credentials are rejected by each transport",
      async () => {
        for (const headers of [
          new Headers({ "x-actor-id": actorId }),
          new Headers({ authorization: "Basic invalid" }),
          new Headers({ authorization: "Bearer invalid" }),
        ]) {
          const next = await trpc("auth.current", headers);
          assert.equal(next.response.status, 401, JSON.stringify(next.body));
          assert.equal(next.body.error.json.data.code, "UNAUTHORIZED");
          assert.equal("stack" in next.body.error.json.data, false);
          assert.equal(
            (await graphql(headers, "{ currentActor { id } }")).response.status,
            401,
          );
          await assert.rejects(resolveWebSession(headers, auth));
        }
        assert.equal(
          (await trpc("version.info", new Headers())).response.status,
          200,
        );
        assert.equal(
          (
            await trpc(
              "version.info",
              new Headers({ authorization: "Bearer invalid" }),
            )
          ).response.status,
          401,
        );
      },
    );
    await t.test(
      "ordinary project lists filter administrators while discovery remains closed",
      async () => {
        assert.equal(
          (await trpc("project.list", adminHeaders)).response.status,
          200,
        );
        const graph = await graphql(
          adminHeaders,
          "{ projects { id name tasks { id title } } }",
        );
        assert.equal(graph.response.status, 200, JSON.stringify(graph.body));
        assert.deepEqual(graph.body.data.projects, []);
        const batch = await trpc(
          "auth.current,project.list?batch=1",
          adminHeaders,
        );
        assert.equal(batch.response.status, 200);
        assert.equal(batch.body[0].result.data.json.actor.id, actorId);
        assert.deepEqual(batch.body[1].result.data.json, []);
      },
    );
  await t.test(
    "browser mutation and GraphQL POST enforce exact Origin/CSRF",
      async () => {
        const missing = new Headers(adminHeaders);
        missing.delete("x-csrf-token");
        assert.equal(
          (await trpc("auth.logout", missing, "POST")).response.status,
          403,
        );
        assert.equal(
          (await graphql(missing, "{ currentActor { id } }")).response.status,
          403,
        );
        missing.set("origin", "https://evil.example");
      assert.equal(
        (await trpc("auth.current", missing)).response.status,
        403,
      );
      assert.equal((await rest("version/check", adminHeaders, "POST", {})).response.status, 200);
      assert.equal((await trpc("version.check", adminHeaders, "POST")).response.status, 200);
      },
    );
    await t.test(
      "tRPC login propagates cookies accepted immediately by REST and GraphQL",
      async () => {
        const headers = await client();
        const next = await trpc("auth.login", headers, "POST", {
          email,
          password,
        });
        assert.equal(next.response.status, 200, JSON.stringify(next.body));
        assert.ok(
          next.response.headers
            .getSetCookie()
            .some((cookie) => cookie.includes("HttpOnly")),
        );
        assert.equal(JSON.stringify(next.body).includes(password), false);
        headers.set(
          "cookie",
          [
            headers.get("cookie"),
            ...next.response.headers
              .getSetCookie()
              .map((cookie) => cookie.split(";")[0]),
          ].join("; "),
        );
        assert.equal((await rest("auth/me", headers)).body.actor.id, actorId);
        assert.equal(
          (await graphql(headers, "{ currentActor { id } }")).body.data
            .currentActor.id,
          actorId,
        );
        const logout = await trpc("auth.logout", headers, "POST");
        assert.equal(logout.response.status, 200);
        assert.ok(
          logout.response.headers
            .getSetCookie()
            .some((cookie) => cookie.includes("Max-Age=0")),
        );
        assert.equal((await rest("auth/me", headers)).response.status, 401);
      },
    );
    await t.test(
      "human and managed-Agent keys preserve stable subject identity and cannot become SSR sessions",
      async () => {
        const key = await rest("api-keys", adminHeaders, "POST", {
          name: "Bound human",
          expiresAt: null,
          grants: [
            { scope: "personal", actorId, permissions: ["resource.read"] },
          ],
        });
        assert.equal(key.response.status, 201);
        const headers = new Headers({
          authorization: `Bearer ${key.body.rawKey}`,
        });
        assert.equal(
          (await trpc("auth.current", headers)).body.result.data.json.actor
            .type,
          "human",
        );
        assert.equal(
          (await graphql(headers, "{ currentActor { id type } }")).body.data
            .currentActor.id,
          actorId,
        );
        await assert.rejects(resolveWebSession(headers, auth));
        const agent = await rest("auth/agents", adminHeaders, "POST", {
          displayName: "Executor fixture",
        });
        const agentKey = await rest("api-keys", adminHeaders, "POST", {
          actorId: agent.body.id,
          name: "Bound agent",
          expiresAt: null,
          grants: [
            { scope: "personal", actorId, permissions: ["resource.read"] },
          ],
        });
        assert.equal(
          agentKey.response.status,
          201,
          JSON.stringify(agentKey.body),
        );
        const agentHeaders = new Headers({
          authorization: `Bearer ${agentKey.body.rawKey}`,
          "x-actor-id": actorId,
          "x-actor-type": "human",
        });
        assert.equal(
          (await trpc("auth.current", agentHeaders)).body.result.data.json.actor
            .id,
          agent.body.id,
        );
        assert.equal(
          (await graphql(agentHeaders, "{ currentActor { id type } }")).body
            .data.currentActor.type,
          "agent",
        );
        assert.equal(
          (await trpc("auth.accounts", agentHeaders)).response.status,
          403,
        );
        await assert.rejects(resolveWebSession(agentHeaders, auth));
        const mixed = new Headers(adminHeaders);
        mixed.set("authorization", `Bearer ${key.body.rawKey}`);
        assert.equal((await trpc("auth.current", mixed)).response.status, 401);
        assert.equal(
          (await graphql(mixed, "{ currentActor { id } }")).response.status,
          401,
        );
        const reused = appRouter.createCaller(
          await createTRPCContextFactory({ db, auth })({
            req: new Request(`${origin}/api/trpc`, { headers }),
          }),
        );
        assert.equal((await reused.auth.current()).actor.id, actorId);
        assert.equal(
          (await rest(`api-keys/${key.body.id}`, adminHeaders, "DELETE"))
            .response.status,
          200,
        );
        await assert.rejects(
          () => reused.auth.current(),
          (error: unknown) =>
            (error as { code: string }).code === "UNAUTHORIZED",
        );
        assert.equal(
          (await graphql(headers, "{ currentActor { id } }")).response.status,
          401,
        );
        assert.equal(
          (await rest(`auth/agents/${agent.body.id}`, adminHeaders, "DELETE"))
            .response.status,
          200,
        );
        assert.equal(
          (await trpc("auth.current", agentHeaders)).response.status,
          401,
        );
        assert.equal(
          (await graphql(agentHeaders, "{ currentActor { id } }")).response
            .status,
          401,
        );
      },
    );
    await t.test(
      "idle expiry and revocation invalidate the same session in every adapter",
      async () => {
        const createdAt = new Date(Date.now() - 7200_000);
        await db
          .update(authSessions)
          .set({
            createdAt,
            authenticatedAt: createdAt,
            idleExpiresAt: new Date(Date.now() - 3600_000),
          })
          .where(eq(authSessions.id, login.body.session.id));
        assert.equal(
          (await rest("auth/me", adminHeaders)).response.status,
          401,
        );
        assert.equal(
          (await trpc("auth.current", adminHeaders)).response.status,
          401,
        );
        assert.equal(
          (await graphql(adminHeaders, "{ currentActor { id } }")).response
            .status,
          401,
        );
        await assert.rejects(resolveWebSession(adminHeaders, auth));
      },
    );
  },
);
