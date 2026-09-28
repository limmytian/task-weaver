export type DaemonRole = "executor" | "reviewer" | "merger";
export type QueueViewId = DaemonRole | "retrying" | "blocked" | "manual";

export interface WorkerSlot {
  index: number;
  status: string;
  requirementId?: string | null;
}

export interface DaemonCapacitySource<TWorker extends WorkerSlot = WorkerSlot> {
  role?: DaemonRole | null;
  workerCapacity?: number | null;
  workerStates?: TWorker[];
}

export interface QueueListItem {
  role: DaemonRole | "operator";
  state: "runnable" | "blocked" | "retrying" | "manual";
}

export function isDaemonStale(
  lastHeartbeatAt: Date | string | null | undefined,
  now: number,
  staleAfterMs = 60_000,
) {
  return !lastHeartbeatAt || now - new Date(lastHeartbeatAt).getTime() > staleAfterMs;
}

export function isLeaseAtRisk(
  worker: {
    leaseHealthy?: boolean | null;
    claim?: { expiresAt?: Date | string | null } | null;
  },
  now: number,
) {
  return worker.leaseHealthy === false
    || Boolean(worker.claim?.expiresAt && new Date(worker.claim.expiresAt).getTime() < now);
}

export function queueItemsForView<TItem extends QueueListItem>(
  items: TItem[],
  view: QueueViewId,
) {
  if (view === "executor" || view === "reviewer" || view === "merger") {
    return items.filter((item) => item.state === "runnable" && item.role === view);
  }
  return items.filter((item) => item.state === view);
}

export function normalizeWorkerSlots<TWorker extends WorkerSlot>(
  workerStates: TWorker[],
  configuredCapacity: number,
): Array<TWorker | WorkerSlot> {
  const workersByIndex = new Map(workerStates.map((worker) => [worker.index, worker]));
  const highestReportedIndex = workerStates.reduce(
    (highest, worker) => Math.max(highest, worker.index),
    -1,
  );
  const visibleCapacity = Math.max(configuredCapacity, highestReportedIndex + 1, 1);

  return Array.from({ length: visibleCapacity }, (_, index) =>
    workersByIndex.get(index) ?? { index, status: "idle", requirementId: null },
  );
}

export function summarizeRoleCapacity(daemons: DaemonCapacitySource[]) {
  return (["executor", "reviewer", "merger"] as const).map((role) => {
    const roleDaemons = daemons.filter((daemon) => (daemon.role ?? "executor") === role);
    const configured = roleDaemons.reduce(
      (total, daemon) => total + (daemon.workerCapacity ?? 1),
      0,
    );
    const active = roleDaemons.reduce((total, daemon) =>
      total + (daemon.workerStates ?? []).filter((worker) =>
        worker.status !== "idle" || Boolean(worker.requirementId),
      ).length,
    0);

    return {
      role,
      daemonCount: roleDaemons.length,
      configured,
      active,
      idle: Math.max(0, configured - active),
    };
  });
}
