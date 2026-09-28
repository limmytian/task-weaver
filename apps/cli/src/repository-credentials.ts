import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawnSync, type SpawnSyncReturns } from 'child_process'
import type { Config, RepositoryCredentialProfile } from './config.js'

export type RepositoryOperation = 'read' | 'push' | 'forge'
export type RepositoryTransport = 'ssh' | 'https'
export type CredentialReadinessState = 'available' | 'needs_configuration' | 'denied' | 'unavailable' | 'unknown'

export interface RepositoryAuthPolicy {
  allowedTransports?: RepositoryTransport[]
  preferredTransport?: RepositoryTransport
  allowedOperations?: RepositoryOperation[]
  hostKeyPolicyRef?: string
  credentialProfileRef?: string
  allowNativeDefault?: boolean
  revision?: number
}

export interface CredentialRepository {
  id: string
  provider: string
  host: string
  sshCloneUrl?: string | null
  httpsCloneUrl?: string | null
  authPolicy?: RepositoryAuthPolicy | null
}

export interface CredentialResolution {
  state: CredentialReadinessState
  reasonCode: string
  transport: RepositoryTransport
  operation: RepositoryOperation
  policyRevision: number
  checkedAt: string
  profileRevision?: number
  trustedEnvironment?: NodeJS.ProcessEnv
  trustedGitConfig?: string[]
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; encoding: 'utf8' },
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr'>

const AI_ENVIRONMENT_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'CI', 'NO_COLOR',
  'TW_API_URL', 'TW_API_KEY', 'TW_ACTOR_ID', 'TW_ACTOR_TYPE', 'TW_CLIENT_ID', 'TW_NODE_ID',
])
const SECRET_ENVIRONMENT_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION|COOKIE|SESSION|ASKPASS|SSH_AUTH_SOCK|GIT_SSH|GH_|GITHUB_|GITLAB_)/i

export function buildAiEnvironment(source: NodeJS.ProcessEnv, additions: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (AI_ENVIRONMENT_KEYS.has(key) || key.startsWith('LC_')) result[key] = value
  }
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined && !SECRET_ENVIRONMENT_KEY.test(key)) result[key] = value
  }
  result.GIT_TERMINAL_PROMPT = '0'
  result.GIT_ASKPASS = '/usr/bin/false'
  result.SSH_ASKPASS = '/usr/bin/false'
  return result
}

