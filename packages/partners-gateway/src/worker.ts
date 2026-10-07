import { createGatewayTwAuthority } from './tw-authority.js';
import type { Database } from "@task-weaver/db";
import { hostname } from "node:os";
import {
  buildGatewayJobRequestFromTiRun,
  buildTiAgentRunPrompt,
  buildTiCompletionFromGateway,
  createPartnersGatewayClient,
  getPartnersGatewayWorkerConfig,
  isTransientGatewayError,
  normalizeGatewayArtifactReferences,
  type PartnersGatewayConfig,
  type PartnersGatewayJob,
  type PartnersGatewayWorkerConfig,
} from "@task-weaver/partners-gateway";
import { type Actor, tiAgentService } from "@task-weaver/core";

const TERMINAL_STATES = new Set<PartnersGatewayJob["state"]>([
  "cancelled",
  "succeeded",
  "failed",
  "timed_out",
]);

type GatewayClient = ReturnType<typeof createPartnersGatewayClient>;

export type TiAgentGatewayWorkerOptions = {
  actor: Actor;
  assignedAgentId: string;
  workerId: string;
  leaseDurationMinutes: number;
  heartbeatIntervalMs: number;
  progressFlushIntervalMs: number;
  idlePollIntervalMs: number;
  statusPollIntervalMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
};

type WorkerDependencies = {
  validateRun?: (id: string) => Promise<void>;
  authorizeDispatch?: (id: string) => Promise<import("@task-weaver/contracts").ExecutionDelegation>;
  acquireRun: typeof tiAgentService.acquireRun;
  getRun: typeof tiAgentService.getRun;
  heartbeatRunLease: typeof tiAgentService.heartbeatRunLease;
  updateRunProgress: typeof tiAgentService.updateRunProgress;
  scheduleRunRetry: typeof tiAgentService.scheduleRunRetry;
  completeRun: typeof tiAgentService.completeRun;
  wait: typeof waitFor;
  now: () => number;
  log: Pick<Console, "info" | "error">;
};

const defaultDependencies: WorkerDependencies = {
  acquireRun: tiAgentService.acquireRun,
  getRun: tiAgentService.getRun,
  heartbeatRunLease: tiAgentService.heartbeatRunLease,
  updateRunProgress: tiAgentService.updateRunProgress,
  scheduleRunRetry: tiAgentService.scheduleRunRetry,
  completeRun: tiAgentService.completeRun,
  wait: waitFor,
  now: Date.now,
  log: console,
};

export class TiAgentGatewayWorker {
  private controller: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private activeRunId: string | null = null;
  private startedAt: string | null = null;
  private lastPollAt: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastError: string | null = null;
  private idleController: AbortController | null = null;

  constructor(
    private readonly db: Database,
    private readonly gatewayClient: GatewayClient,
    private readonly gatewayConfig: PartnersGatewayConfig,
    private readonly options: TiAgentGatewayWorkerOptions,
    private readonly dependencies: WorkerDependencies = defaultDependencies,
  ) {}

  start() {
    if (this.loopPromise) return;
    this.controller = new AbortController();
    this.startedAt = new Date().toISOString();
    this.loopPromise = this.runLoop(this.controller.signal);
    this.dependencies.log.info(`Partners Gateway Ti worker '${this.options.workerId}' started`);
  }

  getStatus() {
    return {
      enabled: true,
      running: this.loopPromise !== null,
      workerId: this.options.workerId,
      assignedAgentId: this.options.assignedAgentId,
      activeRunId: this.activeRunId,
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt,
      lastCompletedAt: this.lastCompletedAt,
      lastError: this.lastError,
    };
  }

  async stop() {
    if (!this.loopPromise) return;
    this.controller?.abort();
    this.idleController?.abort();
    await this.loopPromise;
    this.controller = null;
    this.loopPromise = null;
    this.dependencies.log.info(`Partners Gateway Ti worker '${this.options.workerId}' stopped`);
  }

  wake() {
    this.idleController?.abort();
  }

