import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { extname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as { load(input: string): unknown }

export const PIPELINE_CONFIG_VERSION = 1 as const
export const PIPELINE_ROLES = ['executor', 'reviewer', 'merger'] as const
export const PIPELINE_MODEL_TIERS = ['fast', 'standard', 'strong'] as const
export const PIPELINE_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

export function defaultPipelineRoot() {
  return resolve(homedir(), '.task-weaver', 'pipelines')
}

export type PipelineRole = (typeof PIPELINE_ROLES)[number]
export type PipelineModelTier = (typeof PIPELINE_MODEL_TIERS)[number]
export type PipelineReasoningEffort = (typeof PIPELINE_REASONING_EFFORTS)[number]
export type PipelineRunMode = 'foreground' | 'service'

interface PipelineRoleBase {
  enabled: boolean
  workers: number
}

export interface PipelineExecutorConfig extends PipelineRoleBase {
  tools: string[]
  capabilities: string[]
  queueMode?: 'polling' | 'sse'
  models: Partial<Record<PipelineModelTier, string>>
  reasoningEffort: Partial<Record<PipelineModelTier, PipelineReasoningEffort>>
  prompts: string[]
  promptFiles: string[]
}

export interface PipelineReviewerConfig extends PipelineRoleBase {
  tools: string[]
  models: Partial<Record<PipelineModelTier, string>>
  reasoningEffort: Partial<Record<PipelineModelTier, PipelineReasoningEffort>>
  checks: string[]
  prompts: string[]
  promptFiles: string[]
  skipAiReview: boolean
  allowUnreviewed: boolean
  postForgeSummary: boolean
}

export interface PipelineMergerConfig extends PipelineRoleBase {}

export interface PipelineEnvironmentReference {
  fromEnv: string
  required: boolean
}

export interface DaemonPipelineConfig {
  version: typeof PIPELINE_CONFIG_VERSION
  projectId: string
  baseBranch: string
  runMode: PipelineRunMode
  roles: {
    executor: PipelineExecutorConfig
    reviewer: PipelineReviewerConfig
    merger: PipelineMergerConfig
  }
  retry: {
    maxRestarts: number
    initialBackoffMs: number
    maxBackoffMs: number
  }
  limits: {
    maxActiveRoles: number
    shutdownGraceMs: number
    controlPollMs: number
  }
  mergePolicy: {
    mode: 'direct' | 'provider' | 'manual'
  }
  environment: Record<string, PipelineEnvironmentReference>
  logging: {
    directory: string
    maxBytes: number
    maxFiles: number
  }
  sourcePath: string
}

export class PipelineConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid daemon pipeline configuration:\n- ${issues.join('\n- ')}`)
    this.name = 'PipelineConfigError'
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function objectAt(value: unknown, path: string, issues: string[]) {
  if (isRecord(value)) return value
  if (value !== undefined) issues.push(`${path} must be an object`)
  return {} as Record<string, unknown>
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key} is not supported by configuration version 1`)
  }
}

function stringAt(value: unknown, path: string, issues: string[], fallback?: string) {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !value.trim()) {
    issues.push(`${path} must be a non-empty string`)
    return fallback ?? ''
  }
  return value.trim()
}

function booleanAt(value: unknown, path: string, issues: string[], fallback: boolean) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    issues.push(`${path} must be a boolean`)
    return fallback
  }
  return value
}

function integerAt(
  value: unknown,
  path: string,
  issues: string[],
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    issues.push(`${path} must be an integer from ${minimum} to ${maximum}`)
    return fallback
  }
  return Number(value)
}

function stringArrayAt(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    issues.push(`${path} must be an array of non-empty strings`)
    return []
  }
  return [...new Set(value.map((entry) => String(entry).trim()))]
}

function enumAt<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  issues: string[],
  fallback: T,
) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    issues.push(`${path} must be one of ${allowed.join(', ')}`)
    return fallback
  }
  return value as T
}

