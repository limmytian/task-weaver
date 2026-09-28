import { LeaseSupervisor, type SupervisedLease } from './lease-supervisor.js'

export type ReliabilityBoundary =
  | 'api'
  | 'database'
  | 'git'
  | 'credential'
  | 'ai'
  | 'check'
  | 'forge'

export interface FaultRule {
  boundary: ReliabilityBoundary
  timing: 'before' | 'after'
  attempts: number[]
  failureCode: string
  retry: 'automatic' | 'manual'
}

export class InjectedFaultError extends Error {
  constructor(
    readonly boundary: ReliabilityBoundary,
    readonly timing: FaultRule['timing'],
    readonly failureCode: string,
    readonly retry: FaultRule['retry'],
  ) {
    super(`Injected ${timing}-effect ${boundary} failure: ${failureCode}`)
    this.name = 'InjectedFaultError'
  }
}

export class DeterministicFaultInjector {
  private readonly attempts = new Map<ReliabilityBoundary, number>()

  constructor(private readonly rules: FaultRule[]) {}

  count(boundary: ReliabilityBoundary) {
    return this.attempts.get(boundary) ?? 0
  }

  async invoke<T>(boundary: ReliabilityBoundary, effect: () => T | Promise<T>): Promise<T> {
    const attempt = this.count(boundary) + 1
    this.attempts.set(boundary, attempt)
    const matching = this.rules.filter((rule) =>
      rule.boundary === boundary && rule.attempts.includes(attempt),
    )
    const before = matching.find((rule) => rule.timing === 'before')
    if (before) {
      throw new InjectedFaultError(boundary, before.timing, before.failureCode, before.retry)
    }
    const result = await effect()
    const after = matching.find((rule) => rule.timing === 'after')
    if (after) {
      throw new InjectedFaultError(boundary, after.timing, after.failureCode, after.retry)
    }
    return result
  }
}

export interface AcceleratedLeaseToken {
  laneId: string
  ownerId: string
  generation: number
}

interface LeaseRow extends AcceleratedLeaseToken {
  expiresAt: number
  writes: number
}

export class AcceleratedLeaseRegistry {
  private readonly rows = new Map<string, LeaseRow>()
  private nowMs = 0

  constructor(private readonly ttlMs: number) {}

  get now() {
    return this.nowMs
  }

  advance(milliseconds: number) {
    this.nowMs += milliseconds
  }

  acquire(laneId: string, ownerId: string): AcceleratedLeaseToken | null {
    const current = this.rows.get(laneId)
    if (current && current.expiresAt > this.nowMs) return null
    const generation = (current?.generation ?? 0) + 1
    const row = { laneId, ownerId, generation, expiresAt: this.nowMs + this.ttlMs, writes: current?.writes ?? 0 }
    this.rows.set(laneId, row)
    return { laneId, ownerId, generation }
  }

  renew(token: AcceleratedLeaseToken) {
    const row = this.rows.get(token.laneId)
    if (!row || !this.matches(row, token)) return false
    row.expiresAt = this.nowMs + this.ttlMs
    return true
  }

  mutate(token: AcceleratedLeaseToken) {
    const row = this.rows.get(token.laneId)
    if (!row || !this.matches(row, token)) return false
    row.writes += 1
    return true
  }

  release(token: AcceleratedLeaseToken) {
    const row = this.rows.get(token.laneId)
    if (!row || !this.matches(row, token)) return false
    row.expiresAt = this.nowMs
    return true
  }

  isCurrent(token: AcceleratedLeaseToken) {
    return this.matches(this.rows.get(token.laneId), token)
  }

  activeOwners() {
    return [...this.rows.values()]
      .filter((row) => row.expiresAt > this.nowMs)
      .map(({ laneId, ownerId, generation, expiresAt }) => ({ laneId, ownerId, generation, expiresAt }))
  }

  totalWrites() {
    return [...this.rows.values()].reduce((sum, row) => sum + row.writes, 0)
  }

  private matches(row: LeaseRow | undefined, token: AcceleratedLeaseToken) {
    return Boolean(
      row
      && row.expiresAt > this.nowMs
      && row.ownerId === token.ownerId
      && row.generation === token.generation,
    )
  }
}

export interface AcceleratedSoakOptions {
  iterations?: number
  tickMs?: number
  ttlMs?: number
  laneCount?: number
  processIds?: string[]
}

export interface AcceleratedSoakResult {
  iterations: number
  virtualDurationMs: number
  acquisitions: number
  acceptedWrites: number
  heartbeatFaults: number
  fencedWrites: number
  staleWriteRejections: number
  recoveries: number
  duplicateLaneOwners: number
  strandedLanes: number
}

interface SoakWorker {
  id: string
  index: number
  alive: boolean
  restartAt: number | null
  token: AcceleratedLeaseToken | null
  staleTokens: AcceleratedLeaseToken[]
  supervisor: LeaseSupervisor
  previouslyHealthy: boolean
}

