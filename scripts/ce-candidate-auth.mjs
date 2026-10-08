import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Authenticate only the disposable candidate instance through public account APIs. */
export async function createCandidateSession(apiUrl, origin, bootstrapSecret, transport = fetch) {
  const cookies = new Map();
  const remember = (response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const index = pair.indexOf("=");
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  };
  const headers = () => new Headers({
    origin,
    "content-type": "application/json",
    cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
  });
  async function request(path, body) {
    const requestHeaders = headers();
    if (body !== undefined) {
      const challenge = await transport(`${apiUrl}/api/v1/auth/csrf`, { headers: requestHeaders });
      assert.ok(challenge.ok, "Candidate CSRF challenge failed");
      remember(challenge);
      const csrf = await challenge.json();
      requestHeaders.set("cookie", headers().get("cookie"));
      requestHeaders.set("x-csrf-token", csrf.csrfToken);
    }
    const response = await transport(`${apiUrl}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST", headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok(response.ok, `Authenticated candidate request failed: ${path} (${response.status})`);
    remember(response);
    return response.json();
  }
  const email = `${randomUUID()}@example.test`;
  const password = `${randomUUID()}Aa1!`;
  await request("/auth/bootstrap", { email, password, displayName: "Candidate fixture", bootstrapSecret });
  await request("/auth/login", { email, password });
  return { request, logout: () => request("/auth/logout", {}) };
}
