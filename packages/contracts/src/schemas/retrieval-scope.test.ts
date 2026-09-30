import { test } from 'node:test'
import assert from 'node:assert'
import { searchContextSchema } from './documents.js'
import { searchMemorySchema } from './memory.js'

const projectId = '00000000-0000-4000-8000-000000000001'

test('retrieval scope schemas', async (t) => {
  await t.test('context search defaults to project plus global retrieval', () => {
    const result = searchContextSchema.safeParse({
      intent: 'task workflow',
      projectId,
    })

    assert.equal(result.success, true)
    if (result.success) {
      assert.equal(result.data.includeGlobal, true)
      assert.equal(result.data.projectId, projectId)
    }
  })

  await t.test('context search supports strict project-only retrieval', () => {
    const result = searchContextSchema.safeParse({
      intent: 'task workflow',
      projectId,
      includeGlobal: 'false',
    })

    assert.equal(result.success, true)
    if (result.success) {
      assert.equal(result.data.includeGlobal, false)
    }
  })

  await t.test('memory search accepts actor preference without forcing an actor filter', () => {
    const result = searchMemorySchema.safeParse({
      query: 'release checklist',
      projectId,
      includeGlobal: 'false',
      preferredActorId: 'agent:codex',
    })

    assert.equal(result.success, true)
    if (result.success) {
      assert.equal(result.data.includeGlobal, false)
      assert.equal(result.data.preferredActorId, 'agent:codex')
      assert.equal(result.data.createdBy, undefined)
    }
  })

  await t.test('context search can include current personal skills explicitly', () => {
    const result = searchContextSchema.safeParse({
      intent: 'daily planning',
      includePersonal: 'true',
      personalOwnerId: 'user:mini',
      personalOwnerType: 'human',
    })

    assert.equal(result.success, true)
    if (result.success) {
      assert.equal(result.data.includePersonal, true)
      assert.equal(result.data.personalOwnerId, 'user:mini')
      assert.equal(result.data.personalOwnerType, 'human')
    }
  })

  await t.test('memory search can include personal memories without actor filtering', () => {
    const result = searchMemorySchema.safeParse({
      query: 'private reminder',
      includePersonal: 'true',
      personalOwnerId: 'user:mini',
      personalOwnerType: 'human',
    })

    assert.equal(result.success, true)
    if (result.success) {
      assert.equal(result.data.includePersonal, true)
      assert.equal(result.data.createdBy, undefined)
    }
  })
})
