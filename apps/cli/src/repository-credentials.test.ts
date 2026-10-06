import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAiEnvironment, redactTrustedOutput, resolveRepositoryCredential } from './repository-credentials.js'

test('AI environment excludes Git and provider credentials', () => {
  const env = buildAiEnvironment({
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    TW_API_URL: 'http://task-weaver.test',
    TW_API_KEY: 'task-weaver-only',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    GIT_ASKPASS: '/tmp/askpass',
    GITHUB_TOKEN: 'canary-github-token',
    AWS_SECRET_ACCESS_KEY: 'canary-cloud-secret',
  })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.TW_API_KEY, undefined)
  assert.equal(env.SSH_AUTH_SOCK, undefined)
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(env.GIT_ASKPASS, '/usr/bin/false')
})

test('SSH readiness requires explicit consent, an agent, and verified host state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-repository-credential-'))
  const socket = join(root, 'agent.sock')
  const knownHosts = join(root, 'known_hosts')
  await writeFile(socket, '')
  await writeFile(knownHosts, 'git.example.test ssh-ed25519 AAAA-test')
  try {
    const result = resolveRepositoryCredential({
      apiUrl: 'http://task-weaver.test',
      actorId: 'actor-1',
      nodeId: 'node-1',
      repositoryCredentialProfiles: {
        profile: {
          kind: 'ssh-agent',
          host: 'git.example.test',
          transport: 'ssh',
          allowedOperations: ['read', 'push'],
          actorId: 'actor-1',
          nodeId: 'node-1',
          consent: 'personal',
          status: 'active',
          revision: 3,
          knownHostsPath: knownHosts,
        },
      },
    }, {
      id: 'repository-1',
      provider: 'generic',
      host: 'git.example.test',
      sshCloneUrl: 'git@git.example.test:team/repository.git',
      authPolicy: { credentialProfileRef: 'profile', preferredTransport: 'ssh', revision: 4 },
    }, 'push', undefined, { SSH_AUTH_SOCK: socket, PATH: '/usr/bin' }, () => ({
      status: 0,
      stdout: 'git.example.test ssh-ed25519 AAAA-test\n',
      stderr: '',
    }))
    assert.equal(result.state, 'available')
    assert.equal(result.reasonCode, 'ssh_agent_ready')
    assert.equal(result.policyRevision, 4)
    assert.equal(result.profileRevision, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('revocation and changed SSH host state fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tw-repository-revoked-'))
  const socket = join(root, 'agent.sock')
  const knownHosts = join(root, 'known_hosts')
  await writeFile(socket, '')
  await writeFile(knownHosts, '')
  try {
    const baseConfig = {
      apiUrl: 'http://task-weaver.test',
      actorId: 'actor-1',
      nodeId: 'node-1',
      repositoryCredentialProfiles: {
        profile: {
          kind: 'ssh-agent' as const,
          host: 'git.example.test',
          transport: 'ssh' as const,
          allowedOperations: ['read' as const],
          consent: 'personal' as const,
          status: 'revoked' as const,
          revision: 5,
          knownHostsPath: knownHosts,
        },
      },
    }
    const repository = {
      id: 'repository-1', provider: 'generic', host: 'git.example.test',
      sshCloneUrl: 'git@git.example.test:team/repository.git',
      authPolicy: { credentialProfileRef: 'profile' },
    }
    const revoked = resolveRepositoryCredential(baseConfig, repository, 'read', 'ssh', { SSH_AUTH_SOCK: socket })
    assert.equal(revoked.reasonCode, 'credential_profile_revoked')

    baseConfig.repositoryCredentialProfiles.profile.status = 'active' as never
    const changedHost = resolveRepositoryCredential(baseConfig, repository, 'read', 'ssh', { SSH_AUTH_SOCK: socket }, () => ({
      status: 1, stdout: '', stderr: 'not found',
    }))
    assert.equal(changedHost.reasonCode, 'ssh_host_not_verified')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('HTTPS readiness accepts a system-level macOS keychain helper', () => {
  const result = resolveRepositoryCredential({
    apiUrl: 'http://task-weaver.test',
    actorId: 'actor-1',
    nodeId: 'node-1',
    repositoryCredentialProfiles: {
      profile: {
        kind: 'system-keychain',
        host: 'git.example.test',
        provider: 'gitea',
        transport: 'https',
        allowedOperations: ['read', 'push', 'forge'],
        nodeId: 'node-1',
        consent: 'node-shared',
        status: 'active',
        revision: 2,
      },
    },
  }, {
    id: 'repository-1',
    provider: 'gitea',
    host: 'git.example.test',
    httpsCloneUrl: 'https://git.example.test/team/repository.git',
  }, 'forge', undefined, { PATH: '/usr/bin' }, () => ({
    status: 0,
    stdout: 'unknown\tosxkeychain\n',
    stderr: '',
  }))

  assert.equal(result.state, 'available')
  assert.equal(result.reasonCode, 'system_keychain_ready')
  assert.deepEqual(result.trustedGitConfig?.slice(-2), ['-c', 'credential.helper=osxkeychain'])
})

test('a global empty helper resets inherited system helpers', () => {
  const result = resolveRepositoryCredential({
    apiUrl: 'http://task-weaver.test',
    repositoryCredentialProfiles: {
      profile: {
        kind: 'system-keychain',
        host: 'git.example.test',
        transport: 'https',
        allowedOperations: ['read'],
        consent: 'personal',
        status: 'active',
        revision: 1,
      },
    },
  }, {
    id: 'repository-1',
    provider: 'generic',
    host: 'git.example.test',
    httpsCloneUrl: 'https://git.example.test/team/repository.git',
  }, 'read', undefined, { PATH: '/usr/bin' }, () => ({
    status: 0,
    stdout: 'unknown\tosxkeychain\nglobal\t\n',
    stderr: '',
  }))

  assert.equal(result.state, 'unavailable')
  assert.equal(result.reasonCode, 'git_helper_unavailable')
})

test('trusted operation output is bounded and redacted', () => {
  const value = redactTrustedOutput('https://user:password@git.test/repo?token=canary ghp_supersecret')
  assert.doesNotMatch(value, /password|canary|supersecret/)
  assert.match(value, /redacted/)
})
