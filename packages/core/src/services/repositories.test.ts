import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { repositories, type Database } from "@task-weaver/db";
import {
  createRepositorySchema,
  repositoryAuthPolicySchema,
  syncRequirementRepositoryForgeStateSchema,
} from "@task-weaver/contracts";
import {
  deliveryIdentityPhase,
  aggregateRequirementDelivery,
  listRepositories,
  normalizeRepositoryCoordinates,
  requirementStatusForRetryPhase,
} from "./repositories";

function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(sqlText).join("");
  if (!value || typeof value !== "object") return "";

  const chunk = value as { queryChunks?: unknown[]; value?: unknown };
  if (chunk.queryChunks) return chunk.queryChunks.map(sqlText).join("");
  if (Array.isArray(chunk.value) && chunk.value.every((item) => typeof item === "string")) {
    return chunk.value.join("");
  }
  return "";
}

class FakeRepositoryListDb {
  orderByValues: unknown[] = [];
  private selectCalls = 0;

  select() {
    this.selectCalls += 1;
    if (this.selectCalls === 1) {
      return {
        from: (table: unknown) => {
          assert.equal(table, repositories);
          return {
            where: () => ({
              orderBy: (...values: unknown[]) => {
                this.orderByValues = values;
                return {
                  limit: () => ({
                    offset: async () => [],
                  }),
                };
              },
            }),
          };
        },
      };
    }

    return {
      from: (table: unknown) => {
        assert.equal(table, repositories);
        return {
          where: async () => [{ count: 0 }],
        };
      },
    };
  }
}

test("repository coordinates normalize equivalent identity forms", () => {
  assert.deepEqual(
    normalizeRepositoryCoordinates({
      host: "HTTPS://GitHub.com:443/",
      namespace: "/OpenAI/Task-Weaver/",
      name: "Service.git",
    }),
    {
      host: "github.com",
      namespace: "openai/task-weaver",
      name: "service",
      canonicalKey: "github.com/openai/task-weaver/service",
    },
  );
});

test("repository coordinates reject path traversal and credentials", () => {
  assert.throws(() => normalizeRepositoryCoordinates({
    host: "user@example.com",
    namespace: "openai",
    name: "service",
  }), /without credentials/);
  assert.throws(() => normalizeRepositoryCoordinates({
    host: "example.com",
    namespace: "openai/../private",
    name: "service",
  }), /safe path segments/);
});

test("repository schema rejects secret-bearing endpoints and policies", () => {
  const endpoint = createRepositorySchema.safeParse({
    host: "example.com",
    namespace: "openai",
    name: "service",
    httpsCloneUrl: "https://user:password@example.com/openai/service.git",
  });
  assert.equal(endpoint.success, false);

  const policy = repositoryAuthPolicySchema.safeParse({
    allowedTransports: ["https"],
    token: "secret",
  });
  assert.equal(policy.success, false);
});

test("repository visibility requires an owner only for restricted metadata", () => {
  assert.equal(createRepositorySchema.safeParse({
    host: "example.com",
    namespace: "openai",
    name: "service",
    visibility: "restricted",
  }).success, false);
  assert.equal(createRepositorySchema.safeParse({
    host: "example.com",
    namespace: "openai",
    name: "service",
    visibility: "restricted",
    ownerId: "owner-1",
    ownerType: "human",
  }).success, true);
});

test("repository relevance sorting without a query avoids an ordinal zero ORDER BY", async () => {
  const db = new FakeRepositoryListDb();

  const result = await listRepositories(db as unknown as Database, {
    sort: "relevance",
    page: 1,
    pageSize: 25,
  }, {
    id: "test-actor",
    type: "human",
  });

  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);
  assert.equal(db.orderByValues.length, 3);
  assert.match(sqlText(db.orderByValues[0]), /requirement_repositories/);
  assert.doesNotMatch(sqlText(db.orderByValues), /\b0\s+desc\b/i);
});

test("delivery aggregation preserves partial success", () => {
  assert.equal(aggregateRequirementDelivery([]), "none");
  assert.equal(aggregateRequirementDelivery([{ deliveryStatus: "pending" }]), "pending");
  assert.equal(aggregateRequirementDelivery([{ deliveryStatus: "failed" }]), "failed");
  assert.equal(aggregateRequirementDelivery([
    { deliveryStatus: "merged" },
    { deliveryStatus: "failed" },
  ]), "partial");
  assert.equal(aggregateRequirementDelivery([
    { deliveryStatus: "merged" },
    { deliveryStatus: "unchanged" },
  ]), "complete");
});

test("repository retry phases wake exactly one matching requirement queue", () => {
  assert.equal(requirementStatusForRetryPhase("execution"), "in_progress");
  assert.equal(requirementStatusForRetryPhase("review"), "in_review");
  assert.equal(requirementStatusForRetryPhase("merge"), "ready_to_merge");
});

test("delivery identity attribution follows the durable pipeline phase", () => {
  assert.equal(deliveryIdentityPhase({ deliveryStatus: "pushing", pushStatus: "pushing" }), "execution");
  assert.equal(deliveryIdentityPhase({ deliveryStatus: "in_review", reviewStatus: "in_review" }), "review");
  assert.equal(deliveryIdentityPhase({
    deliveryStatus: "ready_to_merge",
    reviewStatus: "approved",
    mergeStatus: "ready",
  }), "review");
  assert.equal(deliveryIdentityPhase({ deliveryStatus: "merged", mergeStatus: "merged" }), "merge");
  assert.equal(deliveryIdentityPhase({}), null);
});

test("forge delivery migration persists merge routing and idempotent external state", () => {
  const migration = readFileSync(
    new URL("../../../db/drizzle/0041_forge_delivery_state.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /"merge_mode" text/);
  assert.match(migration, /"manual_action_url" text/);
  assert.match(migration, /"external_state" jsonb DEFAULT '\{\}'::jsonb NOT NULL/);
  assert.match(migration, /"external_sync_revision" integer DEFAULT 0 NOT NULL/);
  assert.match(migration, /idx_requirement_repositories_manual_merge/);
});

test("forge sync schema requires a normalized snapshot and idempotency key", () => {
  const valid = syncRequirementRepositoryForgeStateSchema.safeParse({
    snapshot: {
      provider: "github",
      externalId: "12",
      url: "https://github.com/acme/app/pull/12",
      state: "open",
      headCommit: "aaaaaaaa",
      baseCommit: "bbbbbbbb",
      mergeable: true,
      mergeState: "clean",
      checks: [{ name: "test", state: "passed" }],
      approvals: [{ actorId: "reviewer", state: "approved", headCommit: "aaaaaaaa" }],
    },
    idempotencyKey: "github:12:snapshot-a",
    expectedRevision: 0,
  });
  assert.equal(valid.success, true);
  assert.equal(syncRequirementRepositoryForgeStateSchema.safeParse({
    snapshot: { provider: "github" },
    idempotencyKey: "",
  }).success, false);
});
