import type { DaemonConfig } from "@task-weaver/contracts";

export function getDaemonConfig(): DaemonConfig {
  const mode = process.env.TW_DAEMON_MODE === "sse" ? "sse" : "polling" as const;
  return {
    executionDelegationSupported: true,
    mode,
    pollingIntervalMs: Number(process.env.TW_DAEMON_POLL_INTERVAL_MS) || 10_000,
    pollingBackoffMax: Number(process.env.TW_DAEMON_POLL_BACKOFF_MAX_MS) || 60_000,
    ...(mode === "sse" ? { sseEndpoint: "/api/v1/daemons/events" } : {}),
  };
}
