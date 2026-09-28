import assert from 'node:assert'
import { test } from 'node:test'
import {
  parseRealSmokeConfig,
  runDaemonProductionSmoke,
  type RealSmokeConfig,
  type RealSmokeDependencies,
  type RealSmokeProviderConfig,
  type RemoteSmokeRepository,
  type SmokeRepositoryDelivery,
} from './daemon-production-smoke.js'

function smokeEnv(): NodeJS.ProcessEnv {
  return {
    TW_REAL_SMOKE: '1',
    TW_API_URL: 'https://task-weaver.example.test',
    TW_API_KEY: 'tw-secret',
    TW_SMOKE_GITHUB_OWNER: 'smoke-org',
    TW_SMOKE_GITHUB_CREDENTIAL_PROFILE: 'github-smoke',
    GH_TOKEN: 'github-primary-secret',
    TW_SMOKE_GITHUB_REVIEW_TOKEN: 'github-review-secret',
    TW_SMOKE_GITEA_HOST: 'git.example.test',
    TW_SMOKE_GITEA_OWNER: 'smoke-org',
    TW_SMOKE_GITEA_CREDENTIAL_PROFILE: 'gitea-smoke',
    GITEA_TOKEN: 'gitea-primary-secret',
    TW_SMOKE_GITEA_REVIEW_TOKEN: 'gitea-review-secret',
  }
}

test('real smoke configuration is explicit, bounded, and requires independent reviewers', () => {
  assert.throws(() => parseRealSmokeConfig({}), /TW_REAL_SMOKE=1/)
  const config = parseRealSmokeConfig(smokeEnv(), { timeoutSeconds: 600 })
  assert.deepEqual(config.providers.map((provider) => provider.provider), ['github', 'gitea'])
  assert.equal(config.timeoutMs, 600_000)
  assert.equal(config.requirementCount, 2)
  assert.equal(config.providers[1]?.apiBaseUrl, 'https://git.example.test/api/v1')

  const sharedToken = smokeEnv()
  sharedToken.TW_SMOKE_GITHUB_REVIEW_TOKEN = sharedToken.GH_TOKEN
  assert.throws(() => parseRealSmokeConfig(sharedToken), /different actor/)
})

function fakeConfig(): RealSmokeConfig {
  const provider = (
    name: 'github' | 'gitea',
    host: string,
  ): RealSmokeProviderConfig => ({
    provider: name,
    host,
    owner: 'smoke-org',
    ownerType: 'organization',
    credentialProfileRef: `${name}-smoke`,
    apiBaseUrl: `https://${host}/api/v1`,
    primaryToken: `${name}-primary`,
    reviewerToken: `${name}-reviewer`,
  })
  return {
    apiUrl: 'https://task-weaver.example.test',
    apiKey: 'test-key',
    actorId: 'smoke-test',
    aiTool: 'codex',
    providers: [provider('github', 'github.com'), provider('gitea', 'git.example.test')],
    timeoutMs: 10_000,
    pollIntervalMs: 1,
    requirementCount: 2,
    keepOnFailure: false,
    runId: '20260724000000-deadbeef',
    commitSha: 'abc1234',
  }
}

