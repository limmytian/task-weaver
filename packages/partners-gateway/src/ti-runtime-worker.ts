import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { Database } from "@task-weaver/db";
import { apiKeyService, createTiExecutionService, executeTiTaskAttempt, connectPartnersMcp, createTiSandboxCleanup, AuthorizationError } from "@task-weaver/core";
import type { PartnersGatewayConfig, PartnersGatewayWorkerConfig } from "./index.js";

/** Consumes the existing Ti run queue, including schedule-created runs. Cleanup is independent of user grants. */
export class TiRuntimeWorker {
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private cleanupLoop: Promise<void> | null = null;
  private activeRunId: string | null = null;
  private lastError: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastPollAt: string | null = null;
  private startedAt: string | null = null;
  private workerId: string;
  private binding;
  private cleanup;

  constructor(private db: Database, config: PartnersGatewayConfig, private options: PartnersGatewayWorkerConfig, private env: NodeJS.ProcessEnv) {
    const url = env.PARTNERS_MCP_URL ?? `${config.baseUrl!.replace(/\/+$/, "")}/mcp`;
    if (!config.tenantId || !config.projectId) throw new Error("Shared Ti requires an explicit Partners tenant and project");
    const bindingId = createHash("sha256").update(JSON.stringify([url, config.tenantId, config.projectId])).digest("hex");
    this.binding = { id: `partners:${bindingId}`, tenantId: config.tenantId, projectId: config.projectId,
      adapter: connectPartnersMcp({ id: `ti-partners:${bindingId}`, url, serviceToken: config.serviceToken!, partition: bindingId }) };
    this.cleanup = createTiSandboxCleanup(db, async id => {
      if (id !== this.binding.id) throw new Error("Unknown owned sandbox binding");
      return this.binding;
    });
    this.workerId = options.workerId ?? `ti:${hostname()}:${process.pid}`;
  }
  async identity() {
    if (!this.env.TW_PARTNERS_GATEWAY_API_KEY) throw new AuthorizationError();
    const context = await apiKeyService.authenticateScopedApiKey(this.db, this.env.TW_PARTNERS_GATEWAY_API_KEY);
    if (context.actor.type !== "agent" || context.actor.id !== this.options.actorId || context.actor.id !== this.options.assignedAgentId) throw new AuthorizationError();
    return context;
  }
  start() {
    if (this.loop) return;
    this.controller = new AbortController();
    this.startedAt = new Date().toISOString();
    this.loop = this.runLoop(this.controller.signal);
    this.cleanupLoop = this.reclaimLoop(this.controller.signal);
  }
  async stop() {
    this.controller?.abort();
    await Promise.allSettled([this.loop, this.cleanupLoop]);
    this.loop = null; this.cleanupLoop = null;
  }
  wake() { /* Existing run queue is checked on the bounded worker interval. */ }
  getStatus() {
    return { enabled: true, running: !!this.loop, runtime: "shared-ti", workerId: this.workerId,
      assignedAgentId: this.options.assignedAgentId, activeRunId: this.activeRunId, lastError: this.lastError,
      startedAt: this.startedAt, lastPollAt: this.lastPollAt, lastCompletedAt: this.lastCompletedAt };
  }
  async cleanupMetrics() { return this.cleanup.metrics(); }
  async runOnce(signal: AbortSignal) {
    const identity = await this.identity();
    const supervisor = createTiExecutionService(identity);
    this.lastPollAt = new Date().toISOString();
    const run = await supervisor.invoke(this.db, "acquireRun", [{ assignedAgentId: this.options.assignedAgentId,
      workerId: this.workerId, durationMinutes: this.options.leaseDurationMinutes }]);
    if (!run) return false;
    const fence = { workerId: this.workerId, leaseGeneration: run.leaseGeneration };
    this.activeRunId = run.id;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let validation = Promise.resolve();
    const heartbeat = setInterval(() => {
      validation = validation.then(async () => {
        await this.identity();
        await supervisor.invoke(this.db, "heartbeatRunLease", [run.id, { ...fence, durationMinutes: this.options.leaseDurationMinutes }]);
      }).catch(() => controller.abort(new Error("Ti authority or lease was revoked")));
    }, Math.min(1000, this.options.heartbeatIntervalMs));
    try {
      const result = await executeTiTaskAttempt(this.db, identity, run.id, fence, this.binding, controller.signal);
      controller.signal.throwIfAborted();
      await supervisor.invoke(this.db, "completeRun", [run.id, { ...result, ...fence }]);
      this.lastError = null; this.lastCompletedAt = new Date().toISOString();
    } catch {
      this.lastError = controller.signal.aborted ? "Ti attempt interrupted; persisted work awaits recovery" : "Ti execution failed; inspect run history";
      if (!controller.signal.aborted) await supervisor.invoke(this.db, "completeRun", [run.id, { ...fence, status: "failed", errorMessage: this.lastError }]).catch(() => undefined);
    } finally {
      clearInterval(heartbeat); signal.removeEventListener("abort", abort); await validation; this.activeRunId = null;
    }
    return true;
  }
  private async runLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      try { if (await this.runOnce(signal)) continue; }
      catch { this.lastError = "Ti worker authorization or acquisition failed"; }
      await pause(this.options.idlePollIntervalMs, signal);
    }
  }
  private async reclaimLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      try { await this.cleanup.reconcileOrphans(); for (let i = 0; i < 5 && !signal.aborted && await this.cleanup.runOnce(); i++) { /* Bounded owned-resource batch. */ } }
      catch { this.lastError = "Owned sandbox cleanup requires attention"; }
      await pause(1000, signal);
    }
  }
}
function pause(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    const abort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
