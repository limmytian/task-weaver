/** macOS reclaimable headroom is distinct from the physically free-page counter. */
export function macMemoryHeadroom(vmStat, pressure) {
  if (String(pressure).trim() !== "1") throw new Error("Host memory pressure is not normal");
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1]);
  const pages = ["free", "inactive", "speculative"].map(kind => {
    const match = vmStat.match(new RegExp(`Pages ${kind}:\\s+(\\d+)\\.`));
    if (!match) throw new Error("Memory accounting unavailable");
    return Number(match[1]);
  });
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new Error("Memory accounting unavailable");
  return pageSize * pages.reduce((sum, count) => sum + count, 0);
}

export function processSnapshot(output) {
  return output.trim().split("\n").filter(Boolean).map(line => {
    const [pid, parent, rss, cpu] = line.trim().split(/\s+/);
    const parts = cpu?.split(":").map(Number);
    if (!parts || parts.length < 2 || parts.length > 3 || parts.some(value => !Number.isFinite(value))) throw new Error("Process accounting unavailable");
    const cpuSeconds = parts.reduce((sum, value) => sum * 60 + value, 0);
    const record = { pid: Number(pid), parent: Number(parent), rssBytes: Number(rss) * 1024, cpuSeconds };
    if (Object.values(record).some(value => !Number.isFinite(value) || value < 0)) throw new Error("Process accounting unavailable");
    return record;
  });
}

export function processTree(snapshot, rootPid) {
  const members = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of snapshot) if (members.has(row.parent) && !members.has(row.pid)) { members.add(row.pid); changed = true; }
  }
  return snapshot.filter(row => members.has(row.pid));
}