function modelMapAt(value: unknown, path: string, issues: string[]) {
  const input = objectAt(value, path, issues)
  assertKnownKeys(input, PIPELINE_MODEL_TIERS, path, issues)
  const output: Partial<Record<PipelineModelTier, string>> = {}
  for (const tier of PIPELINE_MODEL_TIERS) {
    if (input[tier] !== undefined) output[tier] = stringAt(input[tier], `${path}.${tier}`, issues)
  }
  return output
}

function effortMapAt(value: unknown, path: string, issues: string[]) {
  const input = objectAt(value, path, issues)
  assertKnownKeys(input, PIPELINE_MODEL_TIERS, path, issues)
  const output: Partial<Record<PipelineModelTier, PipelineReasoningEffort>> = {}
  for (const tier of PIPELINE_MODEL_TIERS) {
    if (input[tier] !== undefined) {
      output[tier] = enumAt(
        input[tier],
        PIPELINE_REASONING_EFFORTS,
        `${path}.${tier}`,
        issues,
        'medium',
      )
    }
  }
  return output
}

function parseExecutor(value: unknown, issues: string[], sourceDirectory: string): PipelineExecutorConfig {
  const path = 'roles.executor'
  const input = objectAt(value, path, issues)
  assertKnownKeys(input, [
    'enabled', 'workers', 'tools', 'capabilities', 'queueMode', 'models', 'reasoningEffort',
    'prompts', 'promptFiles',
  ], path, issues)
  const promptFiles = stringArrayAt(input.promptFiles, `${path}.promptFiles`, issues)
    .map((file) => resolve(sourceDirectory, file))
  const queueMode = input.queueMode === undefined
    ? undefined
    : enumAt(input.queueMode, ['polling', 'sse'] as const, `${path}.queueMode`, issues, 'polling')
  return {
    enabled: booleanAt(input.enabled, `${path}.enabled`, issues, true),
    workers: integerAt(input.workers, `${path}.workers`, issues, 1, 1, 64),
    tools: stringArrayAt(input.tools, `${path}.tools`, issues),
    capabilities: stringArrayAt(input.capabilities, `${path}.capabilities`, issues),
    ...(queueMode === undefined ? {} : { queueMode }),
    models: modelMapAt(input.models, `${path}.models`, issues),
    reasoningEffort: effortMapAt(input.reasoningEffort, `${path}.reasoningEffort`, issues),
    prompts: stringArrayAt(input.prompts, `${path}.prompts`, issues),
    promptFiles,
  }
}

function parseReviewer(value: unknown, issues: string[], sourceDirectory: string): PipelineReviewerConfig {
  const path = 'roles.reviewer'
  const input = objectAt(value, path, issues)
  assertKnownKeys(input, [
    'enabled', 'workers', 'tools', 'models', 'reasoningEffort', 'checks', 'prompts', 'promptFiles',
    'skipAiReview', 'allowUnreviewed', 'postForgeSummary',
  ], path, issues)
  const promptFiles = stringArrayAt(input.promptFiles, `${path}.promptFiles`, issues)
    .map((file) => resolve(sourceDirectory, file))
  return {
    enabled: booleanAt(input.enabled, `${path}.enabled`, issues, true),
    workers: integerAt(input.workers, `${path}.workers`, issues, 1, 1, 64),
    tools: stringArrayAt(input.tools, `${path}.tools`, issues),
    models: modelMapAt(input.models, `${path}.models`, issues),
    reasoningEffort: effortMapAt(input.reasoningEffort, `${path}.reasoningEffort`, issues),
    checks: stringArrayAt(input.checks, `${path}.checks`, issues),
    prompts: stringArrayAt(input.prompts, `${path}.prompts`, issues),
    promptFiles,
    skipAiReview: booleanAt(input.skipAiReview, `${path}.skipAiReview`, issues, false),
    allowUnreviewed: booleanAt(input.allowUnreviewed, `${path}.allowUnreviewed`, issues, false),
    postForgeSummary: booleanAt(input.postForgeSummary, `${path}.postForgeSummary`, issues, false),
  }
}

