import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type { McpServerConfig } from "@task-weaver/db";

interface PoolEntry {
  client: Client;
  transport: Transport;
  lastUsed: Date;
}

export interface McpServerRecord {
  id: string;
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  config: McpServerConfig;
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class McpConnectionPool {
  private connections = new Map<string, PoolEntry>();
  private reaperInterval: ReturnType<typeof setInterval> | null = null;

  async getOrConnect(server: McpServerRecord): Promise<Client> {
    const existing = this.connections.get(server.id);
    if (existing) {
      existing.lastUsed = new Date();
      return existing.client;
    }

    const client = new Client({ name: "task-weaver-proxy", version: "1.0.0" });
    const transport = this.createTransport(server);
    await client.connect(transport);

    this.connections.set(server.id, { client, transport, lastUsed: new Date() });
    return client;
  }

  private createTransport(server: McpServerRecord): Transport {
    const config = server.config;

    if (server.transport === "stdio") {
      const stdioConfig = config as { command: string; args?: string[]; env?: Record<string, string> };
      return new StdioClientTransport({
        command: stdioConfig.command,
        args: stdioConfig.args,
        env: stdioConfig.env,
      });
    }

    // sse and streamable-http both use StreamableHTTPClientTransport
    const httpConfig = config as { url: string; headers?: Record<string, string> };
    return new StreamableHTTPClientTransport(new URL(httpConfig.url));
  }

  async disconnect(serverId: string): Promise<void> {
    const entry = this.connections.get(serverId);
    if (!entry) return;
    try {
      await entry.client.close();
    } catch {
      // ignore close errors
    }
    this.connections.delete(serverId);
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()];
    await Promise.allSettled(ids.map((id) => this.disconnect(id)));
  }

  isConnected(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  startIdleReaper(): void {
    if (this.reaperInterval) return;
    this.reaperInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.connections) {
        if (now - entry.lastUsed.getTime() > IDLE_TIMEOUT_MS) {
          this.disconnect(id);
        }
      }
    }, 60_000);
  }

  stopIdleReaper(): void {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }
  }
}

export const mcpPool = new McpConnectionPool();
