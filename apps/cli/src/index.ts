#!/usr/bin/env node
import { Command } from 'commander'
import { ApiError } from './client.js'
import { registerAgentUsage } from './commands/agent-usage.js'
import { registerAuth } from './commands/auth.js'
import { registerProjects } from './commands/projects.js'
import { registerRequirements } from './commands/requirements.js'
import { registerTasks } from './commands/tasks.js'
import { registerDocuments } from './commands/documents.js'
import { registerSearch } from './commands/search.js'
import { registerActivity } from './commands/activity.js'
import { registerContext } from './commands/context.js'
import { registerMcp } from './commands/mcp.js'
import { registerMemory } from './commands/memory.js'
import { registerDaemon } from './commands/daemon.js'
import { registerSchedules } from './commands/schedules.js'
import { registerPiAgent } from './commands/pi-agent.js'
import { registerPlans } from './commands/plans.js'
import { registerRepositories } from './commands/repositories.js'
import { registerEmbeddings } from './commands/embeddings.js'

const program = new Command()
  .name('tw')
  .description('Task Weaver CLI — manage projects, tasks, and documents')
  .version('0.0.1')

registerAgentUsage(program)
registerAuth(program)
registerProjects(program)
registerRequirements(program)
registerTasks(program)
registerDocuments(program)
registerSearch(program)
registerActivity(program)
registerContext(program)
registerMcp(program)
registerMemory(program)
registerDaemon(program)
registerSchedules(program)
registerPiAgent(program)
registerPlans(program)
registerRepositories(program)
registerEmbeddings(program)

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof ApiError) {
    process.stderr.write(`Error ${err.status}: ${err.message}\n`)
    if (err.body && typeof err.body === 'object' && 'details' in err.body) {
      process.stderr.write(JSON.stringify((err.body as { details: unknown }).details, null, 2) + '\n')
    }
  } else {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  }
  process.exit(1)
})