function normalizedHost(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

function selectProfile(
  config: Config,
  repository: CredentialRepository,
  operation: RepositoryOperation,
  transport: RepositoryTransport,
): RepositoryCredentialProfile | null {
  const policy = repository.authPolicy ?? {}
  const profiles = config.repositoryCredentialProfiles ?? {}
  if (policy.credentialProfileRef) return profiles[policy.credentialProfileRef] ?? null

  const candidates = Object.values(profiles).filter((profile) =>
    profile.status === 'active'
    && normalizedHost(profile.host) === normalizedHost(repository.host)
    && profile.transport === transport
    && profile.allowedOperations.includes(operation)
    && (!profile.provider || profile.provider === repository.provider)
    && (!profile.nodeId || profile.nodeId === config.nodeId)
    && (!profile.actorId || profile.actorId === config.actorId),
  )
  if (candidates.length !== 1) return null
  return candidates[0]!
}

function knownHostsPath(profile?: RepositoryCredentialProfile | null) {
  return profile?.knownHostsPath ?? join(homedir(), '.ssh', 'known_hosts')
}

function hostIsKnown(host: string, path: string, run: CommandRunner) {
  if (!existsSync(path)) return false
  const result = run('ssh-keygen', ['-F', host, '-f', path], { encoding: 'utf8' })
  return result.status === 0 && Boolean(result.stdout.trim())
}

function configuredGitHelpers(run: CommandRunner) {
  const helpers: string[] = []
  const result = run('git', ['config', '--show-scope', '--get-all', 'credential.helper'], { encoding: 'utf8' })
  if (result.status !== 0) return helpers
  const values = result.stdout.replace(/\r/g, '').split('\n')
  if (values.at(-1) === '') values.pop()
  for (const value of values) {
    const separator = value.indexOf('\t')
    if (separator < 0) continue
    const scope = value.slice(0, separator)
    if (!['system', 'global', 'unknown'].includes(scope)) continue
    const helper = value.slice(separator + 1)
    if (helper === '') {
      helpers.length = 0
    } else {
      helpers.push(helper)
    }
  }
  return helpers
}

export function resolveRepositoryCredential(
  config: Config,
  repository: CredentialRepository,
  operation: RepositoryOperation,
  requestedTransport?: RepositoryTransport,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  run: CommandRunner = (command, args, options) => spawnSync(command, args, options),
): CredentialResolution {
  const policy = repository.authPolicy ?? {}
  const transport = requestedTransport
    ?? policy.preferredTransport
    ?? (repository.sshCloneUrl ? 'ssh' : 'https')
  const base = {
    transport,
    operation,
    policyRevision: policy.revision ?? 1,
    checkedAt: new Date().toISOString(),
  }
  if (!(policy.allowedOperations ?? ['read', 'push', 'forge']).includes(operation)) {
    return { ...base, state: 'denied', reasonCode: 'operation_denied_by_policy' }
  }
  if (!(policy.allowedTransports ?? ['ssh', 'https']).includes(transport)) {
    return { ...base, state: 'denied', reasonCode: 'transport_denied_by_policy' }
  }
  if (transport === 'ssh' && !repository.sshCloneUrl) {
    return { ...base, state: 'needs_configuration', reasonCode: 'ssh_endpoint_missing' }
  }
  if (transport === 'https' && !repository.httpsCloneUrl) {
    return { ...base, state: 'needs_configuration', reasonCode: 'https_endpoint_missing' }
  }

  const profile = selectProfile(config, repository, operation, transport)
  if (policy.credentialProfileRef && !profile) {
    return { ...base, state: 'needs_configuration', reasonCode: 'credential_profile_missing' }
  }
  if (profile?.status === 'revoked') {
    return { ...base, state: 'unavailable', reasonCode: 'credential_profile_revoked', profileRevision: profile.revision }
  }
  if (profile && !profile.allowedOperations.includes(operation)) {
    return { ...base, state: 'denied', reasonCode: 'profile_operation_denied', profileRevision: profile.revision }
  }
  if (!profile && !policy.allowNativeDefault) {
    return { ...base, state: 'needs_configuration', reasonCode: 'explicit_consent_required' }
  }

  if (transport === 'ssh') {
    if (profile && profile.kind !== 'ssh-agent') {
      return { ...base, state: 'denied', reasonCode: 'profile_transport_mismatch', profileRevision: profile.revision }
    }
    if (!sourceEnvironment.SSH_AUTH_SOCK || !existsSync(sourceEnvironment.SSH_AUTH_SOCK)) {
      return { ...base, state: 'unavailable', reasonCode: 'ssh_agent_unavailable', profileRevision: profile?.revision }
    }
    const hostsFile = knownHostsPath(profile)
    if (!hostIsKnown(repository.host, hostsFile, run)) {
      return { ...base, state: 'denied', reasonCode: 'ssh_host_not_verified', profileRevision: profile?.revision }
    }
    return {
      ...base,
      state: 'available',
      reasonCode: 'ssh_agent_ready',
      profileRevision: profile?.revision,
      trustedEnvironment: {
        ...sourceEnvironment,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${hostsFile}`,
      },
      trustedGitConfig: ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null'],
    }
  }

  if (profile && !['git-helper', 'system-keychain'].includes(profile.kind)) {
    return { ...base, state: 'denied', reasonCode: 'profile_transport_mismatch', profileRevision: profile.revision }
  }
  const helpers = configuredGitHelpers(run)
  if (helpers.length === 0) {
    return { ...base, state: 'unavailable', reasonCode: 'git_helper_unavailable', profileRevision: profile?.revision }
  }
  if (profile?.kind === 'system-keychain' && !helpers.some((helper) => /(osxkeychain|manager|libsecret)/i.test(helper))) {
    return { ...base, state: 'unavailable', reasonCode: 'system_keychain_helper_unavailable', profileRevision: profile.revision }
  }
  return {
    ...base,
    state: 'available',
    reasonCode: profile?.kind === 'system-keychain' ? 'system_keychain_ready' : 'git_helper_ready',
    profileRevision: profile?.revision,
    trustedEnvironment: { ...sourceEnvironment, GIT_TERMINAL_PROMPT: '0' },
    trustedGitConfig: [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'credential.useHttpPath=true',
      '-c', 'credential.helper=',
      ...helpers.flatMap((value) => ['-c', `credential.helper=${value}`]),
    ],
  }
}

export function redactTrustedOutput(value: string): string {
  return value
    .replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, '://[redacted]@')
    .replace(/([?&](?:access_?token|api_?key|password|secret|token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:ghp|glpat|github_pat)_[A-Za-z0-9_-]+\b/g, '[redacted]')
    .slice(0, 4000)
}
