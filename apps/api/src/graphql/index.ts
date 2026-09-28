/**
 * GraphQL endpoint for Task Weaver.
 *
 * Mounts graphql-yoga on Hono at /api/v1/graphql.
 * Includes GraphiQL playground in non-production environments.
 */
import { Hono } from "hono";
import { createYoga } from "graphql-yoga";
import { schema, type GraphQLContext } from "./schema.js";
import type { Env } from "../middleware/actor.js";

const yoga = createYoga<GraphQLContext>({
  schema,
  graphiql: process.env.NODE_ENV !== "production",
  // Disable landing page in production
  landingPage: process.env.NODE_ENV !== "production",
});

const graphqlRouter = new Hono<Env>();

graphqlRouter.all("/*", async (c) => {
  const db = c.get("db");
  const response = await yoga.handle(c.req.raw, { db });
  return response;
});

export default graphqlRouter;
