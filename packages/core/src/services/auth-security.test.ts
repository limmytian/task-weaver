import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthenticationError,
  AuthorizationError,
} from "@task-weaver/contracts";
import {
  createCsrfPolicy,
  guardAuthenticationOperations,
} from "./auth-security";

test("CSRF challenges are origin-bound, finite and reject tampered or duplicate cookies", () => {
  const csrf = createCsrfPolicy(
    "fixture-only-secret".repeat(3),
    ["https://app.example.test"],
    true,
  );
  const now = new Date();
  const challenge = csrf.challenge(now);
  const cookie = challenge.headers.getSetCookie()[0]!;
  assert.ok(cookie.includes("__Host-tw.csrf="));
  assert.ok(cookie.includes("Secure"));
  assert.ok(cookie.includes("HttpOnly"));
  assert.equal(cookie.includes("Domain="), false);
  const headers = new Headers({
    cookie: cookie.split(";")[0]!,
    origin: "https://app.example.test",
    "x-csrf-token": challenge.csrfToken,
  });
  csrf.assert(headers, now);
  assert.throws(
    () => csrf.assert(headers, new Date(now.getTime() + 3600001)),
    AuthorizationError,
  );
  assert.throws(
    () => csrf.assert(headers, new Date(now.getTime() - 1)),
    AuthorizationError,
  );
  const tampered = new Headers(headers);
  tampered.set("x-csrf-token", `${challenge.csrfToken.slice(0, -1)}x`);
  assert.throws(() => csrf.assert(tampered, now), AuthorizationError);
  const duplicated = new Headers(headers);
  duplicated.set(
    "cookie",
    `${headers.get("cookie")}; ${headers.get("cookie")}`,
  );
  assert.throws(() => csrf.assert(duplicated, now), AuthorizationError);
});

test("authentication boundaries redact unexpected provider/database errors while retaining safe domain errors", async () => {
  const secret = "fixture-query-password-secret";
  const safe = new AuthenticationError("invalid_credential");
  const operations = guardAuthenticationOperations({
    async provider() {
      throw new Error(`Failed query: ${secret}`);
    },
    async credential() {
      throw safe;
    },
    challenge() {
      return { headers: new Headers() };
    },
  });
  await assert.rejects(
    operations.provider(),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Authentication operation unavailable" &&
      !JSON.stringify(error).includes(secret),
  );
  await assert.rejects(
    operations.credential(),
    (error: unknown) => error === safe,
  );
  assert.ok(operations.challenge().headers instanceof Headers);
});
