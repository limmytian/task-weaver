import { Hono } from "hono";
import { z } from "zod";
import { replayDurableEvents, acknowledgeDurableEvents, getDurableEventCheckpoint, acquireDurableConsumerLease, renewDurableConsumerLease, acknowledgeDurableEventsFenced, recordEventCursorIncident, inspectEventCursorIncidents, resolveEventCursorIncident, eventCursorSchema } from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const routes = new Hono<Env>();
const projectId = z.string().uuid();
const consumer = z.string().trim().min(1).max(200);
const list = z.object({ projectId, cursor: eventCursorSchema.default("0"), limit: z.coerce.number().int().min(1).max(500).default(100) }).strict();
const checkpoint = z.object({ projectId, consumer }).strict();
const ack = checkpoint.extend({ cursor: eventCursorSchema }).strict();
const lease = checkpoint.extend({ owner: z.string().uuid(), durationMs: z.number().int().min(1000).max(300000) }).strict();
const fence = checkpoint.extend({ owner: z.string().uuid(), generation: eventCursorSchema }).strict();
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
// Lease operations are separate from execution authority and scoped to the authenticated principal.
routes.post("/lease/acquire", async c => {
  const input = lease.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid consumer lease" }, 400);
  return c.json(await acquireDurableConsumerLease(c.get("db"), input.data, c.get("identity")));
});
routes.post("/lease/renew", async c => {
  const input = lease.extend({ generation: eventCursorSchema }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid consumer lease" }, 400);
  return c.json(await renewDurableConsumerLease(c.get("db"), input.data, c.get("identity")));
});
routes.post("/ack/fenced", async c => {
  const input = fence.extend({ cursor: eventCursorSchema }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid acknowledgment" }, 400);
  return c.json(await acknowledgeDurableEventsFenced(c.get("db"), input.data, c.get("identity")));
});
// Incidents are scoped to the authenticated principal and project; recording requires a live lease.
routes.get("/incidents", async c => {
  const input = z.object({ projectId }).strict().safeParse(c.req.query());
  if (!input.success) return c.json({ error: "Invalid incident query" }, 400);
  return c.json(await inspectEventCursorIncidents(c.get("db"), input.data, c.get("identity")));
});
routes.post("/incidents", async c => {
  const input = fence.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid incident" }, 400);
  return c.json(await recordEventCursorIncident(c.get("db"), input.data, c.get("identity")));
});
routes.post("/incidents/resolve", async c => {
  const input = z.object({ projectId, incidentId: z.string().uuid() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid incident resolution" }, 400);
  return c.json(await resolveEventCursorIncident(c.get("db"), input.data, c.get("identity")));
});
routes.post("/ack", async c => {
  const input = ack.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid acknowledgment" }, 400);
  return c.json(await acknowledgeDurableEvents(c.get("db"), input.data, c.get("identity")));
});
export default routes;
