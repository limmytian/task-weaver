import assert from "node:assert/strict";
import test from "node:test";
import { encryptChatKey, decryptChatKey } from "./chat-credentials";
import { chatEndpoint } from "./chat-endpoint";

test("encrypted Chat keys are randomized and authenticated to the owner and model", t => {
  const prior = process.env.TW_CHAT_CREDENTIAL_MASTER_KEY;
  process.env.TW_CHAT_CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  t.after(() => { if (prior === undefined) delete process.env.TW_CHAT_CREDENTIAL_MASTER_KEY; else process.env.TW_CHAT_CREDENTIAL_MASTER_KEY = prior; });
  const binding = "owner:fixture-model";
  const first = encryptChatKey("fixture-secret", binding);
  assert.notEqual(first, encryptChatKey("fixture-secret", binding));
  assert.equal(decryptChatKey(first, binding), "fixture-secret");
  assert.throws(() => decryptChatKey(first, "another-owner"));
  const pieces = first.split(".");
  pieces[3] = Buffer.alloc(16).toString("base64url");
  assert.throws(() => decryptChatKey(pieces.join("."), binding));
  assert.throws(() => decryptChatKey(null, binding), /key re-entry/);
});

test("Chat endpoints support local HTTP and custom ports while rejecting credential-bearing URLs", () => {
  for (const url of ["ftp://example.com", "https://user:secret@example.com", "https://example.com?token=secret", "https://example.com#secret"]) assert.throws(() => chatEndpoint(url));
  assert.equal(chatEndpoint("https://api.siliconflow.cn/v1/").href, "https://api.siliconflow.cn/v1/chat/completions");
  assert.equal(chatEndpoint("http://192.168.1.246:11434/v1").href, "http://192.168.1.246:11434/v1/chat/completions");
  assert.equal(chatEndpoint("http://[::1]:11434/v1").port, "11434");
  assert.equal(chatEndpoint("https://model.example.test:8443/v1").port, "8443");
});
