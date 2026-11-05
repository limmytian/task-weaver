import { Hono } from "hono";
import { z } from "zod";
import { replayDurableEvents, acknowledgeDurableEvents, getDurableEventCheckpoint, eventCursorSchema } from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const routes = new Hono<Env>();
const projectId = z.string().uuid();
const consumer = z.string().trim().min(1).max(200);
const list = z.object({ projectId, cursor: eventCursorSchema.default("0"), limit: z.coerce.number().int().min(1).max(500).default(100) }).strict();
const checkpoint = z.object({ projectId, consumer }).strict();
const ack = checkpoint.extend({ cursor: eventCursorSchema }).strict();
routes.get("/", async c => {
  const input = list.safeParse(c.req.query());
  if (!input.success) return c.json({ error: "Invalid event query" }, 400);
  return c.json(await replayDurableEvents(c.get("db"), input.data, c.get("identity")));
});
routes.get("/checkpoint", async c => {
  const input = checkpoint.safeParse(c.req.query());
  if (!input.success) return c.json({ error: "Invalid checkpoint query" }, 400);
  return c.json(await getDurableEventCheckpoint(c.get("db"), input.data, c.get("identity")));
});
routes.post("/ack", async c => {
  const input = ack.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid acknowledgment" }, 400);
  return c.json(await acknowledgeDurableEvents(c.get("db"), input.data, c.get("identity")));
});
export default routes;
