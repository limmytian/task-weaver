import type { Database } from '@task-weaver/db';
import { apiKeyService, authenticateExecutionDelegation, createResourceServices, createTiExecutionService, AuthorizationError, type VerifiedRequestContext } from '@task-weaver/core';
import type { PartnersGatewayConfig, PartnersGatewayWorkerConfig } from './index.js';

/** The Partners service token only authenticates Partners. This binding independently verifies TW. */
export function createGatewayTwAuthority(db: Database, config: PartnersGatewayConfig, worker: PartnersGatewayWorkerConfig, getKey: () => string | undefined) {
  let originalCredentialId: string | undefined;
  const fences = new Map<string, { workerId: string; leaseGeneration: number }>();
  const capabilities = new Map<string, { delegation: { id: string; expiresAt: string }; token: string }>();
  async function identity(): Promise<VerifiedRequestContext> {
    const key = getKey();
    if (!key || key === config.serviceToken) throw new AuthorizationError();
    const context = await apiKeyService.authenticateScopedApiKey(db, key);
    if (context.actor.type !== 'agent' || context.actor.id !== worker.actorId || context.actor.id !== worker.assignedAgentId || (originalCredentialId && originalCredentialId !== context.credential.id)) throw new AuthorizationError();
    originalCredentialId ??= context.credential.id;
    return context;
  }
  function sanitize(value: any): any {
    if (typeof value === 'string') {
      let text = value.replace(/(?:tw|twd|twb)_[0-9a-f]{64}/g, '[REDACTED]');
      for (const secret of [getKey(), config.serviceToken, ...[...capabilities.values()].map(item => item.token)]) if (secret) text = text.split(secret).join('[REDACTED]');
      return text;
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).filter(([key]) => !/apiKeyRef|authorization|tokenHash|serviceToken/i.test(key)).map(([key, item]) => [key, sanitize(item)]));
    return value;
  }
  async function invoke(name: string, runId: string, input: any = {}) {
    const fence = fences.get(runId);
    if (!fence) throw new AuthorizationError();
    const context = await identity();
    return createTiExecutionService(context).invoke(db, name, [runId, { ...sanitize(input), ...fence }]);
  }
  return {
    async validateRun(id: string) { await invoke('assertRun', id); },
    async acquireRun(_db: Database, input: any) {
      const context = await identity();
      const run = await createTiExecutionService(context).invoke(db, 'acquireRun', [input]);
      if (run) fences.set(run.id, { workerId: input.workerId, leaseGeneration: run.leaseGeneration });
      return run;
    },
    async getRun(_db: Database, id: string) {
      await invoke('assertRun', id);
      return sanitize(await createResourceServices(await identity()).tiAgentService.getRun(db, id));
    },
    async heartbeatRunLease(_db: Database, id: string, input: any) {
      const result = await invoke('heartbeatRunLease', id, input);
      const capability = capabilities.get(id);
      if (capability && Date.parse(capability.delegation.expiresAt) - Date.now() < 45_000) {
        const context = await identity();
        capabilities.set(id, await createTiExecutionService(context).renewDelegation(db, id, capability.delegation.id, fences.get(id)!));
      }
      return result;
    },
    async updateRunProgress(_db: Database, id: string, input: any) { return invoke('updateRunProgress', id, input); },
    async scheduleRunRetry(_db: Database, id: string, input: any) {
      const run = await invoke('scheduleRunRetry', id, input);
      if (run) { fences.delete(id); capabilities.delete(id); }
      return run;
    },
    async completeRun(_db: Database, id: string, input: any) {
      const run = await invoke('completeRun', id, input);
      fences.delete(id); capabilities.delete(id);
      return run;
    },
    async authorizeDispatch(id: string) {
      await invoke('assertRun', id);
      const context = await identity();
      const capability = await createTiExecutionService(context).issueDelegation(db, id, fences.get(id)!);
      capabilities.set(id, capability);
      // The existing interpreter job does not receive credentials. Only trusted tool adapters use the capability.
      return capability.delegation;
    },
    async invokeTool(id: string, operation: (services: ReturnType<typeof createResourceServices>) => Promise<unknown>) {
      await invoke('assertRun', id);
      const capability = capabilities.get(id);
      if (!capability) throw new AuthorizationError();
      const context = await authenticateExecutionDelegation(db, capability.token);
      return sanitize(await operation(createResourceServices(context)));
    },
  };
}
