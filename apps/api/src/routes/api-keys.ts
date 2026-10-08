import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  issueOwnedApiKeySchema,
  updateApiKeyGrantsSchema,
  keyGrantOptionsSchema,
  credentialSubjectSchema,
  takeAuthenticationResult,
} from "@task-weaver/core";
import { z } from "zod";
import type { Env } from "../middleware/actor.js";

const apiKeys = new Hono<Env>();
apiKeys.use("*", bodyLimit({ maxSize: 32_768 }));
const query = credentialSubjectSchema;
const issue = issueOwnedApiKeySchema;
apiKeys.get("/", async (c) => {
  const { actorId } = query.parse(c.req.query());
  return c.json(
    await c
      .get("auth")
      .identity.listKeys(
        c.req.raw.headers,
        actorId ?? c.get("identity").actor.id,
      ),
  );
});
apiKeys.get("/summaries", async c => c.json(await c.get("auth").identity.keySummaries(c.req.raw.headers, keyGrantOptionsSchema.parse(c.req.query()))));
apiKeys.get("/grant-options", async c => c.json(await c.get("auth").identity.pagedKeyGrantOptions(c.req.raw.headers, keyGrantOptionsSchema.parse(c.req.query()))));
apiKeys.get("/:id", async c => {
  const { actorId } = query.parse(c.req.query());
  return c.json(await c.get("auth").identity.keyDetail(c.req.raw.headers, actorId ?? c.get("identity").actor.id, c.req.param("id")));
});
apiKeys.patch("/:id/grants", async c => {
  const { actorId } = query.parse(c.req.query());
  return c.json(await c.get("auth").identity.updateKeyGrants(c.req.raw.headers, actorId ?? c.get("identity").actor.id, c.req.param("id"), updateApiKeyGrantsSchema.parse(await c.req.json())));
});
apiKeys.post("/", async (c) => {
  const { actorId, ...input } = issue.parse(await c.req.json());
  const result = await c
    .get("auth")
    .identity.issueKey(
      c.req.raw.headers,
      actorId ?? c.get("identity").actor.id,
      input,
    );
  return c.json(takeAuthenticationResult(result, new Headers()), 201);
});
apiKeys.post("/:id/rotate", async (c) => {
  const { actorId } = query.parse(c.req.query());
  // Rotation preserves grants and expiry; changes require explicit issuance rather than silent widening.
  z.object({})
    .strict()
    .parse(await c.req.json());
  const result = await c
    .get("auth")
    .identity.rotateKey(
      c.req.raw.headers,
      actorId ?? c.get("identity").actor.id,
      c.req.param("id"),
    );
  return c.json(takeAuthenticationResult(result, new Headers()));
});
apiKeys.delete("/:id", async (c) => {
  const { actorId } = query.parse(c.req.query());
  return c.json(
    await c
      .get("auth")
      .identity.revokeKey(
        c.req.raw.headers,
        actorId ?? c.get("identity").actor.id,
        c.req.param("id"),
      ),
  );
});
export default apiKeys;
