import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { createDb, type Database } from "@task-weaver/db";
import type { Actor } from "@task-weaver/core";

export type TRPCContext = {
  db: Database;
  actor: Actor;
};

let db: Database | null = null;

function getDb(): Database {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    db = createDb(url);
  }
  return db;
}

export function createTRPCContext(): TRPCContext {
  return {
    db: getDb(),
    actor: { id: "web-user", type: "human" },
  };
}

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
