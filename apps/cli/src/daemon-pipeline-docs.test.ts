import assert from 'node:assert'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { loadDaemonPipelineConfig } from './daemon-pipeline-config.js'

const repositoryRoot = resolve(process.cwd(), '../..')

test('documented daemon pipeline configuration remains valid', () => {
  const config = loadDaemonPipelineConfig(resolve(repositoryRoot, 'examples/daemon-pipeline/pipeline.yaml'))
  assert.equal(config.version, 1)
  assert.equal(config.roles.executor.workers, 2)
  assert.deepEqual(config.roles.reviewer.checks, ['pnpm typecheck', 'pnpm test'])
  assert.equal(config.roles.merger.enabled, true)
  assert.equal(config.environment.TW_API_KEY?.fromEnv, 'TASK_WEAVER_API_KEY')
})

test('systemd, launchd, and container examples use service mode and graceful supervision', async () => {
  const exampleRoot = resolve(repositoryRoot, 'examples/daemon-pipeline')
  const [systemd, launchd, compose] = await Promise.all([
    readFile(resolve(exampleRoot, 'systemd/task-weaver-pipeline.service'), 'utf8'),
    readFile(resolve(exampleRoot, 'launchd/com.task-weaver.pipeline.plist'), 'utf8'),
    readFile(resolve(exampleRoot, 'docker-compose.yml'), 'utf8'),
  ])

  assert.match(systemd, /daemon pipeline start --config .* --service/)
  assert.match(systemd, /Restart=on-failure/)
  assert.match(systemd, /ExecStop=\/bin\/kill -TERM \$MAINPID/)
  assert.match(launchd, /<string>--service<\/string>/)
  assert.match(launchd, /<key>SuccessfulExit<\/key>/)
  assert.match(compose, /- --service/)
  assert.match(compose, /stop_grace_period: 90s/)
})

test('operator runbook covers lifecycle, diagnostics, logs, and exit behavior', async () => {
  const runbook = await readFile(resolve(repositoryRoot, 'docs/daemon-pipeline-runbook.md'), 'utf8')
  for (const command of ['doctor', 'pause', 'drain', 'resume', 'restart', 'stop', 'logs']) {
    assert.match(runbook, new RegExp(`tw daemon pipeline ${command}`))
  }
  assert.match(runbook, /SIGINT or SIGTERM/)
  assert.match(runbook, /launchd/)
  assert.match(runbook, /systemd/)
  assert.match(runbook, /Docker Compose/)
})

test('production validation documents every release-blocking SLO and evidence command', async () => {
  const validation = await readFile(resolve(repositoryRoot, 'docs/daemon-production-validation.md'), 'utf8')
  for (const objective of [
    'Acquisition latency p95',
    'Heartbeat gap p99',
    'Completion rate',
    'Retry recovery rate',
    'Stranded lanes',
    'Review duration p95',
    'Merge latency p95',
    'Recovery time p95',
  ]) {
    assert.match(validation, new RegExp(objective))
  }
  assert.match(validation, /tw daemon pipeline release-gate/)
  assert.match(validation, /SHA-256-digested evidence artifact/)
  assert.match(validation, /Do not promote a commit from the deterministic test result alone/)
})
