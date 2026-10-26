import assert from "node:assert/strict";
import { test } from "node:test";
import { isOrdinaryResourceRoute } from "./middleware/resource-routes";

test("bounded Board is an explicit read route, not a broader route exemption", () => {
  const path = "/api/v1/projects/00000000-0000-4000-8000-000000000001/board-page";
  assert.equal(isOrdinaryResourceRoute("GET", path), true);
  for (const method of ["POST", "PATCH", "DELETE"]) assert.equal(isOrdinaryResourceRoute(method, path), false);
  assert.equal(isOrdinaryResourceRoute("GET", `${path}/unregistered`), false);
});
