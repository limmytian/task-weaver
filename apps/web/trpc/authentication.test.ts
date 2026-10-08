import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import type { Database } from "@task-weaver/db";
import { createAuthenticationRuntime } from "@task-weaver/core";
import { appRouter } from "./routers/_app";
import { createTRPCContextFactory, publicProcedure, router } from "./init";

function fixture(headers = new Headers(), db = {} as Database) {
  const auth = createAuthenticationRuntime(db, {
    secret: randomBytes(32).toString("hex"),
    baseURL: "http://localhost:3001",
    trustedOrigins: ["http://localhost:3000"],
  });
  return createTRPCContextFactory({ db, auth })({
    req: new Request("http://localhost:3000/api/trpc", { headers }),
  });
}
test("direct callers cannot supply actor authority or bypass protected tRPC defaults", async () => {
  const context = await fixture(
    new Headers({ "x-actor-id": "forged", "x-actor-type": "agent" }),
  );
  Object.assign(context, {
    actor: { id: "forged", type: "agent" },
    identity: { actor: { id: "forged" } },
  });
  const caller = appRouter.createCaller(context);
  for (const operation of [
    () => caller.auth.current(),
    () => caller.project.list(),
    () => caller.apiKey.list(),
  ]) {
    await assert.rejects(operation, (error: unknown) => {
      assert.equal((error as { code: string }).code, "UNAUTHORIZED");
      assert.equal((error as Error).message, "Authentication required");
      return true;
    });
  }
});
test("public procedures require explicit path enrollment and never discard malformed credentials", async () => {
  let called = false;
  const accidental = router({
    leak: publicProcedure.query(() => {
      called = true;
      return "private";
    }),
  });
  await assert.rejects(
    () => accidental.createCaller(fixture).leak(),
    (error: unknown) => (error as { code: string }).code === "FORBIDDEN",
  );
  assert.equal(called, false);
  const context = await fixture(
    new Headers({ authorization: "Basic invalid" }),
  );
  await assert.rejects(
    () => appRouter.createCaller(context).version.info(),
    (error: unknown) => (error as { code: string }).code === "UNAUTHORIZED",
  );
});

test("setup readiness is an explicit anonymous, uncached and origin-guarded query", async () => {
  let reads = 0;
  const db = { select: () => ({ from: () => ({ where: async () => {
    reads++;
    return [{ initializedByUserId: null }];
  } }) }) } as unknown as Database;
  const context = await fixture(new Headers(), db);
  assert.deepEqual(await appRouter.createCaller(context).auth.setupStatus(), { initialized: false });
  assert.equal(context.responseHeaders.get("cache-control"), "no-store");
  assert.equal(reads, 1);
  for (const headers of [
    new Headers({ origin: "https://untrusted.example" }),
    new Headers({ authorization: "Bearer malformed" }),
  ]) {
    await assert.rejects(() => fixture(headers, db).then(ctx => appRouter.createCaller(ctx).auth.setupStatus()));
  }
  assert.equal(reads, 1);
});
