import assert from "node:assert/strict";
import test from "node:test";
import { GraphQLError, type GraphQLObjectType } from "graphql";
import { AuthenticationError } from "@task-weaver/core";
import { schema, type GraphQLContext } from "./schema";

test("GraphQL explicit and default nested resolvers cannot trust a supplied actor or cached identity", async () => {
  const stale = {
    headers: new Headers(),
    identity: { actor: { id: "forged", type: "human" } },
    auth: {
      assertOrigin() {},
      verify: async () => {
        throw new AuthenticationError("credential_revoked");
      },
    },
  } as unknown as GraphQLContext;
  for (const [type, field] of [
    ["Query", "project"],
    ["Project", "name"],
    ["Project", "tasks"],
    ["Task", "title"],
    ["DocumentTaskLink", "document"],
    ["AuthenticatedActor", "id"],
  ]) {
    const object = schema.getType(type!) as GraphQLObjectType;
    const resolver = object.getFields()[field!]!.resolve!;
    await assert.rejects(
      async () =>
        resolver(
          { id: "private", name: "private", title: "private" },
          {},
          stale,
          {} as never,
        ),
      (error: unknown) => {
        assert.ok(error instanceof GraphQLError);
        assert.equal(error.message, "Authentication required");
        assert.equal(error.extensions.code, "credential_revoked");
        return true;
      },
    );
  }
});
