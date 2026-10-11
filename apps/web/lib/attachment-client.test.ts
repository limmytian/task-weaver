import assert from "node:assert/strict";
import test from "node:test";
import { uploadAttachment } from "./attachment-client";

test("Web attachments send original bytes with CSRF and concurrency metadata without automatic replay", async () => {
  const previous = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return String(url) === "/api/auth/csrf" ? Response.json({ csrfToken: "fixture" }) : Response.json({ error: "Document version changed" }, { status: 409 });
  };
  try {
    const file = new File(["Original bytes"], "original.txt", { type: "text/plain" });
    await assert.rejects(uploadAttachment(file, { originalFilename: file.name, mimeType: file.type, expectedVersion: 7 }, "fixture-id"), /version changed/);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url, "/api/attachments/fixture-id");
    assert.equal(calls[1]!.options?.method, "PUT");
    assert.equal(calls[1]!.options?.body, file);
    assert.equal(calls[1]!.options?.credentials, "same-origin");
    const headers = new Headers(calls[1]!.options?.headers);
    assert.equal(headers.get("x-csrf-token"), "fixture");
    assert.equal(JSON.parse(decodeURIComponent(headers.get("x-tw-attachment-metadata")!)).expectedVersion, 7);
  } finally { globalThis.fetch = previous; }
});
