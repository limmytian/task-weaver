import type { Database } from "@task-weaver/db";
import { hostname } from "node:os";
import {
  buildGatewayJobRequestFromPiRun,
  buildPiAgentRunPrompt,
  buildPiCompletionFromGateway,
  createPartnersGatewayClient,
  getPartnersGatewayWorkerConfig,
  isTransientGatewayError,
  normalizeGatewayArtifactReferences,
  type PartnersGatewayConfig,
  type PartnersGatewayJob,
  type PartnersGatewayWorkerConfig,
} from "@task-weaver/partners-gateway";
import { type Actor, piAgentService } from "@task-weaver/core";

const TERMINAL_STATES = new Set<PartnersGatewayJob["state"]>([
  "cancelled",
  "succeeded",
  "failed",
  "timed_out",
]);

type GatewayClient = ReturnType<typeof createPartnersGatewayClient>;

export type PiAgentGatewayWorkerOptions = {
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
  acquireRun: typeof piAgentService.acquireRun;
  getRun: typeof piAgentService.getRun;
  heartbeatRunLease: typeof piAgentService.heartbeatRunLease;
  updateRunProgress: typeof piAgentService.updateRunProgress;
  scheduleRunRetry: typeof piAgentService.scheduleRunRetry;
  completeRun: typeof piAgentService.completeRun;
  wait: typeof waitFor;
  now: () => number;
  log: Pick<Console, "info" | "error">;
};

const defaultDependencies: WorkerDependencies = {
  acquireRun: piAgentService.acquireRun,
  getRun: piAgentService.getRun,
  heartbeatRunLease: piAgentService.heartbeatRunLease,
  updateRunProgress: piAgentService.updateRunProgress,
  scheduleRunRetry: piAgentService.scheduleRunRetry,
  completeRun: piAgentService.completeRun,
  wait: waitFor,
  now: Date.now,
  log: console,
};

export class PiAgentGatewayWorker {
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
    private readonly options: PiAgentGatewayWorkerOptions,
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

    try {
      const detailedRun = await this.dependencies.getRun(this.db, run.id);
      if (signal.aborted) return true;
      const prompt = buildPiAgentRunPrompt(detailedRun);
      let job = await this.gatewayClient.createJob(buildGatewayJobRequestFromPiRun({
        run: detailedRun,
        prompt,
        config: this.gatewayConfig,
      }));
      const events = [];
      let nextProgressFlushAt = this.dependencies.now() + this.options.progressFlushIntervalMs;
      let heartbeatFailure: unknown;
      let heartbeatInFlight = Promise.resolve();
      const streamController = new AbortController();
      const abortStream = () => streamController.abort();
      signal.addEventListener("abort", abortStream, { once: true });
      const heartbeatTimer = setInterval(() => {
        heartbeatInFlight = heartbeatInFlight
          .then(() => this.dependencies.heartbeatRunLease(this.db, run.id, {
            workerId: this.options.workerId,
            durationMinutes: this.options.leaseDurationMinutes,
          }, this.options.actor))
          .then(() => undefined)
          .catch((error: unknown) => {
            heartbeatFailure = error;
            streamController.abort();
          });
      }, this.options.heartbeatIntervalMs);

      try {
        if (!TERMINAL_STATES.has(job.state)) {
          for await (const event of this.gatewayClient.streamEvents(job.id, {
            signal: streamController.signal,
          })) {
            events.push(event);
            if (events.length > 500) events.splice(0, events.length - 500);
            if (event.state) job = { ...job, state: event.state };
            const shouldFlush = this.dependencies.now() >= nextProgressFlushAt
              || TERMINAL_STATES.has(job.state);
            if (shouldFlush) {
              const progress = buildPiCompletionFromGateway({ job, events });
              await this.dependencies.updateRunProgress(this.db, run.id, {
                workerId: this.options.workerId,
                actualPiProvider: progress.actualPiProvider,
                actualPiModel: progress.actualPiModel,
                piSessionId: progress.piSessionId,
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
        const delayMs = piAgentService.piAgentRetryBackoffMs(
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
        actualPiProvider: "partners-gateway",
        errorMessage: message.slice(0, 8000),
      }, this.options.actor).catch((completionError: unknown) => {
        this.dependencies.log.error("Failed to record Partners Gateway Ti run failure", completionError);
      });
      throw error;
    } finally {
      this.activeRunId = null;
    }
  }

  private async buildTerminalCompletion(
    job: PartnersGatewayJob,
    events: Parameters<typeof buildPiCompletionFromGateway>[0]["events"],
  ) {
    const artifacts = await this.gatewayClient.listArtifacts(job.id);
    const completion = buildPiCompletionFromGateway({ job, events });
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

export function createPiAgentGatewayWorkerFromEnv(
  db: Database,
  gatewayConfig: PartnersGatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!gatewayConfig.enabled) return null;
  const workerConfig = getPartnersGatewayWorkerConfig(env);
  return createPiAgentGatewayWorker(db, gatewayConfig, workerConfig);
}

export function createPiAgentGatewayWorker(
  db: Database,
  gatewayConfig: PartnersGatewayConfig,
  workerConfig: PartnersGatewayWorkerConfig,
) {
  if (!gatewayConfig.enabled) return null;
  return new PiAgentGatewayWorker(
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
  );
}

export function getPiAgentGatewayWorkerStatus(
  config: PartnersGatewayConfig,
  worker: PiAgentGatewayWorker | null,
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

export async function checkPiAgentGatewayHealth(config: PartnersGatewayConfig) {
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
