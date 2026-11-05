import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { activateContinuation } from './daemon-continuation'

const tasks = [
  { id: 'finished', status: 'done', executionSliceId: null },
  { id: 'blocked', status: 'todo', executionSliceId: null },
  { id: 'ready', status: 'todo', executionSliceId: null },
]
const ids = new Set(tasks.map(task => task.id))

test('continuation activates a task through the guarded server transition', async () => {
  const activated: string[] = []
  const next = await activateContinuation('finished', tasks, ids, null, async id => { activated.push(id) })
  assert.equal(next?.id, 'blocked')
  assert.deepEqual(activated, ['blocked'])
})

test('blocked continuation rejects before spawning and lets the caller release the lane', async () => {
  await assert.rejects(activateContinuation('finished', tasks, ids, null, async () => { throw new Error('unfinished dependency') }), /unfinished dependency/)
})

test('continuation does not activate after incomplete work or outside the original slice', async () => {
  let called = false
  const activate = async () => { called = true }
  assert.equal(await activateContinuation('ready', tasks, ids, null, activate), undefined)
  assert.equal(await activateContinuation('finished', tasks, ids, 'other-slice', activate), undefined)
  assert.equal(called, false)
})