export async function runAcceleratedLeaseSoak(
  options: AcceleratedSoakOptions = {},
): Promise<AcceleratedSoakResult> {
  const iterations = options.iterations ?? 21_600
  const tickMs = options.tickMs ?? 1_000
  const ttlMs = options.ttlMs ?? 5_000
  const laneCount = options.laneCount ?? 12
  const processIds = options.processIds ?? ['executor-0', 'executor-1', 'reviewer-0', 'merger-0']
  const registry = new AcceleratedLeaseRegistry(ttlMs)
  let tick = 0
  let acquisitions = 0
  let heartbeatFaults = 0
  let fencedWrites = 0
  let staleWriteRejections = 0
  let recoveries = 0
  let duplicateLaneOwners = 0

  const workers: SoakWorker[] = []
  const makeSupervisor = (worker: SoakWorker) => new LeaseSupervisor({
    intervalMs: tickMs,
    heartbeatProcess: async () => {
      if ((tick + 1 + worker.index * 7) % 211 === 0) {
        heartbeatFaults += 1
        throw new Error('injected process heartbeat loss')
      }
    },
    heartbeatLease: async (lease: SupervisedLease) => {
      if ((tick + 1 + worker.index * 11) % 157 === 0) {
        heartbeatFaults += 1
        throw new Error('injected requirement heartbeat loss')
      }
      const token = worker.token
      if (!token || token.laneId !== lease.requirementId || token.generation !== lease.generation) {
        throw new Error('stale lease registration')
      }
      if (!registry.renew(token)) throw new Error('lease was reassigned')
    },
  })

  for (const [index, id] of processIds.entries()) {
    const worker = {
      id, index, alive: true, restartAt: null, token: null, staleTokens: [],
      supervisor: null as unknown as LeaseSupervisor,
      previouslyHealthy: true,
    }
    worker.supervisor = makeSupervisor(worker)
    workers.push(worker)
  }

  for (tick = 0; tick < iterations; tick += 1) {
    registry.advance(tickMs)
    for (const worker of workers) {
      if (worker.restartAt === tick) {
        worker.alive = true
        worker.restartAt = null
        worker.token = null
        worker.previouslyHealthy = true
        worker.supervisor = makeSupervisor(worker)
      }
      if (worker.alive && tick > 0 && (tick + worker.index * 31) % 997 === 0) {
        worker.alive = false
        worker.restartAt = tick + 8
        worker.supervisor.stop()
        if (worker.token) worker.staleTokens.push(worker.token)
        worker.token = null
        continue
      }
      if (!worker.alive) continue
      if (worker.token && !registry.isCurrent(worker.token)) {
        worker.staleTokens.push(worker.token)
        worker.supervisor.unregister(worker.id)
        worker.token = null
      }
      if (!worker.token) {
        for (let offset = 0; offset < laneCount; offset += 1) {
          const laneId = `lane-${(tick + worker.index + offset) % laneCount}`
          const token = registry.acquire(laneId, worker.id)
          if (!token) continue
          worker.token = token
          worker.supervisor.register({
            key: worker.id,
            requirementId: token.laneId,
            generation: token.generation,
          })
          acquisitions += 1
          break
        }
      }
    }

    await Promise.all(workers.filter((worker) => worker.alive).map((worker) => worker.supervisor.tick()))
    for (const worker of workers) {
      if (!worker.alive || !worker.token) continue
      const healthy = worker.supervisor.snapshot(worker.id)?.healthy ?? false
      if (healthy && !worker.previouslyHealthy) recoveries += 1
      worker.previouslyHealthy = healthy
      if (!healthy) {
        fencedWrites += 1
      } else if (!registry.mutate(worker.token)) {
        throw new Error(`Healthy worker ${worker.id} wrote through a stale lease`)
      }
      if ((tick + worker.index) % 127 === 0 && worker.staleTokens.length > 0) {
        const stale = worker.staleTokens[worker.staleTokens.length - 1]!
        if (registry.mutate(stale)) throw new Error('Stale lease mutation was accepted')
        staleWriteRejections += 1
      }
    }
    const active = registry.activeOwners()
    if (new Set(active.map((lease) => lease.laneId)).size !== active.length) duplicateLaneOwners += 1
  }

  for (const worker of workers) {
    worker.supervisor.stop()
    if (worker.token) registry.release(worker.token)
  }
  registry.advance(ttlMs + 1)
  return {
    iterations,
    virtualDurationMs: iterations * tickMs,
    acquisitions,
    acceptedWrites: registry.totalWrites(),
    heartbeatFaults,
    fencedWrites,
    staleWriteRejections,
    recoveries,
    duplicateLaneOwners,
    strandedLanes: registry.activeOwners().length,
  }
}
