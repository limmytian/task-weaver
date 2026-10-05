/**
 * GraphQL endpoint for Task Weaver.
 *
 * Mounts graphql-yoga on Hono at /api/v1/graphql.
 * Verified context is propagated to every resolver; interactive playgrounds are disabled.
 */
import { Hono } from "hono";
import { createYoga } from "graphql-yoga";
import { schema, type GraphQLContext } from "./schema.js";
import type { Env } from "../middleware/actor.js";

const yoga = createYoga<GraphQLContext>({
  schema,
  graphiql: false,
  landingPage: false,
});

const graphqlRouter = new Hono<Env>();

graphqlRouter.all("/*", async (c) => {
  const db = c.get("db");
  const response = await yoga.handle(c.req.raw, {
    db,
    auth: c.get("auth"),
    headers: c.req.raw.headers,
    identity: c.get("identity"),
  });
  return response;
});

export default graphqlRouter;
