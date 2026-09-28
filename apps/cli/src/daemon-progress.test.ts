import assert from 'node:assert/strict'
import test from 'node:test'
import { daemonHistoryPath, daemonProgressPath } from './commands/daemon.js'

test('daemon progress path selects current state and encodes filters', () => {
  assert.equal(
    daemonProgressPath({
      daemonId: '00000000-0000-4000-8000-000000000001',
      requirementId: '00000000-0000-4000-8000-000000000002',
      workerIndex: 3,
      limit: 25,
    }),
    '/api/v1/daemons/progress/current?daemonId=00000000-0000-4000-8000-000000000001&requirementId=00000000-0000-4000-8000-000000000002&workerIndex=3&limit=25',
  )
})

test('daemon progress path selects append-only run history', () => {
  assert.equal(
    daemonProgressPath({
      runId: '00000000-0000-4000-8000-000000000003',
      history: true,
    }),
    '/api/v1/daemons/progress/history?runId=00000000-0000-4000-8000-000000000003&limit=50',
  )
})

test('daemon history path preserves opaque pagination and bounded log filters', () => {
  assert.equal(
    daemonHistoryPath({
      runId: '00000000-0000-4000-8000-000000000003',
      kind: 'progress',
      severity: 'warn',
      cursor: 'opaque cursor',
      logs: true,
      maxChars: 800,
    }),
    '/api/v1/observability/logs?runId=00000000-0000-4000-8000-000000000003&cursor=opaque+cursor&severity=warn&kind=progress&maxChars=800&limit=100',
  )
})
