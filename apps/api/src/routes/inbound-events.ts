import { Hono } from "hono";
import { createInboundSourceService, acceptInboundEvent, createInboundSourceSchema, updateInboundSourceSchema, listInboundEventsSchema, ValidationError, InboundRateLimitError } from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const routes = new Hono<Env>();
routes.post("/events/:sourceId", async c => {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new ValidationError("An inbound body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65_536) { await reader.cancel(); return c.json({ error: "Inbound body too large" }, 413); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks);
  try { return c.json(await acceptInboundEvent(c.get("db"), c.req.param("sourceId"), body, c.req.raw.headers), 202); }
  catch (error) { if (error instanceof InboundRateLimitError) { c.header("retry-after", "60"); return c.json({ error: error.message }, 429); } throw error; }
});
routes.get("/sources", async c => {
  const projectId = c.req.query("projectId");
  if (!projectId) throw new ValidationError("A project is required");
  return c.json(await createInboundSourceService(c.get("identity")).list(c.get("db"), projectId));
});
routes.post("/sources", async c => {
  const input = createInboundSourceSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Validation error", details: input.error.flatten() }, 400);
  return c.json(await createInboundSourceService(c.get("identity")).create(c.get("db"), input.data), 201);
});
routes.patch("/sources/:id", async c => {
  const input = updateInboundSourceSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Validation error", details: input.error.flatten() }, 400);
  return c.json(await createInboundSourceService(c.get("identity")).update(c.get("db"), c.req.param("id"), input.data));
});
routes.delete("/sources/:id", async c => c.json(await createInboundSourceService(c.get("identity")).delete(c.get("db"), c.req.param("id"))));
routes.get("/sources/:id/events", async c => {
  const input = listInboundEventsSchema.safeParse(c.req.query());
  if (!input.success) return c.json({ error: "Validation error", details: input.error.flatten() }, 400);
  return c.json(await createInboundSourceService(c.get("identity")).history(c.get("db"), c.req.param("id"), input.data));
});
routes.get("/sources/:id/events/:eventId/actions", async c => {
  return c.json(await createInboundSourceService(c.get("identity")).receipts(c.get("db"), c.req.param("id"), c.req.param("eventId")));
});
routes.post("/sources/:id/events/:eventId/retry", async c => {
  return c.json(await createInboundSourceService(c.get("identity")).retry(c.get("db"), c.req.param("id"), c.req.param("eventId")));
});
export default routes;
