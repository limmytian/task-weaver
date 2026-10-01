import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { createDb, type Database } from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import { resolveActor } from "@task-weaver/contracts";

export type TRPCContext = {
  db: Database;
  actor: Actor;
};

export interface TRPCRequestContextOptions {
  req: Request;
}

export interface TRPCContextDependencies {
  db: Database;
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
    return {
      db: dependencies.db,
      actor: resolveActor(Object.fromEntries(req.headers.entries())),
    };
  };
}

export function createTRPCContext(options: TRPCRequestContextOptions): Promise<TRPCContext> {
  return createTRPCContextFactory({
    db: getDb(),
  })(options);
}

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
