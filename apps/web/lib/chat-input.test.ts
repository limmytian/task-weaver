import assert from "node:assert/strict";
import test from "node:test";
import { shouldSendChatMessage } from "./chat-input";

test("Enter sends while Shift+Enter and IME candidate confirmation retain the draft", () => {
  const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
  assert.equal(shouldSendChatMessage(enter, false), true);
  assert.equal(shouldSendChatMessage({ ...enter, shiftKey: true }, false), false);
  assert.equal(shouldSendChatMessage({ ...enter, isComposing: true }, false), false);
  // WebKit can clear isComposing before delivering the composition-confirming key.
  assert.equal(shouldSendChatMessage({ ...enter, keyCode: 229 }, false), false);
  assert.equal(shouldSendChatMessage(enter, true), false);
  assert.equal(shouldSendChatMessage({ ...enter, key: "a" }, false), false);
});
