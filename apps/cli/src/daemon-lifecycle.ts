export type DaemonLifecyclePhase = 'running' | 'draining' | 'stopped'

export class DaemonCancellationError extends Error {
  constructor(readonly reason: string) {
    super(`Daemon operation cancelled: ${reason}`)
    this.name = 'DaemonCancellationError'
  }
}

export interface DaemonOperation {
  key: string
  signal: AbortSignal
  completion: Promise<void>
  complete: () => void
}

interface OperationState {
  controller: AbortController
  completion: Promise<void>
  complete: () => void
}

export class DaemonLifecycle {
  private readonly operations = new Map<string, OperationState>()
  private currentPhase: DaemonLifecyclePhase = 'running'
  private drainPromise: Promise<void> | null = null

  get phase() {
    return this.currentPhase
  }

  get isDraining() {
    return this.currentPhase !== 'running'
  }

  get activeOperations() {
    return this.operations.size
  }

  start(key: string): DaemonOperation {
    if (this.currentPhase !== 'running') {
      throw new DaemonCancellationError('daemon is draining')
    }
    if (this.operations.has(key)) {
      throw new Error(`Daemon operation '${key}' is already active`)
    }

    const controller = new AbortController()
    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
    let completed = false
    const complete = () => {
      if (completed) return
      completed = true
      this.operations.delete(key)
      resolveCompletion()
    }
    this.operations.set(key, { controller, completion, complete })
    return { key, signal: controller.signal, completion, complete }
  }

  cancel(key: string, reason: string) {
    this.operations.get(key)?.controller.abort(new DaemonCancellationError(reason))
  }

  async drain(reason: string): Promise<void> {
    if (this.drainPromise) return this.drainPromise
    if (this.currentPhase === 'stopped') return
    this.currentPhase = 'draining'
    const cancellation = new DaemonCancellationError(reason)
    const active = [...this.operations.values()]
    for (const operation of active) operation.controller.abort(cancellation)
    this.drainPromise = Promise.allSettled(active.map((operation) => operation.completion))
      .then(() => { this.currentPhase = 'stopped' })
    return this.drainPromise
  }

  stop() {
    if (this.operations.size > 0) {
      throw new Error('Cannot stop daemon lifecycle while operations are active; drain it first')
    }
    this.currentPhase = 'stopped'
  }
}

export function cancellationReason(signal: AbortSignal): string | null {
  if (!signal.aborted) return null
  const reason = signal.reason
  if (reason instanceof DaemonCancellationError) return reason.reason
  if (reason instanceof Error) return reason.message
  return typeof reason === 'string' && reason ? reason : 'operation cancelled'
}

export function throwIfCancelled(signal: AbortSignal) {
  const reason = cancellationReason(signal)
  if (reason) throw new DaemonCancellationError(reason)
}
