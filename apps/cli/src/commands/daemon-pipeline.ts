import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import {
  buildDaemonReleaseEvidence,
} from '@task-weaver/core/daemon-release-gate'
import type { DaemonRealSmokeEvidence, DaemonSloReport } from '@task-weaver/contracts'
import {
  PIPELINE_ROLES,
  defaultPipelineRoot,
  loadDaemonPipelineConfig,
  type PipelineRole,
} from '../daemon-pipeline-config.js'
import {
  buildPipelineLaunchPlan,
  resolvePipelineEnvironment,
  runDaemonPipeline,
} from '../daemon-pipeline.js'
import { runPipelinePreflight, type PipelinePreflightResult } from '../daemon-pipeline-preflight.js'
import {
  PipelineRuntimeStore,
  enqueuePipelineControl,
  listPipelineStates,
  readPipelineLogs,
  readPipelineState,
  type PipelineControlAction,
  type PipelineLogLevel,
} from '../daemon-pipeline-store.js'
import { loadConfig } from '../config.js'
import { get } from '../client.js'
import {
  createRealSmokeDependencies,
  parseRealSmokeConfig,
  runDaemonProductionSmoke,
} from '../daemon-production-smoke.js'
import { printJson, printTable } from '../output.js'

function printablePlan(plan: ReturnType<typeof buildPipelineLaunchPlan>) {
  return {
    runId: plan.runId,
    runMode: plan.runMode,
    roles: plan.roles.map(({ role, instanceId, command, args }) => ({
      role,
      instanceId,
      command,
      args,
    })),
  }
}

function printPreflight(result: PipelinePreflightResult) {
  printTable(result.checks as unknown as Record<string, unknown>[], [
    'status', 'name', 'role', 'repository', 'detail', 'failureCode',
  ])
  console.log(result.ready ? 'Pipeline preflight passed.' : 'Pipeline preflight failed.')
}

function parseRole(value: string | undefined): PipelineRole | undefined {
  if (value === undefined) return undefined
  if (!PIPELINE_ROLES.includes(value as PipelineRole)) {
    throw new Error(`Role must be one of ${PIPELINE_ROLES.join(', ')}`)
  }
  return value as PipelineRole
}

function parseLogLevel(value: string | undefined): PipelineLogLevel | undefined {
  if (value === undefined) return undefined
  const levels: PipelineLogLevel[] = ['debug', 'info', 'warn', 'error']
  if (!levels.includes(value as PipelineLogLevel)) {
    throw new Error(`Log level must be one of ${levels.join(', ')}`)
  }
  return value as PipelineLogLevel
}

function addRuntimeTargetOptions(command: Command) {
  return command
    .requiredOption('--run <id>', 'pipeline run ID')
    .option('--root <path>', 'pipeline runtime root', defaultPipelineRoot())
    .option('--role <role>', 'executor|reviewer|merger')
    .option('--json', 'output raw JSON')
}

function writeEvidenceFile(path: string, value: unknown) {
  const target = resolve(path)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return target
}

