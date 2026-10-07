import assert from "node:assert/strict";
import test from "node:test";
import {
  announceSessionChange,
  invalidateBrowserSession,
  SESSION_INVALIDATED_EVENT,
} from "./browser-session";

test("session invalidation closes consumers before discarding the previous account route", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const actions: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent(event: Event) {
        actions.push(event.type);
      },
      location: {
        replace(path: string) {
          actions.push(path);
        },
      },
    },
  });
  try {
    invalidateBrowserSession();
    invalidateBrowserSession();
    assert.deepEqual(actions, [
      SESSION_INVALIDATED_EVENT,
      "/login?reason=session-ended",
    ]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("session broadcasts contain no actor, credential or cached resource data", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousChannel = globalThis.BroadcastChannel;
  const actions: unknown[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  globalThis.BroadcastChannel = class {
    constructor(name: string) {
      actions.push(name);
    }
    postMessage(value: unknown) {
      actions.push(value);
    }
    close() {
      actions.push("closed");
    }
  } as unknown as typeof BroadcastChannel;
  try {
    announceSessionChange();
    assert.deepEqual(actions, ["tw-session", "changed", "closed"]);
  } finally {
    globalThis.BroadcastChannel = previousChannel;
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