  async runOnce(signal: AbortSignal): Promise<boolean> {
    this.lastPollAt = new Date().toISOString();
    const run = await this.dependencies.acquireRun(this.db, {
      assignedAgentId: this.options.assignedAgentId,
      workerId: this.options.workerId,
      durationMinutes: this.options.leaseDurationMinutes,
    }, this.options.actor);
    if (!run) return false;
    if (signal.aborted) return true;
    this.activeRunId = run.id;
    this.lastError = null;

    let sessionIdToCleanup: string | null = null;

    try {
      await this.dependencies.validateRun?.(run.id);
      const detailedRun = await this.dependencies.getRun(this.db, run.id);
      if (signal.aborted) return true;
      const prompt = buildTiAgentRunPrompt(detailedRun);
      let job = await this.gatewayClient.createJob(buildGatewayJobRequestFromTiRun({
        run: detailedRun,
        prompt,
        config: this.gatewayConfig,
        authority: await this.dependencies.authorizeDispatch?.(run.id),
      }));
      sessionIdToCleanup = job.sessionId ?? job.id;
      const events: Parameters<typeof buildTiCompletionFromGateway>[0]["events"] = [];
      let nextProgressFlushAt = this.dependencies.now() + this.options.progressFlushIntervalMs;
      let heartbeatFailure: unknown;
      let heartbeatInFlight = Promise.resolve();
      const streamController = new AbortController();
      const abortStream = () => streamController.abort();
      signal.addEventListener("abort", abortStream, { once: true });
      const heartbeatTimer = setInterval(() => {
        heartbeatInFlight = heartbeatInFlight
          .then(() => this.dependencies.validateRun?.(run.id))
          .then(() => this.dependencies.heartbeatRunLease(this.db, run.id, {
            workerId: this.options.workerId,
            durationMinutes: this.options.leaseDurationMinutes,
          }, this.options.actor))
          .then(() => undefined)
          .catch((error: unknown) => {
            heartbeatFailure = error;
            streamController.abort();
            if (sessionIdToCleanup) void this.gatewayClient.deleteSession(sessionIdToCleanup).catch(() => undefined);
          });
      }, this.dependencies.validateRun ? Math.min(1_000, this.options.heartbeatIntervalMs) : this.options.heartbeatIntervalMs);

      try {
        if (!TERMINAL_STATES.has(job.state)) {
          for await (const event of this.gatewayClient.streamEvents(job.id, {
            signal: streamController.signal,
          })) {
            await this.dependencies.validateRun?.(run.id);
            events.push(event);
            if (events.length > 500) events.splice(0, events.length - 500);
            if (event.state) job = { ...job, state: event.state };
            const shouldFlush = this.dependencies.now() >= nextProgressFlushAt
              || TERMINAL_STATES.has(job.state);
            if (shouldFlush) {
              const progress = buildTiCompletionFromGateway({ job, events });
              await this.dependencies.updateRunProgress(this.db, run.id, {
                workerId: this.options.workerId,
                actualProvider: progress.actualProvider,
                actualModel: progress.actualModel,
                sandboxSessionId: progress.sandboxSessionId,
                eventLog: progress.eventLog ?? [],
                outputSummary: progress.outputSummary,
              }, this.options.actor);
              nextProgressFlushAt = this.dependencies.now() + this.options.progressFlushIntervalMs;
            }
            if (TERMINAL_STATES.has(job.state)) break;
          }
        }

        if (heartbeatFailure) throw heartbeatFailure;
        if (signal.aborted) return true;
        if (!TERMINAL_STATES.has(job.state)) job = await this.gatewayClient.getJob(job.id);

        while (!TERMINAL_STATES.has(job.state)) {
          if (!await this.dependencies.wait(this.options.statusPollIntervalMs, signal)) {
            return true;
          }
          if (heartbeatFailure) throw heartbeatFailure;
          await this.dependencies.validateRun?.(run.id);
          job = await this.gatewayClient.getJob(job.id);
        }
      } finally {
        clearInterval(heartbeatTimer);
        signal.removeEventListener("abort", abortStream);
        streamController.abort();
        await heartbeatInFlight;
      }

      await this.dependencies.completeRun(
        this.db,
        run.id,
        await this.buildTerminalCompletion(job, events),
        this.options.actor,
      );
      this.lastCompletedAt = new Date().toISOString();
      return true;
    } catch (error) {
      if (signal.aborted) return true;
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message.slice(0, 8000);
      if (isTransientGatewayError(error)) {
        const delayMs = tiAgentService.tiAgentRetryBackoffMs(
          run.retryCount + 1,
          this.options.retryBaseDelayMs,
          this.options.retryMaxDelayMs,
        );
        const retry = await this.dependencies.scheduleRunRetry(this.db, run.id, {
          workerId: this.options.workerId,
          errorMessage: message,
          delayMs,
        }, this.options.actor);
        if (retry) {
          this.dependencies.log.info(
            `Partners Gateway Ti run '${run.id}' retry ${retry.retryCount}/${retry.maxRetries} scheduled for ${retry.nextAttemptAt?.toISOString()}`,
          );
          return true;
        }
      }
      await this.dependencies.completeRun(this.db, run.id, {
        status: "failed",
        actualProvider: "partners-gateway",
        errorMessage: message.slice(0, 8000),
      }, this.options.actor).catch((completionError: unknown) => {
        this.dependencies.log.error("Failed to record Partners Gateway Ti run failure", completionError);
      });
      throw error;
    } finally {
      if (sessionIdToCleanup) {
        await this.gatewayClient.deleteSession(sessionIdToCleanup).catch((cleanupErr) => {
          this.dependencies.log.error(`Failed to delete sandbox workspace for session ${sessionIdToCleanup}`, cleanupErr);
        });
      }
      this.activeRunId = null;
    }
  }

