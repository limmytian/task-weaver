import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  takeAuthenticationResult,
  transferProjectOwnershipSchema,
} from "@task-weaver/core";
import type { Env } from "../middleware/actor.js";

const auth = new Hono<Env>();
auth.use("*", bodyLimit({ maxSize: 32_768 }));
/** Direct socket metadata only. Forwarded headers are not a trusted proxy policy. */
function clientAddress(c: Context<Env>) {
  try {
    return getConnInfo(c).remote.address ?? "unavailable";
  } catch {
    return "unavailable";
  }
}
async function send(c: Context<Env>, result: unknown, status: 200 | 201 = 200) {
  const headers = new Headers({ "cache-control": "no-store" });
  const body = takeAuthenticationResult(result, headers);
  for (const [name, value] of headers)
    if (name !== "set-cookie") c.header(name, value);
  for (const cookie of headers.getSetCookie())
    c.header("set-cookie", cookie, { append: true });
  return c.json(body, status);
}
const service = (c: Context<Env>) => c.get("auth").authentication;
const identity = (c: Context<Env>) => c.get("auth").identity;
const headers = (c: Context<Env>) => c.req.raw.headers;

auth.get("/csrf", (c) => send(c, service(c).csrfChallenge(headers(c))));
auth.post("/bootstrap", async (c) =>
  send(
    c,
    await service(c).bootstrap(
      headers(c),
      await c.req.json(),
      clientAddress(c),
    ),
    201,
  ),
);
auth.post("/login", async (c) =>
  send(
    c,
    await service(c).login(headers(c), await c.req.json(), clientAddress(c)),
  ),
);
auth.post("/activate", async (c) =>
  send(
    c,
    await service(c).activate(headers(c), await c.req.json(), clientAddress(c)),
  ),
);
auth.get("/me", async (c) => send(c, await service(c).current(headers(c))));
auth.post("/logout", async (c) => send(c, await service(c).logout(headers(c))));
auth.post("/reauthenticate", async (c) =>
  send(
    c,
    await service(c).reauthenticate(
      headers(c),
      await c.req.json(),
      clientAddress(c),
    ),
  ),
);
auth.post("/password", async (c) =>
  send(
    c,
    await service(c).changePassword(
      headers(c),
      await c.req.json(),
      clientAddress(c),
    ),
  ),
);
auth.get("/sessions", async (c) =>
  send(c, await service(c).listSessions(headers(c))),
);
auth.delete("/sessions/:id", async (c) =>
  send(c, await service(c).revokeSession(headers(c), c.req.param("id"))),
);
auth.get("/accounts", async (c) =>
  send(c, await service(c).listAccounts(headers(c))),
);
auth.post("/accounts", async (c) =>
  send(c, await service(c).provision(headers(c), await c.req.json()), 201),
);
auth.post("/accounts/:id/recover", async (c) =>
  send(c, await service(c).recover(headers(c), c.req.param("id"))),
);
auth.patch("/accounts/:id", async (c) =>
  send(
    c,
    await service(c).setAccountState(
      headers(c),
      c.req.param("id"),
      await c.req.json(),
    ),
  ),
);
auth.get("/agents", async (c) =>
  send(c, await identity(c).listAgents(headers(c))),
);
auth.post("/agents", async (c) =>
  send(c, await identity(c).createAgent(headers(c), await c.req.json()), 201),
);
auth.delete("/agents/:id", async (c) =>
  send(c, await identity(c).disableAgent(headers(c), c.req.param("id"))),
);
auth.delete("/admin/agents/:id", async (c) =>
  send(
    c,
    await identity(c).disableAgentAsAdministrator(
      headers(c),
      c.req.param("id"),
    ),
  ),
);
auth.post("/projects", async (c) =>
  send(c, await identity(c).createProject(headers(c), await c.req.json()), 201),
);
auth.get("/projects/:id/members", async (c) =>
  send(c, await identity(c).listMemberships(headers(c), c.req.param("id"))),
);
auth.put("/projects/:id/members/:actorId", async (c) =>
  send(
    c,
    await identity(c).setMembership(
      headers(c),
      c.req.param("id"),
      c.req.param("actorId"),
      await c.req.json(),
    ),
  ),
);
auth.delete("/projects/:id/members/:actorId", async (c) =>
  send(
    c,
    await identity(c).removeMembership(
      headers(c),
      c.req.param("id"),
      c.req.param("actorId"),
    ),
  ),
);
auth.post("/projects/:id/owner", async (c) => {
  const input: unknown = await c.req.json();
  const parsed = transferProjectOwnershipSchema.parse(input);
  return send(
    c,
    await identity(c).transferOwnership(
      headers(c),
      c.req.param("id"),
      parsed.actorId,
    ),
  );
});
export default auth;
