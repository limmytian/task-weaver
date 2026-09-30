import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { createDb, type Database } from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import {
  AuthorizationDeniedError,
  EntitlementDeniedError,
  enforceAccess,
  type TaskWeaverRuntimePorts,
} from "@task-weaver/module-sdk/ports";
import { getWebRuntime, requestHeadersRecord } from "@/lib/web-runtime";

export type TRPCContext = {
  db: Database;
  actor: Actor;
  ports: TaskWeaverRuntimePorts;
};

export interface TRPCRequestContextOptions {
  req: Request;
}

export interface TRPCContextDependencies {
  db: Database;
  ports: TaskWeaverRuntimePorts;
}

let db: Database | null = null;

function getDb(): Database {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    db = createDb(url);
  }
  return db;
}

export function createTRPCContextFactory(dependencies: TRPCContextDependencies) {
  return async ({ req }: TRPCRequestContextOptions): Promise<TRPCContext> => {
    const identity = await dependencies.ports.identity.resolveIdentity({
      headers: requestHeadersRecord(req.headers),
    });
    return {
      db: dependencies.db,
      actor: identity.actor,
      ports: dependencies.ports,
    };
  };
}

export function createTRPCContext(options: TRPCRequestContextOptions): Promise<TRPCContext> {
  return createTRPCContextFactory({
    db: getDb(),
    ports: getWebRuntime().ports,
  })(options);
}

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
});

export const router = t.router;
const enforceWebAccess = t.middleware(async ({ ctx, next }) => {
  try {
    await enforceAccess(ctx.ports, {
      authorization: {
        actor: ctx.actor,
        permission: "core.web.access",
        resource: { type: "web", id: "trpc" },
      },
      entitlement: {
        capability: "core.web",
        scope: { type: "web", id: "trpc" },
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationDeniedError || error instanceof EntitlementDeniedError) {
      throw new TRPCError({ code: "FORBIDDEN", message: error.message, cause: error });
    }
    throw error;
  }
  return next();
});

export const publicProcedure = t.procedure.use(enforceWebAccess);
export const createCallerFactory = t.createCallerFactory;
