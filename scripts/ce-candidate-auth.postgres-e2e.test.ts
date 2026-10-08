import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { authInstanceState, createDb, runMigrations } from "@task-weaver/db";
import { createApiApplication } from "../apps/api/src/application";
import { createCandidateSession } from "./ce-candidate-auth.mjs";

const databaseUrl = process.env.TW_AUTH_E2E_DATABASE_URL;
test("binary candidate smoke uses real authentication, CSRF and logout", {
  skip: !databaseUrl, timeout: 60_000,
}, async (t) => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/tw_ce_candidate_e2e");
  await runMigrations(databaseUrl!);
  const db = createDb(databaseUrl!);
  t.after(() => db.$client.end());
  await db.update(authInstanceState).set({ initializedByUserId: null, initializedAt: null })
    .where(eq(authInstanceState.id, "instance"));
  const origin = "http://127.0.0.1:3001";
  const bootstrapSecret = randomBytes(32).toString("hex");
  const app = createApiApplication({ db, databaseUrl: databaseUrl!, env: {
    TW_AUTH_SECRET: randomBytes(32).toString("hex"),
    TW_AUTH_BOOTSTRAP_SECRET: bootstrapSecret,
    TW_AUTH_BASE_URL: origin, TW_AUTH_TRUSTED_ORIGINS: origin,
    TW_PRESET_SKILLS_SYNC: "disabled",
  } }).app;
  for (const headers of [{}, { "x-actor-id": "candidate-forged", "x-actor-type": "agent" }]) {
    assert.equal((await app.request("/api/v1/projects", { headers })).status, 401);
  }
  const session = await createCandidateSession(origin, origin, bootstrapSecret,
    (input: string, init: RequestInit) => app.request(new Request(input, init)));
  const project = await session.request("/auth/projects", { name: "Authenticated candidate" });
  const requirement = await session.request(`/projects/${project.id}/requirements`, { title: "Candidate requirement" });
  const task = await session.request(`/projects/${project.id}/tasks`, { title: "Candidate task", requirementId: requirement.id });
  for (const [kind, entity] of [["projects", project], ["requirements", requirement], ["tasks", task]] as const) {
    assert.equal((await session.request(`/${kind}/${entity.id}`)).id, entity.id);
  }
  await session.logout();
  await assert.rejects(session.request(`/projects/${project.id}`), /\(401\)/);
});
