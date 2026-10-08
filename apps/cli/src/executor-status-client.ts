import { createHash } from 'node:crypto'
import { executorToolSchema, executorObservationBlocks, type ExecutorObservation, type ExecutorTool } from '@task-weaver/contracts'
import { request } from './client.js'
import { loadConfig } from './config.js'
import { runCommand } from './async-command.js'
import { failureObservation, queryCodexQuota, ExecutorResourceBlocked } from './executor-availability.js'

/** One configured credential context per tool; never switch accounts/models or enable paid fallback. */
export class ExecutorStatusClient {
  private refreshes = new Map<string, Promise<void>>()
  private localBlocked = new Map<string, ExecutorObservation>()
  private versions = new Map<string, string | null>()
  constructor(private daemonId: string, private tools: string[]) {}
  profile(tool: string) {
    const config = loadConfig()
    const configured = config.executorProfiles?.[tool]
    const profileId = configured?.profileId ?? createHash('sha256').update(`${config.nodeId}:${tool}`).digest('hex')
    return { profileId, poolId: configured?.poolId ?? null }
  }
  async report(observation: ExecutorObservation) {
    if (executorObservationBlocks(observation)) this.localBlocked.set(observation.tool, observation)
    else if (observation.state === "available" && Date.parse(observation.observedAt) >= Date.parse(this.localBlocked.get(observation.tool)?.observedAt ?? "1970-01-01")) this.localBlocked.delete(observation.tool)
    const binding = this.profile(observation.tool)
    await request('POST',`/api/v1/daemons/${this.daemonId}/executors/observations`,{
      ...observation, ...binding, toolVersion: this.versions.get(observation.tool) ?? null,
    })
  }
  async profiles(): Promise<Array<{ tool: string; blocked: boolean; observation: ExecutorObservation; nextCheckAt: string | null; refreshRequestedAt: string | null }>> {
    const result = await request<{items: Array<{ tool: string; blocked: boolean; observation: ExecutorObservation; nextCheckAt: string | null; refreshRequestedAt: string | null }>}>('GET',`/api/v1/daemons/${this.daemonId}/executors`)
    return result.items
  }
  async refresh() {
    const profiles = await this.profiles()
    await Promise.all(this.tools.map(async candidate => {
      const parsed = executorToolSchema.safeParse(candidate); if (!parsed.success) return
      const tool = parsed.data, prior = profiles.find(p=>p.tool===tool)
      if (prior && !prior.refreshRequestedAt && (!prior.nextCheckAt || Date.parse(prior.nextCheckAt)>Date.now())) return
      let inFlight = this.refreshes.get(tool)
      if (!inFlight) { inFlight = this.query(tool).finally(()=>this.refreshes.delete(tool)); this.refreshes.set(tool,inFlight) }
      await inFlight
    }))
    return this.profiles()
  }
  private async query(tool: ExecutorTool) {
    if (!this.versions.has(tool)) {
      const version = await runCommand(tool,['--version'],{timeoutMs:3000,maxOutputBytes:1024})
      this.versions.set(tool,version.ok ? version.stdout.split('\n')[0]!.slice(0,100) : null)
    }
    const {profileId} = this.profile(tool)
    const observation = tool === 'codex' ? await queryCodexQuota(profileId) : {
      ...failureObservation(tool,profileId,'unknown_failure','unsupported'),failure:null,
      reason:'This tool/version has no supported nonbillable quota query. Remaining allowance is unknown.',
    }
    await this.report(observation)
  }
  async assertAvailable(tool: string) {
    const profiles = await this.refresh()
    const profile = profiles.find(p=>p.tool===tool)
    const local = this.localBlocked.get(tool)
    if (local && (!profile || Date.parse(profile.observation.observedAt) < Date.parse(local.observedAt))) throw new ExecutorResourceBlocked(local)
    if (profile && profile.blocked) throw new ExecutorResourceBlocked(profile.observation)
  }
  observer(tool: string) { return { profileId:this.profile(tool).profileId, onObservation:async (value: ExecutorObservation)=>{ try { await this.report(value) } catch { console.warn('[Daemon] Executor observation could not be persisted; local blocking remains active.') } } } }
}
