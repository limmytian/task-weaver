import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultRuntimePorts } from "@task-weaver/core/default-ports";
import type { Database } from "@task-weaver/db";
import type { TaskWeaverRuntimePorts } from "@task-weaver/module-sdk/ports";
import {
  createCallerFactory,
  createTRPCContextFactory,
  publicProcedure,
  router,
} from "./init";

const emptyDatabase = {} as Database;

test("resolves the Web actor through the configured identity port", async () => {
  const ports = createDefaultRuntimePorts();
  const createContext = createTRPCContextFactory({ db: emptyDatabase, ports });

  const context = await createContext({
    req: new Request("http://localhost/api/trpc", {
      headers: { "x-actor-id": "alice", "x-actor-type": "human" },
    }),
  });

  assert.deepEqual(context.actor, { id: "alice", type: "human" });
  assert.equal(context.ports, ports);
});

test("uses the identity port anonymous actor when no identity headers exist", async () => {
  const createContext = createTRPCContextFactory({
    db: emptyDatabase,
    ports: createDefaultRuntimePorts(),
  });

  const context = await createContext({ req: new Request("http://localhost/api/trpc") });

  assert.deepEqual(context.actor, { id: "anonymous", type: "human" });
});

test("enforces authorization server-side for Web tRPC procedures", async () => {
  const basePorts = createDefaultRuntimePorts();
  const ports: TaskWeaverRuntimePorts = {
    ...basePorts,
    authorization: {
      authorize: () => ({ allowed: false, reason: "blocked by policy" }),
    },
  };
  const testRouter = router({ actor: publicProcedure.query(({ ctx }) => ctx.actor) });
  const caller = createCallerFactory(testRouter)({
    db: emptyDatabase,
    actor: { id: "alice", type: "human" },
    ports,
  });

  await assert.rejects(caller.actor(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "FORBIDDEN");
    assert.match((error as Error).message, /blocked by policy/);
    return true;
  });
});

test("enforces the core Web entitlement independently from UI visibility", async () => {
  const basePorts = createDefaultRuntimePorts();
  const ports: TaskWeaverRuntimePorts = {
    ...basePorts,
    entitlements: {
      checkEntitlement: () => ({ allowed: false, reason: "capability unavailable" }),
    },
  };
  const testRouter = router({ actor: publicProcedure.query(({ ctx }) => ctx.actor) });
  const caller = createCallerFactory(testRouter)({
    db: emptyDatabase,
    actor: { id: "alice", type: "human" },
    ports,
  });

  await assert.rejects(caller.actor(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "FORBIDDEN");
    assert.match((error as Error).message, /capability unavailable/);
    return true;
  });
});
