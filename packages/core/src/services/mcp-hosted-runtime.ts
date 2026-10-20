import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { hostedMcpRuntimeProfileSchema, mcpServerHostedConfigSchema, AuthorizationError, ValidationError } from "@task-weaver/contracts";
import { capabilityDigest } from "./capability-digest";
import { readonlyImageVolumes } from "./skill-runtime";

const exec = promisify(execFile);
let active = 0;
type HostedServer = { config: unknown; projectId?: string | null; personalOwnerId?: string | null };

export function resolveHostedMcpRuntime(server: HostedServer, raw = process.env.TW_MCP_RUNTIME_PROFILES) {
  const config = mcpServerHostedConfigSchema.parse(server.config);
  let value: unknown;
  try { value = JSON.parse(raw ?? "[]"); } catch { throw new ValidationError("Hosted MCP runtime configuration is invalid"); }
  const profiles = hostedMcpRuntimeProfileSchema.array().max(16).parse(value);
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new ValidationError("Hosted MCP runtime profile IDs must be unique");
  const profile = profiles.find(item => item.id === config.profileId);
  if (!profile || capabilityDigest(profile) !== config.profileHash) throw new ValidationError("The approved hosted MCP runtime profile is missing or changed");
  if (server.projectId ? !profile.projectIds.includes(server.projectId) : server.personalOwnerId ? !profile.personalActorIds.includes(server.personalOwnerId) : !profile.global) throw new AuthorizationError();
  const secrets: Record<string, string> = {};
  for (const [target, reference] of Object.entries(profile.secretReferences)) {
    const secret = process.env[reference];
    if (!secret || secret.length > 16384) throw new ValidationError("A hosted MCP runtime Secret reference is unavailable");
    secrets[target] = secret;
  }
  return { profile, secrets, fingerprint: capabilityDigest({ profile, secrets }) };
}

/** A bounded JSON-lines transport; only the trusted Docker launcher runs on the host. */
export class HostedMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private closing?: Promise<void>;
  private counted = false;
  private closed = false;
  private readonly name = `tw-mcp-hosted-${randomUUID()}`;

  constructor(private readonly runtime: ReturnType<typeof resolveHostedMcpRuntime>) {}

  async start() {
    if (this.child || this.closed) throw new Error("Hosted MCP transport cannot restart");
    if (active >= 16) throw new ValidationError("Hosted MCP runtime capacity is exhausted");
    active++; this.counted = true;
    try {
      const { profile, secrets } = this.runtime;
      const volumes = await readonlyImageVolumes(profile.image, false);
      const env = Object.fromEntries(["PATH", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "HOME"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
      const args = ["run", "--rm", "--pull=never", "--name", this.name, "--label=task-weaver.mcp-runtime=true", "--network=none", "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=256m", "--cpus=1", "--tmpfs=/tmp:rw,noexec,nosuid,size=32m", ...volumes, ...Object.keys(secrets).map(key => `--env=${key}`), "--entrypoint", profile.command, "-i", profile.image, ...profile.args];
      const child = this.child = spawn("docker", args, { env: { ...env, ...secrets, NODE_ENV: process.env.NODE_ENV ?? "production" }, stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", () => { this.onerror?.(new Error("Hosted MCP container could not start")); void this.close(); });
      child.on("close", () => { void this.close(); });
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          if (this.buffer.length + chunk.length > 1048576) throw new Error("Hosted MCP message exceeds its byte limit");
          this.buffer = Buffer.concat([this.buffer, chunk]);
          let newline: number;
          while ((newline = this.buffer.indexOf(10)) >= 0) {
            const line = this.buffer.subarray(0, newline).toString("utf8");
            this.buffer = this.buffer.subarray(newline + 1);
            if (line.trim()) this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
          }
        } catch { this.onerror?.(new Error("Hosted MCP returned an invalid or oversized protocol message")); void this.close(); }
      });
    } catch (error) { await this.close(); throw error; }
  }

  async send(message: JSONRPCMessage) {
    if (!this.child || this.closed) throw new Error("Hosted MCP transport is closed");
    const value = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(value) > 1048576) throw new Error("Hosted MCP request exceeds its byte limit");
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(value, error => error ? reject(new Error("Hosted MCP transport write failed")) : resolve()));
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      this.child?.kill("SIGTERM");
      const escalation = setTimeout(() => this.child?.kill("SIGKILL"), 1000); escalation.unref();
      try {
        if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => { this.child?.kill("SIGKILL"); resolve(); }, 1250); timer.unref();
            this.child!.once("close", () => { clearTimeout(timer); resolve(); });
          });
        }
        await exec("docker", ["rm", "--force", "--volumes", this.name], { timeout: 5000, maxBuffer: 4096 });
      }
      catch { /* The runtime supervisor reconciles containers after host/daemon failures. */ }
      finally {
        clearTimeout(escalation);
        this.child?.kill("SIGKILL");
        this.buffer = Buffer.alloc(0);
        for (const key of Object.keys(this.runtime.secrets)) delete this.runtime.secrets[key];
        if (this.counted) { active--; this.counted = false; }
        this.onclose?.();
      }
    })();
    return this.closing;
  }
}
