import assert from "node:assert/strict";
import test from "node:test";
import { hostedMcpRuntimeProfileSchema, mcpServerHostedConfigSchema } from "@task-weaver/contracts";
import { capabilityDigest } from "./capability-digest";
import { resolveHostedMcpRuntime } from "./mcp-hosted-runtime";

const projectId = "11111111-1111-4111-8111-111111111111";
const profile = hostedMcpRuntimeProfileSchema.parse({ id: "approved", image: `example/runtime@sha256:${"a".repeat(64)}`, command: "/bin/server", projectIds: [projectId] });
const config = { profileId: profile.id, profileHash: capabilityDigest(profile) };

test("hosted MCP profiles bind immutable configuration and explicit resource scopes", () => {
  assert.equal(resolveHostedMcpRuntime({ config, projectId }, JSON.stringify([profile])).profile.id, "approved");
  for (const scope of [{}, { personalOwnerId: "other" }, { projectId: "22222222-2222-4222-8222-222222222222" }]) assert.throws(() => resolveHostedMcpRuntime({ config, ...scope }, JSON.stringify([profile])));
  assert.throws(() => resolveHostedMcpRuntime({ config, projectId }, JSON.stringify([{ ...profile, args: ["changed"] }])));
  assert.throws(() => resolveHostedMcpRuntime({ config, projectId }, "[]"));
  assert.equal(mcpServerHostedConfigSchema.safeParse({ ...config, command: "untrusted-host-command" }).success, false);
});

test("hosted MCP Secret references cannot inherit host runtime options or arbitrary environment values", () => {
  for (const key of ["PATH", "LD_PRELOAD", "NODE_OPTIONS", "TW_API_KEY", "DOCKER_HOST"]) assert.equal(hostedMcpRuntimeProfileSchema.safeParse({ ...profile, secretReferences: { [key]: "TW_MCP_SECRET_APP" } }).success, false);
  assert.equal(hostedMcpRuntimeProfileSchema.safeParse({ ...profile, secretReferences: { APP_TOKEN: "TW_API_KEY" } }).success, false);
  const secretProfile = hostedMcpRuntimeProfileSchema.parse({ ...profile, secretReferences: { APP_TOKEN: "TW_MCP_SECRET_UNIT_FIXTURE" } });
  const secretConfig = { profileId: secretProfile.id, profileHash: capabilityDigest(secretProfile) };
  const previous = process.env.TW_MCP_SECRET_UNIT_FIXTURE;
  try {
    delete process.env.TW_MCP_SECRET_UNIT_FIXTURE;
    assert.throws(() => resolveHostedMcpRuntime({ config: secretConfig, projectId }, JSON.stringify([secretProfile])));
    process.env.TW_MCP_SECRET_UNIT_FIXTURE = "first";
    const first = resolveHostedMcpRuntime({ config: secretConfig, projectId }, JSON.stringify([secretProfile])).fingerprint;
    process.env.TW_MCP_SECRET_UNIT_FIXTURE = "rotated";
    assert.notEqual(resolveHostedMcpRuntime({ config: secretConfig, projectId }, JSON.stringify([secretProfile])).fingerprint, first);
  } finally { if (previous === undefined) delete process.env.TW_MCP_SECRET_UNIT_FIXTURE; else process.env.TW_MCP_SECRET_UNIT_FIXTURE = previous; }
});
