import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryWorkerRunner } from './daemon-delivery-worker.js'
import type { WorkerState, RequirementLane } from './daemon-worker-types.js'

test('delivery attempts preserve fencing, cancellation and cleanup ownership', async t => {
  for (const outcome of ['complete', 'cancelled', 'lease_lost', 'read_failed', 'release_failed'] as const) {
    await t.test(outcome, async t => {
      const requirementId = randomUUID()
      t.after(() => rm(join(homedir(), '.task-weaver', 'requirement-workspaces', requirementId), { recursive: true, force: true }))
      const events: string[] = []
      const controller = new AbortController()
      const worker = {
        index: 0, activeProcess: false, currentRequirementId: null, currentTaskId: null,
        requirementTitle: null, startedAt: null, worktreePath: null, runId: 'run-fixture', leaseGeneration: 7,
      } as WorkerState
      const lane: RequirementLane = {
        requirement: { id: requirementId, title: 'Delivery fixture', projectId: randomUUID(), workflowRevision: 1,
          workflow: { delivery: { mode: 'skip', method: 'none' }, acceptance: { mode: 'skip' }, integration: { mode: 'skip', method: 'none' } } },
        task: null, tasks: [], repositories: [], runId: 'run-fixture', leaseGeneration: 7,
      }
      let healthy = true
      const run = createDeliveryWorkerRunner({
        daemonId: 'daemon-fixture', cliConfig: { apiUrl: 'http://unused.invalid' }, workers: [worker], once: true,
        leaseSupervisor: { assertHealthy: () => { if (!healthy) throw new Error('lease ended'); return { key: '0', requirementId, generation: 7, healthy: true, heartbeatFailures: 0, lastError: null } }, unregister: () => { events.push('unregister') } },
        daemonGet: async <T>(path: string): Promise<T> => {
          if (path.endsWith('workflow-outputs')) {
            if (outcome === 'read_failed') throw new Error('read failed')
            if (outcome === 'cancelled') controller.abort('fixture cancellation')
            if (outcome === 'lease_lost') healthy = false
            return [] as T
          }
          return { workflowStateRevision: 3 } as T
        },
        daemonPost: async <T>(path: string, body: unknown): Promise<T> => {
          const data = body as Record<string, unknown>
          if (path.endsWith('/release') || path.endsWith('/workflow-advance')) {
            assert.equal(data.runId, lane.runId); assert.equal(data.leaseGeneration, 7)
            events.push(path.endsWith('/release') ? 'release' : 'advance')
            if (path.endsWith('/release') && outcome === 'release_failed') throw new Error('release unavailable')
          }
          return {} as T
        },
        daemonPatch: async <T>(): Promise<T> => ({} as T), selectTool: () => null, buildArgv: () => [],
        verifyLocalWorkflowOutputs: async () => {},
        reportDaemonStatus: async status => { events.push(status) },
        stopDaemon: async (_status, code) => { events.push(`stop:${code}`) }, resetBackoff: () => {}, schedulePoll: () => {},
      })
      if (['complete', 'release_failed'].includes(outcome)) await run(worker, lane, controller.signal)
      else await assert.rejects(run(worker, lane, controller.signal))
      assert.equal(worker.activeProcess, false); assert.equal(worker.currentRequirementId, null)
      assert.equal(worker.runId, null); assert.equal(worker.leaseGeneration, null); assert.equal(worker.worktreePath, null)
      assert.equal(events.filter(event => event === 'release').length, 1)
      assert.ok(events.indexOf('release') < events.indexOf('unregister'))
      assert.equal(events.includes('advance'), ['complete', 'release_failed'].includes(outcome))
      assert.equal(events.includes('stop:0'), ['complete', 'release_failed'].includes(outcome))
    })
  }
})