export function registerDaemonPipeline(daemon: Command) {
  const pipeline = daemon
    .command('pipeline')
    .description('run executor, reviewer, and merger roles as one supervised pipeline')

  pipeline
    .command('validate')
    .description('validate a versioned daemon pipeline configuration file')
    .requiredOption('-f, --config <path>', 'pipeline configuration file (.json, .yaml, or .yml)')
    .option('--json', 'output the normalized configuration as JSON')
    .action((opts) => {
      const config = loadDaemonPipelineConfig(opts.config)
      if (opts.json) return printJson(config)
      console.log(`Pipeline configuration is valid (version ${config.version}, project ${config.projectId}).`)
    })

  pipeline
    .command('doctor')
    .description('check API, tools, credentials, repositories, checks, and worktree readiness')
    .requiredOption('-f, --config <path>', 'pipeline configuration file (.json, .yaml, or .yml)')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const config = loadDaemonPipelineConfig(opts.config)
      const result = await runPipelinePreflight(config, {
        environment: resolvePipelineEnvironment(config),
      })
      if (opts.json) printJson(result)
      else printPreflight(result)
      if (!result.ready) process.exitCode = 1
    })

  pipeline
    .command('smoke')
    .description('run the opt-in disposable real AI and GitHub/Gitea production smoke gate')
    .option('--providers <names>', 'comma-separated github,gitea providers')
    .option('--ai-tool <tool>', 'real AI CLI used by executor and reviewer')
    .option('--timeout <seconds>', 'bounded smoke timeout in seconds')
    .option('--keep-on-failure', 'retain disposable resources after a failed run for investigation')
    .option('--evidence <path>', 'write the redacted real-smoke evidence JSON')
    .option('--json', 'output the redacted smoke report as JSON')
    .action(async (opts) => {
      const timeoutSeconds = opts.timeout === undefined ? undefined : Number(opts.timeout)
      const config = parseRealSmokeConfig(process.env, {
        providers: opts.providers,
        aiTool: opts.aiTool,
        timeoutSeconds,
        keepOnFailure: opts.keepOnFailure ? true : undefined,
      })
      const report = await runDaemonProductionSmoke(config, createRealSmokeDependencies(config))
      if (opts.evidence) writeEvidenceFile(opts.evidence, report)
      if (opts.json) return printJson(report)
      console.log(
        `Daemon production smoke ${report.runId} passed: ${report.requirementIds.length} Requirements, `
        + `${report.deliveries} merged deliveries, ${report.approvals} independent approvals; cleanup complete.`,
      )
    })

  pipeline
    .command('release-gate')
    .description('combine deterministic, real-smoke, and live SLO evidence into a release decision')
    .requiredOption('--smoke-evidence <path>', 'real-smoke evidence JSON from this commit')
    .requiredOption('--commit <sha>', 'release candidate commit SHA')
    .requiredOption('--output <path>', 'release evidence JSON output path')
    .option('--window-hours <hours>', 'live SLO evidence window', '168')
    .option('--deterministic-passed', 'attest that the deterministic reliability gate passed in this job')
    .option('--deterministic-command <command>', 'recorded deterministic gate command', 'pnpm test:daemon-reliability')
    .option('--workflow-run-url <url>', 'CI workflow run URL')
    .option('--json', 'output raw release evidence as JSON')
    .action(async (opts) => {
      if (!opts.deterministicPassed) {
        throw new Error('Release gate requires --deterministic-passed from the same fail-fast CI job')
      }
      const windowHours = Number(opts.windowHours)
      if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 24 * 30) {
        throw new Error('--window-hours must be an integer from 1 to 720')
      }
      const smoke = JSON.parse(readFileSync(resolve(opts.smokeEvidence), 'utf8')) as DaemonRealSmokeEvidence
      if (!smoke.runId || !smoke.commitSha || !Array.isArray(smoke.providers)) {
        throw new Error('Smoke evidence is missing runId, commitSha, or providers')
      }
      const slo = await get<DaemonSloReport>(`/daemons/slo?windowHours=${windowHours}`)
      const inferredWorkflowRunUrl = process.env.GITHUB_SERVER_URL
        && process.env.GITHUB_REPOSITORY
        && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null
      const evidence = buildDaemonReleaseEvidence({
        commitSha: opts.commit,
        deterministicGate: {
          passed: true,
          command: opts.deterministicCommand,
          workflowRunUrl: opts.workflowRunUrl || inferredWorkflowRunUrl,
        },
        realSmoke: smoke,
        slo,
      })
      const target = writeEvidenceFile(opts.output, evidence)
      if (opts.json) printJson(evidence)
      else console.log(`Daemon release decision: ${evidence.decision}; evidence written to ${target}.`)
      if (evidence.decision !== 'ready') process.exitCode = 1
    })

  pipeline
    .command('start')
    .description('start and supervise all enabled daemon roles')
    .requiredOption('-f, --config <path>', 'pipeline configuration file (.json, .yaml, or .yml)')
    .option('--service', 'override run mode for launchd, systemd, or container supervision')
    .option('--dry-run', 'validate and print child commands without starting them')
    .option('--json', 'output launch information as JSON')
    .action(async (opts) => {
      const config = loadDaemonPipelineConfig(opts.config)
      const preflight = await runPipelinePreflight(config, {
        environment: resolvePipelineEnvironment(config),
      })
      if (!preflight.ready) {
        if (opts.json) printJson(preflight)
        else printPreflight(preflight)
        process.exitCode = 1
        return
      }
      const plan = buildPipelineLaunchPlan(config, {
        runMode: opts.service ? 'service' : config.runMode,
      })
      if (opts.dryRun) {
        if (opts.json) return printJson(printablePlan(plan))
        console.log(`Pipeline run ${plan.runId} (${plan.runMode}) would start:`)
        for (const launch of plan.roles) {
          console.log(`- ${launch.role}: instance ${launch.instanceId}, ${launch.args.slice(-8).join(' ')}`)
        }
        return
      }
      const store = new PipelineRuntimeStore(config, plan)
      store.append({
        event: 'preflight_passed',
        level: 'info',
        message: `Pipeline preflight passed with ${preflight.checks.length} checks.`,
        metadata: { checks: preflight.checks },
      })
      const exitCode = await runDaemonPipeline(config, plan, { store })
      process.exitCode = exitCode
    })

  pipeline
    .command('list')
    .description('list local supervised pipeline runs')
    .option('--root <path>', 'pipeline runtime root', defaultPipelineRoot())
    .option('--json', 'output raw JSON')
    .action((opts) => {
      const items = listPipelineStates(opts.root)
      if (opts.json) return printJson({ items })
      printTable(items as unknown as Record<string, unknown>[], [
        'runId', 'projectId', 'runMode', 'status', 'supervisorPid', 'startedAt', 'updatedAt', 'exitCode',
      ])
    })

  addRuntimeTargetOptions(pipeline.command('status').description('show one local pipeline run'))
    .action((opts) => {
      const state = readPipelineState(opts.root, opts.run)
      const role = parseRole(opts.role)
      const output = role ? { ...state, roles: { [role]: state.roles[role] } } : state
      if (opts.json) return printJson(output)
      printTable(
        Object.values(output.roles).filter(Boolean) as unknown as Record<string, unknown>[],
        ['role', 'status', 'desiredState', 'instanceId', 'pid', 'restartCount', 'startedAt', 'lastExitCode', 'lastFailureCode'],
      )
      console.log(`Run ${state.runId}: ${state.status}, supervisor PID ${state.supervisorPid}`)
    })

  const registerControl = (action: PipelineControlAction, description: string) => {
    addRuntimeTargetOptions(pipeline.command(action).description(description))
      .action((opts) => {
        const cliConfig = loadConfig()
        const command = enqueuePipelineControl(opts.root, opts.run, {
          action,
          role: parseRole(opts.role),
          requestedBy: cliConfig.actorId ?? cliConfig.clientId ?? 'tw-cli',
        })
        if (opts.json) return printJson(command)
        console.log(`Queued ${action} for pipeline ${opts.run}${command.role ? ` role ${command.role}` : ''}.`)
      })
  }
  registerControl('pause', 'drain and pause acquisition for one role or the whole pipeline')
  registerControl('drain', 'drain one role or all roles and leave them stopped')
  registerControl('resume', 'resume a paused or stopped role')
  registerControl('restart', 'drain and restart one role or all roles')
  registerControl('stop', 'gracefully stop one role or the whole pipeline')

  pipeline
    .command('logs')
    .description('query bounded local structured pipeline logs')
    .requiredOption('--run <id>', 'pipeline run ID')
    .option('--root <path>', 'pipeline runtime root', defaultPipelineRoot())
    .option('--role <role>', 'executor|reviewer|merger')
    .option('--level <level>', 'debug|info|warn|error')
    .option('--event <event>', 'event name')
    .option('--requirement <id>', 'Requirement ID')
    .option('--task <id>', 'task ID')
    .option('--repository <key>', 'repository canonical key')
    .option('--since <timestamp>', 'ISO timestamp lower bound')
    .option('--limit <n>', 'maximum matching events', '100')
    .option('--json', 'output raw JSON')
    .action((opts) => {
      const items = readPipelineLogs(opts.root, opts.run, {
        role: parseRole(opts.role),
        level: parseLogLevel(opts.level),
        event: opts.event,
        requirementId: opts.requirement,
        taskId: opts.task,
        repository: opts.repository,
        since: opts.since,
        limit: Number(opts.limit),
      })
      if (opts.json) return printJson({ items })
      printTable(items as unknown as Record<string, unknown>[], [
        'timestamp', 'level', 'event', 'role', 'workerIndex', 'requirementId', 'taskId', 'repository',
        'durationMs', 'retry', 'failureCode', 'message',
      ])
    })
}
