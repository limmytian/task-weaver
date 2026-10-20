import { HostedMcpTransport, resolveHostedMcpRuntime } from "./mcp-hosted-runtime";
import { APPLICATION_VERSION } from "@task-weaver/contracts";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type { McpServerConfig } from "@task-weaver/db";

interface PoolEntry {
  serverId: string;
  client: Client;
  transport: Transport;
  lastUsed: Date;
  valid?: () => boolean;
}

export interface McpServerRecord {
  id: string;
  name: string;
  transport: "stdio" | "sse" | "streamable-http" | "hosted-stdio";
  projectId?: string | null;
  personalOwnerId?: string | null;
  config: McpServerConfig;
  authorizationPartition?: string;
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class McpConnectionPool {
  private connections = new Map<string, PoolEntry>();
  private pending = new Map<string, { serverId: string; promise: Promise<Client>; cancelled: boolean }>();
  private reaperInterval: ReturnType<typeof setInterval> | null = null;

  async getOrConnect(server: McpServerRecord): Promise<Client> {
    this.startIdleReaper();
    if (!server.authorizationPartition) throw new Error("Verified MCP connection partition is required");
    const configurationHash = createHash("sha256").update(JSON.stringify({ transport: server.transport, config: server.config, runtime: server.transport === "hosted-stdio" ? resolveHostedMcpRuntime(server).fingerprint : undefined })).digest("hex");
    const key = server.id + ":" + server.authorizationPartition + ":" + configurationHash;
    const existing = this.connections.get(key);
    if (existing) {
      existing.lastUsed = new Date();
      return existing.client;
    }

    const pending = this.pending.get(key);
    if (pending) return pending.promise;
    if (this.pending.size + this.connections.size >= 64) throw new Error("MCP connection capacity is exhausted");
    const state = { serverId: server.id, promise: undefined as unknown as Promise<Client>, cancelled: false };
    const promise = (async () => {
      const client = new Client({ name: "task-weaver-proxy", version: APPLICATION_VERSION });
      const transport = await this.createTransport(server);
      try { await client.connect(transport, { timeout: 10000 }); }
      catch { await transport.close(); throw new Error("MCP server initialization failed"); }
      if (state.cancelled) { await client.close(); throw new Error("MCP connection was cancelled"); }
      const onclose = client.onclose;
      client.onclose = () => { if (this.connections.get(key)?.client === client) this.connections.delete(key); onclose?.(); };
      this.connections.set(key, { serverId: server.id, client, transport, lastUsed: new Date(), valid: server.transport === "hosted-stdio" ? () => {
        try { return configurationHash === createHash("sha256").update(JSON.stringify({ transport: server.transport, config: server.config, runtime: resolveHostedMcpRuntime(server).fingerprint })).digest("hex"); }
        catch { return false; }
      } : undefined });
      return client;
    })();
    state.promise = promise;
    this.pending.set(key, state);
    try { return await promise; } finally { this.pending.delete(key); }
  }

  private async createTransport(server: McpServerRecord): Promise<Transport> {
    if (server.transport === "hosted-stdio") return new HostedMcpTransport(resolveHostedMcpRuntime(server));
    const config = server.config;

    if (server.transport === "stdio") throw new Error("Client-hosted stdio must execute on the registered client");

    const configured = config as { url: string; headers?: Record<string, string> };
    const headers = new Headers(configured.headers);
    headers.set("x-task-weaver-mcp-hop", "1");
    const httpConfig = { ...configured, headers: Object.fromEntries(headers) };
    if (server.transport === "sse") return new SSEClientTransport(new URL(httpConfig.url), { requestInit: { headers: httpConfig.headers }, eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...httpConfig.headers, ...Object.fromEntries(new Headers(init?.headers)) } }) } });
    return new StreamableHTTPClientTransport(new URL(httpConfig.url), { requestInit: { headers: httpConfig.headers } });
  }

  async disconnect(serverId: string): Promise<void> {
    for (const pending of this.pending.values()) if (pending.serverId === serverId) pending.cancelled = true;
    await Promise.allSettled([...this.pending.values()].filter(entry => entry.serverId === serverId).map(entry => entry.promise));
    for (const [key, entry] of this.connections) {
      if (entry.serverId !== serverId) continue;
      try { await entry.client.close(); } catch { /* Best-effort close. */ }
      this.connections.delete(key);
    }
  }

  async disconnectAll(): Promise<void> {
    const ids = [...new Set([...this.connections.values(), ...this.pending.values()].map(entry => entry.serverId))];
    await Promise.allSettled(ids.map((id) => this.disconnect(id)));
  }

  isConnected(serverId: string): boolean {
    return [...this.connections.values()].some(entry => entry.serverId === serverId);
  }

  startIdleReaper(): void {
    if (this.reaperInterval) return;
    this.reaperInterval = setInterval(() => {
      const now = Date.now();
      for (const entry of this.connections.values()) {
        if (entry.valid && !entry.valid() || now - entry.lastUsed.getTime() > IDLE_TIMEOUT_MS) {
          this.disconnect(entry.serverId);
        }
      }
    }, 60_000);
    this.reaperInterval.unref?.();
  }

  stopIdleReaper(): void {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }
  }
}

export const mcpPool = new McpConnectionPool();
