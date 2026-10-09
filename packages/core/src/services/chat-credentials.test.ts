import assert from "node:assert/strict";
import test from "node:test";
import { encryptChatKey, decryptChatKey } from "./chat-credentials";
import { chatEndpoint, isPublicChatAddress } from "./chat-endpoint";

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

test("Chat endpoints reject private addresses and credential-bearing URLs", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2002:7f00:1::"]) assert.equal(isPublicChatAddress(ip), false, ip);
  assert.equal(isPublicChatAddress("8.8.8.8"), true);
  assert.equal(isPublicChatAddress("2606:4700:4700::1111"), true);
  for (const url of ["http://example.com", "https://127.0.0.1", "https://user:secret@example.com", "https://example.com:8443", "https://example.com?token=secret", "https://example.com#secret"]) assert.throws(() => chatEndpoint(url));
  assert.equal(chatEndpoint("https://api.siliconflow.cn/v1/").href, "https://api.siliconflow.cn/v1/chat/completions");
});