function parseMerger(value: unknown, issues: string[]): PipelineMergerConfig {
  const path = 'roles.merger'
  const input = objectAt(value, path, issues)
  assertKnownKeys(input, ['enabled', 'workers'], path, issues)
  return {
    enabled: booleanAt(input.enabled, `${path}.enabled`, issues, true),
    workers: integerAt(input.workers, `${path}.workers`, issues, 1, 1, 64),
  }
}

function parseEnvironment(value: unknown, issues: string[]) {
  const input = objectAt(value, 'environment', issues)
  const output: Record<string, PipelineEnvironmentReference> = {}
  for (const [target, rawReference] of Object.entries(input)) {
    if (!ENV_NAME_PATTERN.test(target)) {
      issues.push(`environment.${target} is not a valid environment variable name`)
      continue
    }
    if (typeof rawReference === 'string') {
      if (!ENV_NAME_PATTERN.test(rawReference)) {
        issues.push(`environment.${target} must reference a valid environment variable name`)
      } else {
        output[target] = { fromEnv: rawReference, required: true }
      }
      continue
    }
    const reference = objectAt(rawReference, `environment.${target}`, issues)
    assertKnownKeys(reference, ['fromEnv', 'required'], `environment.${target}`, issues)
    const fromEnv = stringAt(reference.fromEnv, `environment.${target}.fromEnv`, issues)
    if (fromEnv && !ENV_NAME_PATTERN.test(fromEnv)) {
      issues.push(`environment.${target}.fromEnv must be a valid environment variable name`)
    }
    output[target] = {
      fromEnv,
      required: booleanAt(reference.required, `environment.${target}.required`, issues, true),
    }
  }
  return output
}

