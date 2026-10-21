import assert from "node:assert/strict";
import test from "node:test";
import { createPartnersMcpAdapter, PartnersMcpError } from "./partners-mcp";

const job = { jobId: "job-owned", sessionId: "session-owned", state: "failed", exitCode: 9, terminalReason: "exit", outputTruncated: false,
  stdout: "hello", stderr: "failed", nextCursor: "2:0", truncated: false, artifactRefs: [] };
const isCode = (code: string) => (error: unknown) => error instanceof PartnersMcpError && error.code === code;

test("failed command remains a typed terminal job even with MCP isError", async () => {
  const adapter = createPartnersMcpAdapter(async () => ({ isError: true, structuredContent: job }));
  const result = await adapter.invoke("job_get", { jobId: job.jobId });
  assert.equal(result.exitCode, 9);
  assert.equal(result.state, "failed");
  assert.equal(result.stderr, "failed");
});

test("provider errors retain safe reconciliation identifiers without raw messages", async () => {
  const adapter = createPartnersMcpAdapter(async () => ({ isError: true, structuredContent: {
    code: "EXECUTION_UNKNOWN", retryable: false, jobId: "known", message: "private provider credential",
  } }));
  await assert.rejects(adapter.invoke("bash_exec", { sessionId: "session-owned", command: "true", requestId: "stable-request" }), error => {
    assert.ok(error instanceof PartnersMcpError);
    assert.equal(error.resource.jobId, "known");
    assert.equal(error.message.includes("credential"), false);
    return true;
  });
});

test("ambiguous mutation is submitted exactly once and never retried", async () => {
  let calls = 0;
  const adapter = createPartnersMcpAdapter(async () => { calls++; throw new Error("secret transport error"); });
  await assert.rejects(adapter.invoke("bash_exec", { sessionId: "session-owned", command: "true", requestId: "stable-request" }), isCode("TRANSPORT_OUTCOME_UNKNOWN"));
  assert.equal(calls, 1);
});

test("foreign identifiers and oversized UTF-8 output are rejected", async () => {
  const adapter = createPartnersMcpAdapter(async () => ({ structuredContent: job }));
  await assert.rejects(adapter.invoke("job_get", { jobId: "foreign" }), isCode("RESOURCE_MISMATCH"));
  await assert.rejects(adapter.invoke("job_get", { jobId: job.jobId, maxOutputBytes: 4 }), isCode("INVALID_RESPONSE"));
});

test("conditional writes and path boundaries are validated before transport", async () => {
  let calls = 0;
  const adapter = createPartnersMcpAdapter(async () => { calls++; return {}; });
  await assert.rejects(adapter.invoke("file_ops", { sessionId: "owned", action: "write", path: "../escape", content: "test", createOnly: true, requestId: "stable-request" }));
  await assert.rejects(adapter.invoke("file_ops", { sessionId: "owned", action: "write", path: "safe", content: "test", requestId: "stable-request" }));
  assert.equal(calls, 0);
});

test("explicit retry preserves normalized arguments and request identity", async () => {
  const submitted: unknown[] = [];
  const adapter = createPartnersMcpAdapter(async (_name, args) => {
    submitted.push(args);
    return { structuredContent: { jobId: "known", sessionId: "owned", state: "accepted" } };
  });
  const input = { sessionId: "owned", command: "true", requestId: "stable-request" };
  await adapter.invoke("bash_exec", input);
  await adapter.invoke("bash_exec", input);
  assert.deepEqual(submitted[0], submitted[1]);
});
