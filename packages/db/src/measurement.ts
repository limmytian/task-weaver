import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export type DatabasePhase = "transactionEntry" | "resourceTransaction" | "identityLock";
export interface DatabaseMeasurement {
  queryCount: number;
  phases: Record<DatabasePhase, { count: number; milliseconds: number }>;
}
const measurements = new AsyncLocalStorage<DatabaseMeasurement>();

/** Explicit local measurement scope; no SQL, parameters, identities or bodies are retained. */
export async function measureDatabaseWork<T>(work: () => Promise<T>) {
  const measurement: DatabaseMeasurement = {
    queryCount: 0,
    phases: {
      transactionEntry: { count: 0, milliseconds: 0 },
      resourceTransaction: { count: 0, milliseconds: 0 },
      identityLock: { count: 0, milliseconds: 0 },
    },
  };
  const value = await measurements.run(measurement, work);
  return { value, measurement };
}

export function countDatabaseQuery() {
  const measurement = measurements.getStore();
  if (measurement) measurement.queryCount++;
}

/** Transaction entry includes BEGIN and scheduling; it is not an isolated pool-wait metric. */
export function startDatabasePhase(phase: DatabasePhase): () => void {
  const measurement = measurements.getStore();
  if (!measurement) return () => {};
  const started = performance.now();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    measurement.phases[phase].count++;
    measurement.phases[phase].milliseconds += performance.now() - started;
  };
}