test('real smoke orchestrates several requirements, protected provider approvals, terminal delivery, and cleanup', async () => {
  const config = fakeConfig()
  const requirements: Array<{ id: string; status: string; title: string }> = []
  const repositories: RemoteSmokeRepository[] = []
  const catalogIds: string[] = []
  const links = new Map<string, SmokeRepositoryDelivery[]>()
  const approvals = new Set<string>()
  const cleanup: string[] = []
  let pipelineStopped = false

  const dependencies: RealSmokeDependencies = {
    controlPlane: {
      async createProject() { return { id: 'project-smoke' } },
      async createCatalogRepository(repository) {
        const id = `catalog-${repository.provider}`
        repositories.push(repository)
        catalogIds.push(id)
        return { id }
      },
      async createRequirement(_projectId, input) {
        const requirement = {
          id: `requirement-${requirements.length + 1}`,
          status: String(input.status),
          title: String(input.title),
        }
        requirements.push(requirement)
        links.set(requirement.id, [])
        return requirement
      },
      async createTask() { return { id: 'task-smoke' } },
      async linkRepository(requirementId, input) {
        const repositoryId = String(input.repositoryId)
        const repository = repositories[catalogIds.indexOf(repositoryId)]!
        links.get(requirementId)!.push({
          link: {
            id: `${requirementId}-${repository.provider}`,
            deliveryStatus: 'in_review',
            pullRequestExternalId: `${requirementId}-${repository.provider === 'github' ? '101' : '202'}`,
            pushedCommit: `${requirementId}-${repository.provider}-head`,
          },
          repository: {
            id: repositoryId,
            provider: repository.provider,
            canonicalKey: `${repository.host}/${repository.owner}/${repository.name}`,
          },
        })
      },
      async setReviewPolicy() {},
      async approveRequirement(requirementId) {
        requirements.find((requirement) => requirement.id === requirementId)!.status = 'approved'
      },
      async getRequirement(requirementId) {
        const requirement = requirements.find((candidate) => candidate.id === requirementId)!
        const expectedApprovals = requirements.length * repositories.length
        if (approvals.size === expectedApprovals) requirement.status = 'done'
        return requirement
      },
      async listDeliveries(requirementId) {
        const deliveries = links.get(requirementId)!
        for (const delivery of deliveries) {
          if (approvals.has(`${delivery.repository.provider}:${delivery.link.pullRequestExternalId}`)) {
            delivery.link.deliveryStatus = 'merged'
          }
        }
        return deliveries
      },
      async cancelRequirement(requirementId) { cleanup.push(`requirement:${requirementId}`) },
      async archiveProject(projectId) { cleanup.push(`project:${projectId}`) },
      async archiveCatalogRepository(repositoryId) { cleanup.push(`catalog:${repositoryId}`) },
    },
    forge: {
      async createRepository(provider, name) {
        return {
          provider: provider.provider,
          host: provider.host,
          owner: provider.owner,
          name,
          webUrl: `https://${provider.host}/${provider.owner}/${name}`,
          httpsCloneUrl: `https://${provider.host}/${provider.owner}/${name}.git`,
          credentialProfileRef: provider.credentialProfileRef,
        }
      },
      async protectMain() {},
      async approvePullRequest(provider, _repository, externalId) {
        approvals.add(`${provider.provider}:${externalId}`)
      },
      async deleteRepository(_provider, repository) { cleanup.push(`remote:${repository.provider}`) },
    },
    pipeline: {
      async start() {
        return {
          exited: new Promise(() => undefined),
          async stop() { pipelineStopped = true },
        }
      },
    },
    async sleep() {},
    log() {},
  }

  const report = await runDaemonProductionSmoke(config, dependencies)

  assert.equal(report.approvals, 4)
  assert.equal(report.commitSha, 'abc1234')
  assert.equal(report.deliveries, 4)
  assert.equal(report.cleanedUp, true)
  assert.equal(pipelineStopped, true)
  assert.deepEqual(requirements.map((requirement) => requirement.status), ['done', 'done'])
  assert.ok(cleanup.includes('project:project-smoke'))
  assert.equal(cleanup.filter((entry) => entry.startsWith('remote:')).length, 2)
  assert.equal(cleanup.filter((entry) => entry.startsWith('catalog:')).length, 2)
})

test('failed real smoke stops the pipeline and cleans every disposable resource', async () => {
  const config = { ...fakeConfig(), requirementCount: 1 }
  let pipelineStopped = false
  const cleanup: string[] = []
  const dependencies: RealSmokeDependencies = {
    controlPlane: {
      async createProject() { return { id: 'project-failure' } },
      async createCatalogRepository(repository) { return { id: `catalog-${repository.provider}` } },
      async createRequirement() { return { id: 'requirement-failure', status: 'draft', title: 'failure' } },
      async createTask() { return { id: 'task-failure' } },
      async linkRepository() {},
      async setReviewPolicy() {},
      async approveRequirement() {},
      async getRequirement() { return { id: 'requirement-failure', status: 'approved', title: 'failure' } },
      async listDeliveries() { return [] },
      async cancelRequirement(id) { cleanup.push(`requirement:${id}`) },
      async archiveProject(id) { cleanup.push(`project:${id}`) },
      async archiveCatalogRepository(id) { cleanup.push(`catalog:${id}`) },
    },
    forge: {
      async createRepository(provider, name) {
        return {
          provider: provider.provider,
          host: provider.host,
          owner: provider.owner,
          name,
          webUrl: `https://${provider.host}/${provider.owner}/${name}`,
          httpsCloneUrl: `https://${provider.host}/${provider.owner}/${name}.git`,
          credentialProfileRef: provider.credentialProfileRef,
        }
      },
      async protectMain() {},
      async approvePullRequest() {},
      async deleteRepository(_provider, repository) { cleanup.push(`remote:${repository.provider}`) },
    },
    pipeline: {
      async start() {
        return {
          exited: Promise.resolve({ code: 17, output: 'doctor rejected unavailable credential profile' }),
          async stop() { pipelineStopped = true },
        }
      },
    },
    async sleep() { await new Promise((resolve) => setImmediate(resolve)) },
    log() {},
  }

  await assert.rejects(
    runDaemonProductionSmoke(config, dependencies),
    /pipeline exited early \(17\).*credential profile/,
  )
  assert.equal(pipelineStopped, true)
  assert.ok(cleanup.includes('requirement:requirement-failure'))
  assert.equal(cleanup.filter((entry) => entry.startsWith('remote:')).length, 2)
})