  private async buildTerminalCompletion(
    job: PartnersGatewayJob,
    events: Parameters<typeof buildTiCompletionFromGateway>[0]["events"],
  ) {
    const artifacts = await this.gatewayClient.listArtifacts(job.id);
    const completion = buildTiCompletionFromGateway({ job, events });
    const artifactReferences = normalizeGatewayArtifactReferences(artifacts.items);
    return {
      ...completion,
      costMetadata: {
        ...completion.costMetadata,
        gatewayArtifactCount: artifacts.items.length,
        gatewayArtifacts: artifactReferences,
        gatewayArtifactsTruncated: artifacts.items.length > artifactReferences.length,
      },
    };
  }

  private async runLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const processed = await this.runOnce(signal);
        if (!processed && !await this.waitUntilNextPoll(signal)) return;
      } catch (error) {
        this.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 8000);
        this.dependencies.log.error("Partners Gateway Ti worker iteration failed", error);
        if (!await this.waitUntilNextPoll(signal)) return;
      }
    }
  }

  private async waitUntilNextPoll(signal: AbortSignal): Promise<boolean> {
    const idleController = new AbortController();
    this.idleController = idleController;
    const abortIdle = () => idleController.abort();
    signal.addEventListener("abort", abortIdle, { once: true });
    try {
      await this.dependencies.wait(this.options.idlePollIntervalMs, idleController.signal);
      return !signal.aborted;
    } finally {
      signal.removeEventListener("abort", abortIdle);
      this.idleController = null;
    }
  }
}

export function createTiAgentGatewayWorkerFromEnv(
  db: Database,
  gatewayConfig: PartnersGatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!gatewayConfig.enabled) return null;
  const workerConfig = getPartnersGatewayWorkerConfig(env);
  return createTiAgentGatewayWorker(db, gatewayConfig, workerConfig, () => env.TW_PARTNERS_GATEWAY_API_KEY);
}

export function createTiAgentGatewayWorker(
  db: Database,
  gatewayConfig: PartnersGatewayConfig,
  workerConfig: PartnersGatewayWorkerConfig,
  getProductKey: () => string | undefined = () => undefined,
) {
  if (!gatewayConfig.enabled) return null;
  return new TiAgentGatewayWorker(
    db,
    createPartnersGatewayClient(gatewayConfig),
    gatewayConfig,
    {
      actor: { id: workerConfig.actorId, type: "agent" },
      assignedAgentId: workerConfig.assignedAgentId,
      workerId: workerConfig.workerId || `api:${hostname()}:${process.pid}`,
      leaseDurationMinutes: workerConfig.leaseDurationMinutes,
      heartbeatIntervalMs: workerConfig.heartbeatIntervalMs,
      progressFlushIntervalMs: workerConfig.progressFlushIntervalMs,
      idlePollIntervalMs: workerConfig.idlePollIntervalMs,
      statusPollIntervalMs: workerConfig.statusPollIntervalMs,
      retryBaseDelayMs: workerConfig.retryBaseDelayMs,
      retryMaxDelayMs: workerConfig.retryMaxDelayMs,
    },
    { ...defaultDependencies, ...createGatewayTwAuthority(db, gatewayConfig, workerConfig, getProductKey) } as WorkerDependencies,
  );
}

export function getTiAgentGatewayWorkerStatus(
  config: PartnersGatewayConfig,
  worker: TiAgentGatewayWorker | null,
) {
  if (!config.enabled || !worker) {
    return {
      enabled: false,
      running: false,
      workerId: null,
      assignedAgentId: null,
      activeRunId: null,
      startedAt: null,
      lastPollAt: null,
      lastCompletedAt: null,
      lastError: null,
    };
  }
  return worker.getStatus();
}

export async function checkTiAgentGatewayHealth(config: PartnersGatewayConfig) {
  if (!config.enabled) {
    return { ok: false, enabled: false, error: "Partners Gateway is not configured" };
  }
  try {
    const gateway = await createPartnersGatewayClient(config).health();
    return { ok: true, enabled: true, gateway };
  } catch (error) {
    return {
      ok: false,
      enabled: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Aliases for compatibility
export const PiAgentGatewayWorker = TiAgentGatewayWorker;
export const createPiAgentGatewayWorker = createTiAgentGatewayWorker;
export const createPiAgentGatewayWorkerFromEnv = createTiAgentGatewayWorkerFromEnv;
export const getPiAgentGatewayWorkerStatus = getTiAgentGatewayWorkerStatus;
export const checkPiAgentGatewayHealth = checkTiAgentGatewayHealth;

function waitFor(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
