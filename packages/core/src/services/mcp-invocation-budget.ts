export class McpInvocationBusy extends Error {
  constructor() { super("MCP invocation capacity is temporarily exhausted; retry an undispatched request later"); }
}

/** Host-local admission only; permits remain held until actual dispatch settles. */
export function createMcpInvocationBudget(now = Date.now) {
  const buckets = new Map<string, { tokens: number; updated: number; active: number }>();
  const servers = new Map<string, number>();
  let total = 0;
  return (actorId: string, serverId: string) => {
    const time = now();
    const key = JSON.stringify([actorId, serverId]);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= 1024) for (const [id, value] of buckets) if (!value.active && time - value.updated > 60000) buckets.delete(id);
      if (buckets.size >= 1024) throw new McpInvocationBusy();
      bucket = { tokens: 20, updated: time, active: 0 }; buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(20, bucket.tokens + Math.max(0, time - bucket.updated) * 0.005);
    bucket.updated = time;
    if (bucket.tokens < 1 || bucket.active >= 4 || (servers.get(serverId) ?? 0) >= 32 || total >= 64) throw new McpInvocationBusy();
    bucket.tokens--; bucket.active++; total++; servers.set(serverId, (servers.get(serverId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      bucket!.active--; total--;
      const count = (servers.get(serverId) ?? 1) - 1;
      if (count) servers.set(serverId, count); else servers.delete(serverId);
    };
  };
}
export const acquireMcpInvocation = createMcpInvocationBudget();