export function parseDaemonPipelineConfig(value: unknown, sourcePath = '<inline>'): DaemonPipelineConfig {
  const issues: string[] = []
  const input = objectAt(value, 'config', issues)
  assertKnownKeys(input, [
    'version', 'projectId', 'baseBranch', 'runMode', 'roles', 'retry', 'limits', 'mergePolicy',
    'environment', 'logging',
  ], 'config', issues)

  if (input.version !== PIPELINE_CONFIG_VERSION) {
    issues.push(`version must be ${PIPELINE_CONFIG_VERSION}; received ${String(input.version)}`)
  }
  const projectId = stringAt(input.projectId, 'projectId', issues)
  if (projectId && !UUID_PATTERN.test(projectId)) issues.push('projectId must be a UUID')

  const roles = objectAt(input.roles, 'roles', issues)
  assertKnownKeys(roles, PIPELINE_ROLES, 'roles', issues)
  const sourceDirectory = sourcePath === '<inline>' ? process.cwd() : resolve(sourcePath, '..')
  const executor = parseExecutor(roles.executor, issues, sourceDirectory)
  const reviewer = parseReviewer(roles.reviewer, issues, sourceDirectory)
  const merger = parseMerger(roles.merger, issues)
  if (
    reviewer.enabled
    && reviewer.skipAiReview
    && reviewer.checks.length === 0
    && !reviewer.allowUnreviewed
  ) {
    issues.push('roles.reviewer needs checks, AI review, or an explicit allowUnreviewed override')
  }

  const retry = objectAt(input.retry, 'retry', issues)
  assertKnownKeys(retry, ['maxRestarts', 'initialBackoffMs', 'maxBackoffMs'], 'retry', issues)
  const initialBackoffMs = integerAt(retry.initialBackoffMs, 'retry.initialBackoffMs', issues, 1_000, 0, 300_000)
  const maxBackoffMs = integerAt(retry.maxBackoffMs, 'retry.maxBackoffMs', issues, 30_000, 0, 3_600_000)
  if (maxBackoffMs < initialBackoffMs) {
    issues.push('retry.maxBackoffMs must be greater than or equal to retry.initialBackoffMs')
  }

  const limits = objectAt(input.limits, 'limits', issues)
  assertKnownKeys(limits, ['maxActiveRoles', 'shutdownGraceMs', 'controlPollMs'], 'limits', issues)
  const enabledRoleCount = [executor, reviewer, merger].filter((role) => role.enabled).length
  const maxActiveRoles = integerAt(limits.maxActiveRoles, 'limits.maxActiveRoles', issues, 3, 1, 3)
  if (enabledRoleCount === 0) issues.push('at least one daemon role must be enabled')
  if (enabledRoleCount > maxActiveRoles) {
    issues.push(`limits.maxActiveRoles is ${maxActiveRoles}, but ${enabledRoleCount} roles are enabled`)
  }

  const mergePolicyInput = objectAt(input.mergePolicy, 'mergePolicy', issues)
  assertKnownKeys(mergePolicyInput, ['mode'], 'mergePolicy', issues)
  const mergeMode = enumAt(
    mergePolicyInput.mode,
    ['direct', 'provider', 'manual'],
    'mergePolicy.mode',
    issues,
    'direct',
  )
  if (merger.enabled && mergeMode === 'manual') {
    issues.push("roles.merger must be disabled when mergePolicy.mode is 'manual'")
  }

  const baseBranch = stringAt(input.baseBranch, 'baseBranch', issues, 'main')
  const runMode = enumAt(input.runMode, ['foreground', 'service'], 'runMode', issues, 'foreground')
  const maxRestarts = integerAt(retry.maxRestarts, 'retry.maxRestarts', issues, 3, 0, 100)
  const shutdownGraceMs = integerAt(
    limits.shutdownGraceMs,
    'limits.shutdownGraceMs',
    issues,
    30_000,
    1_000,
    600_000,
  )
  const controlPollMs = integerAt(limits.controlPollMs, 'limits.controlPollMs', issues, 500, 100, 10_000)
  const environment = parseEnvironment(input.environment, issues)
  const logging = objectAt(input.logging, 'logging', issues)
  assertKnownKeys(logging, ['directory', 'maxBytes', 'maxFiles'], 'logging', issues)
  const defaultLogDirectory = defaultPipelineRoot()
  const logDirectoryValue = stringAt(logging.directory, 'logging.directory', issues, defaultLogDirectory)
  const logDirectory = resolve(sourceDirectory, logDirectoryValue)
  const maxBytes = integerAt(logging.maxBytes, 'logging.maxBytes', issues, 10 * 1024 * 1024, 64 * 1024, 1024 * 1024 * 1024)
  const maxFiles = integerAt(logging.maxFiles, 'logging.maxFiles', issues, 5, 1, 100)

  if (issues.length > 0) throw new PipelineConfigError(issues)
  return {
    version: PIPELINE_CONFIG_VERSION,
    projectId,
    baseBranch,
    runMode,
    roles: { executor, reviewer, merger },
    retry: {
      maxRestarts,
      initialBackoffMs,
      maxBackoffMs,
    },
    limits: {
      maxActiveRoles,
      shutdownGraceMs,
      controlPollMs,
    },
    mergePolicy: { mode: mergeMode },
    environment,
    logging: {
      directory: logDirectory,
      maxBytes,
      maxFiles,
    },
    sourcePath,
  }
}

export function loadDaemonPipelineConfig(filePath: string) {
  const sourcePath = resolve(filePath)
  const raw = readFileSync(sourcePath, 'utf8')
  const extension = extname(sourcePath).toLowerCase()
  let value: unknown
  try {
    value = extension === '.yaml' || extension === '.yml' ? yaml.load(raw) : JSON.parse(raw)
  } catch (error) {
    throw new PipelineConfigError([
      `could not parse ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    ])
  }
  return parseDaemonPipelineConfig(value, sourcePath)
}
