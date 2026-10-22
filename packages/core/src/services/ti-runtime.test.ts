import assert from "node:assert/strict";
import test from "node:test";
import { runTiRuntime, TiRuntimeError, type TiRuntimeOptions } from "./ti-runtime";

const call = { id: "call-1", name: "read", arguments: "{}" };
function options(patch: Partial<TiRuntimeOptions> = {}): TiRuntimeOptions {
  return { messages: [{ role: "user", content: "Work" }], deadline: performance.now() + 10_000,
    authorize: async () => {}, requestTurn: async () => ({ content: "Done", toolCalls: [] }),
    executeTool: async () => "result", ...patch };
}
const code = (expected: string) => (error: unknown) => error instanceof TiRuntimeError && error.code === expected;

test("feeds tool results back into the next model turn", async () => {
  let turns = 0;
  const input = options({ requestTurn: async ({ messages }) => {
    if (turns++ === 0) return { content: null, toolCalls: [call] };
    assert.deepEqual(messages.at(-1), { role: "tool", tool_call_id: call.id, content: "result" });
    return { content: "Done", toolCalls: [] };
  } });
  assert.equal(await runTiRuntime(input), "Done");
  assert.equal(turns, 2);
});

test("revocation during model execution prevents dispatch", async () => {
  let revoked = false, dispatched = false;
  const denied = new Error("Revoked");
  await assert.rejects(runTiRuntime(options({ authorize: async () => { if (revoked) throw denied; },
    requestTurn: async () => { revoked = true; return { content: null, toolCalls: [call] }; },
    executeTool: async () => { dispatched = true; return "result"; },
  })), error => error === denied);
  assert.equal(dispatched, false);
});

test("cancellation between tools prevents subsequent side effects", async () => {
  const controller = new AbortController();
  let count = 0;
  await assert.rejects(runTiRuntime(options({ signal: controller.signal,
    requestTurn: async () => ({ content: null, toolCalls: [call, { ...call, id: "call-2" }] }),
    executeTool: async () => { count++; controller.abort(); return "result"; },
  })), code("cancelled"));
  assert.equal(count, 1);
});

test("confirmation supervisor stops before another model request", async () => {
  let turns = 0;
  assert.equal(await runTiRuntime(options({
    requestTurn: async () => { turns++; return { content: null, toolCalls: [call] }; },
    afterTools: async () => "Approval required",
  })), "Approval required");
  assert.equal(turns, 1);
});

test("tool and final-round limits fail before dispatch", async () => {
  for (const limits of [{ maxToolCalls: 0 }, { maxRounds: 1 }]) {
    let dispatched = false;
    await assert.rejects(runTiRuntime(options({ ...limits,
      requestTurn: async () => ({ content: null, toolCalls: [call] }),
      executeTool: async () => { dispatched = true; return "result"; },
    })), code("maxRounds" in limits ? "round_limit" : "tool_limit"));
    assert.equal(dispatched, false);
  }
});

test("context and deadline limits prevent model requests", async () => {
  for (const limits of [{ maxContextBytes: 1 }, { deadline: performance.now() - 1 }]) {
    let requested = false;
    await assert.rejects(runTiRuntime(options({ ...limits,
      requestTurn: async () => { requested = true; return { content: "Done", toolCalls: [] }; },
    })), code("deadline" in limits ? "deadline" : "context_limit"));
    assert.equal(requested, false);
  }
});
