import { Hono } from "hono";
import { versionChecker } from "@task-weaver/core";

const versionRoutes = new Hono();
versionRoutes.get("/", c => c.json(versionChecker.info()));
versionRoutes.post("/check", async c => c.json(await versionChecker.check()));
export default versionRoutes;
