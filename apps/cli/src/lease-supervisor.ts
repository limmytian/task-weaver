export interface SupervisedLease {
  key: string
  requirementId: string
  generation: number
}

export interface LeaseHealthSnapshot extends SupervisedLease {
  healthy: boolean
  heartbeatFailures: number
  lastError: string | null
}

export interface LeaseSupervisorOptions {
  intervalMs?: number
  heartbeatProcess: () => Promise<unknown>
  heartbeatLease: (lease: SupervisedLease) => Promise<unknown>
  onHealthChange?: (snapshot: LeaseHealthSnapshot) => void
  onProcessError?: (error: string | null) => void
}

interface LeaseState extends SupervisedLease {
  leaseHealthy: boolean
  heartbeatFailures: number
  lastError: string | null
}

export class LeaseUncertainError extends Error {
  constructor(readonly snapshot: LeaseHealthSnapshot) {
    super(
      `Requirement lease ${snapshot.requirementId} generation ${snapshot.generation} is unhealthy` +
      `${snapshot.lastError ? `: ${snapshot.lastError}` : ''}`,
    )
    this.name = 'LeaseUncertainError'
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export class LeaseSupervisor {
  private readonly intervalMs: number
  private readonly leases = new Map<string, LeaseState>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private ticking = false
  private processHealthy = true
  private processError: string | null = null

  constructor(private readonly options: LeaseSupervisorOptions) {
    this.intervalMs = options.intervalMs ?? 30_000
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.schedule()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  register(lease: SupervisedLease) {
    this.leases.set(lease.key, {
      ...lease,
      leaseHealthy: true,
      heartbeatFailures: 0,
      lastError: null,
    })
    this.emit(lease.key)
  }

  unregister(key: string) {
    this.leases.delete(key)
  }

  snapshot(key: string): LeaseHealthSnapshot | null {
    const lease = this.leases.get(key)
    if (!lease) return null
    return {
      key: lease.key,
      requirementId: lease.requirementId,
      generation: lease.generation,
      healthy: this.processHealthy && lease.leaseHealthy,
      heartbeatFailures: lease.heartbeatFailures,
      lastError: this.processError ?? lease.lastError,
    }
  }

  assertHealthy(key: string) {
    const snapshot = this.snapshot(key)
    if (!snapshot || !snapshot.healthy) {
      throw new LeaseUncertainError(snapshot ?? {
        key,
        requirementId: 'unknown',
        generation: 0,
        healthy: false,
        heartbeatFailures: 0,
        lastError: 'lease is not registered',
      })
    }
    return snapshot
  }

  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      try {
        await this.options.heartbeatProcess()
        if (!this.processHealthy) {
          this.processHealthy = true
          this.processError = null
          this.options.onProcessError?.(null)
          for (const key of this.leases.keys()) this.emit(key)
        }
      } catch (error) {
        this.processHealthy = false
        this.processError = errorMessage(error)
        this.options.onProcessError?.(this.processError)
        for (const key of this.leases.keys()) this.emit(key)
      }

      await Promise.all([...this.leases.values()].map(async (lease) => {
        try {
          await this.options.heartbeatLease(lease)
          lease.leaseHealthy = true
          lease.lastError = null
        } catch (error) {
          lease.leaseHealthy = false
          lease.heartbeatFailures += 1
          lease.lastError = errorMessage(error)
        }
        this.emit(lease.key)
      }))
    } finally {
      this.ticking = false
    }
  }

  private emit(key: string) {
    const snapshot = this.snapshot(key)
    if (snapshot) this.options.onHealthChange?.(snapshot)
  }

  private schedule() {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule())
    }, this.intervalMs)
    this.timer.unref()
  }
}
