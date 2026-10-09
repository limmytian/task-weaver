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
}

export interface McpServerRecord {
  id: string;
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  config: McpServerConfig;
  authorizationPartition?: string;
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class McpConnectionPool {
  private connections = new Map<string, PoolEntry>();
  private reaperInterval: ReturnType<typeof setInterval> | null = null;

  async getOrConnect(server: McpServerRecord): Promise<Client> {
    this.startIdleReaper();
    if (!server.authorizationPartition) throw new Error("Verified MCP connection partition is required");
    const configurationHash = createHash("sha256").update(JSON.stringify({ transport: server.transport, config: server.config })).digest("hex");
    const key = server.id + ":" + server.authorizationPartition + ":" + configurationHash;
    const existing = this.connections.get(key);
    if (existing) {
      existing.lastUsed = new Date();
      return existing.client;
    }

    const client = new Client({ name: "task-weaver-proxy", version: "1.0.0" });
    const transport = this.createTransport(server);
    await client.connect(transport);

    this.connections.set(key, { serverId: server.id, client, transport, lastUsed: new Date() });
    return client;
  }

  private createTransport(server: McpServerRecord): Transport {
    const config = server.config;

    if (server.transport === "stdio") throw new Error("Client-hosted stdio must execute on the registered client");

    const httpConfig = config as { url: string; headers?: Record<string, string> };
    if (server.transport === "sse") return new SSEClientTransport(new URL(httpConfig.url), { requestInit: { headers: httpConfig.headers }, eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...httpConfig.headers, ...Object.fromEntries(new Headers(init?.headers)) } }) } });
    return new StreamableHTTPClientTransport(new URL(httpConfig.url), { requestInit: { headers: httpConfig.headers } });
  }

  async disconnect(serverId: string): Promise<void> {
    for (const [key, entry] of this.connections) {
      if (entry.serverId !== serverId) continue;
      try { await entry.client.close(); } catch { /* Best-effort close. */ }
      this.connections.delete(key);
    }
  }

  async disconnectAll(): Promise<void> {
    const ids = [...new Set([...this.connections.values()].map(entry => entry.serverId))];
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
        if (now - entry.lastUsed.getTime() > IDLE_TIMEOUT_MS) {
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
