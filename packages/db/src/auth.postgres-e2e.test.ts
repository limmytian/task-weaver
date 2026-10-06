import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, runMigrations } from "./client";
import {
  authAccounts,
  authActivations,
  authActors,
  authInstanceState,
  authSessions,
  authUsers,
  projectMemberships,
  projects,
  apiKeys,
  webhooks,
} from "./schema/index";

const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;
test(
  "identity migrations support empty and legacy databases without granting legacy ownership",
  { skip: !databaseUrl, timeout: 60_000 },
  async (t) => {
    const url = new URL(databaseUrl!);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(
      url.pathname,
      "/tw_auth_e2e",
      "Use only the disposable authentication database",
    );
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    const db = createDb(databaseUrl!);
    t.after(() => db.$client.end());
    assert.equal(
      (await db.select().from(authInstanceState))[0]!.initializedByUserId,
      null,
    );
    assert.equal(
      (await db.select().from(authUsers)).length,
      0,
      "No bootstrap identity or secret is seeded",
    );
    // Rehearse an upgrade from the exact journal preceding the additive identity migration.
    await db.execute(sql`DROP SCHEMA task_weaver CASCADE`);
    await db.execute(sql`CREATE SCHEMA task_weaver`);
    const folder = await mkdtemp(join(tmpdir(), "tw-auth-migrations-"));
    t.after(() => rm(folder, { recursive: true, force: true }));
    await cp(fileURLToPath(new URL("../drizzle/", import.meta.url)), folder, {
      recursive: true,
    });
    const journalPath = join(folder, "meta/_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.entries = journal.entries.filter(
      (entry: { idx: number }) => entry.idx < 48,
    );
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(db, {
      migrationsFolder: folder,
      migrationsSchema: "task_weaver",
      migrationsTable: "__drizzle_migrations",
    });
    const [legacyProject] = await db
      .insert(projects)
      .values({ name: "Legacy", createdBy: "unmapped-human" })
      .returning();
    // Use the pre-upgrade columns explicitly; later API-key additions must leave these values intact.
    await db.execute(
      sql`INSERT INTO task_weaver.api_keys (name, key_hash, key_prefix) VALUES ('legacy', ${"a".repeat(64)}, 'tw_legacy')`,
    );
    await db.execute(sql`INSERT INTO task_weaver.webhooks (project_id, url, events, secret, active) VALUES (${legacyProject!.id}, 'https://legacy.example.test', '["task.created"]'::jsonb, 'legacy-fixture-secret-only', true)`);
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    assert.equal(
      (
        await db
          .select()
          .from(projects)
          .where(eq(projects.id, legacyProject!.id))
      )[0]!.createdBy,
      "unmapped-human",
    );
    assert.equal((await db.select().from(apiKeys))[0]!.keyHash, "a".repeat(64));
    const [legacyHook] = await db.select().from(webhooks);
    assert.equal(legacyHook!.active, false);
    assert.equal(legacyHook!.ownerActorId, null);
    assert.equal(legacyHook!.bindingId, null);
    assert.equal((await db.select().from(projectMemberships)).length, 0);
    assert.equal((await db.select().from(authActors)).length, 0);

    const [human] = await db
      .insert(authActors)
      .values({ type: "human", displayName: "Administrator", status: "active" })
      .returning();
    const [user] = await db
      .insert(authUsers)
      .values({
        actorId: human!.id,
        name: "Administrator",
        email: "Admin@example.test",
        status: "active",
        instanceRole: "admin",
      })
      .returning();
    await db
      .update(authInstanceState)
      .set({ initializedByUserId: user!.id, initializedAt: new Date() });
    const [agent] = await db
      .insert(authActors)
      .values({
        type: "agent",
        displayName: "Managed agent",
        managedByActorId: human!.id,
        managedByActorType: "human",
        status: "active",
      })
      .returning();
    await assert.rejects(
      db.insert(authActors).values({ type: "agent", displayName: "Unmanaged" }),
    );
    await assert.rejects(
      db
        .insert(authActors)
        .values({
          type: "agent",
          displayName: "Agent manager",
          managedByActorId: agent!.id,
          managedByActorType: "human",
        }),
    );
    await assert.rejects(
      db
        .insert(authUsers)
        .values({
          actorId: agent!.id,
          name: "Agent account",
          email: "agent@example.test",
        }),
    );
    const [other] = await db
      .insert(authActors)
      .values({ type: "human", displayName: "Other" })
      .returning();
    await assert.rejects(
      db
        .insert(authUsers)
        .values({
          actorId: other!.id,
          name: "Duplicate",
          email: "admin@EXAMPLE.test",
        }),
    );
    await db
      .insert(authAccounts)
      .values({
        userId: user!.id,
        providerId: "credential",
        accountId: user!.id,
        password: "fixture-password-hash",
      });
    await assert.rejects(
      db
        .insert(authAccounts)
        .values({
          userId: user!.id,
          providerId: "credential",
          accountId: "duplicate",
          password: "fixture-password-hash",
        }),
    );
    await assert.rejects(
      db
        .insert(authAccounts)
        .values({
          userId: randomUUID(),
          providerId: "credential",
          accountId: "missing",
          password: "fixture-password-hash",
        }),
    );
    await db
      .insert(projectMemberships)
      .values({
        projectId: legacyProject!.id,
        actorId: human!.id,
        actorType: "human",
        role: "owner",
      });
    await assert.rejects(
      db
        .insert(projectMemberships)
        .values({
          projectId: legacyProject!.id,
          actorId: human!.id,
          actorType: "human",
          role: "member",
        }),
    );
    await assert.rejects(
      db
        .insert(projectMemberships)
        .values({
          projectId: randomUUID(),
          actorId: agent!.id,
          actorType: "agent",
          role: "member",
        }),
    );
    await assert.rejects(
      db
        .insert(projectMemberships)
        .values({
          projectId: legacyProject!.id,
          actorId: agent!.id,
          actorType: "agent",
          role: "owner",
        }),
    );
    await assert.rejects(
      db
        .insert(projectMemberships)
        .values({
          projectId: legacyProject!.id,
          actorId: agent!.id,
          actorType: "agent",
          role: "member",
          explicitPermissions: ["instance.manage"],
        }),
    );
    const now = new Date();
    const expiry = new Date(now.getTime() + 365 * 86_400_000);
    const [session] = await db
      .insert(authSessions)
      .values({
        userId: user!.id,
        token: randomUUID(),
        createdAt: now,
        expiresAt: expiry,
        absoluteExpiresAt: expiry,
        idleExpiresAt: expiry,
      })
      .returning();
    await assert.rejects(
      db
        .insert(authSessions)
        .values({
          userId: user!.id,
          token: randomUUID(),
          expiresAt: now,
          absoluteExpiresAt: new Date(0),
          idleExpiresAt: now,
        }),
    );
    await assert.rejects(
      db.execute(
        sql`INSERT INTO task_weaver.auth_sessions (user_id, token, expires_at, absolute_expires_at, idle_expires_at) VALUES (${user!.id}, ${randomUUID()}, 'infinity', 'infinity', 'infinity')`,
      ),
    );
    await db
      .update(authSessions)
      .set({ revokedAt: now })
      .where(eq(authSessions.id, session!.id));
    await db
      .insert(authActivations)
      .values({
        userId: user!.id,
        issuedByUserId: user!.id,
        tokenHash: "b".repeat(64),
        purpose: "recovery",
        expiresAt: expiry,
      });
    await db
      .update(authUsers)
      .set({ status: "disabled" })
      .where(eq(authUsers.id, user!.id));
    assert.equal(
      (
        await db.select().from(authActors).where(eq(authActors.id, agent!.id))
      )[0]!.managedByActorId,
      human!.id,
    );
    assert.equal(
      (
        await db
          .select()
          .from(authSessions)
          .where(eq(authSessions.id, session!.id))
      )[0]!.revokedAt!.getTime(),
      now.getTime(),
    );
    await assert.rejects(
      db.delete(authActors).where(eq(authActors.id, human!.id)),
    );
    await assert.rejects(
      db.delete(authUsers).where(eq(authUsers.id, user!.id)),
    );
    const columns = await db.execute(
      sql`SELECT data_type FROM information_schema.columns WHERE table_schema = 'task_weaver' AND table_name LIKE 'auth_%' AND column_name LIKE '%_at'`,
    );
    assert.ok(columns.length > 10);
    assert.ok(
      columns.every(
        (column) => column.data_type === "timestamp with time zone",
      ),
    );
  },
);
