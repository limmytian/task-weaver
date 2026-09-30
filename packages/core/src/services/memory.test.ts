import { test } from 'node:test'
import assert from 'node:assert'
import { memories } from '@task-weaver/db'
import { searchMemorySchema } from "@task-weaver/contracts"
import { calculateSlidingRenewal, searchMemories } from './memory.js'

type Row = Record<string, any>

function collectSqlParams(value: unknown, params: unknown[] = []): unknown[] {
  if (value === null || value === undefined) return params
  if (value instanceof Date) {
    params.push(value)
    return params
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    params.push(value)
    return params
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSqlParams(item, params)
    return params
  }
  if (typeof value !== 'object') return params

  const maybeChunk = value as { value?: unknown; queryChunks?: unknown[] }
  if (maybeChunk.queryChunks) {
    collectSqlParams(maybeChunk.queryChunks, params)
    return params
  }
  if ('value' in maybeChunk) {
    const chunkValue = maybeChunk.value
    if (Array.isArray(chunkValue) && chunkValue.every((item) => typeof item === 'string')) {
      return params
    }
    collectSqlParams(chunkValue, params)
  }
  return params
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? []
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      if (chunk && typeof chunk === 'object' && 'queryChunks' in chunk) {
        return sqlText(chunk)
      }
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        const value = (chunk as { value: unknown }).value
        return Array.isArray(value) && value.every((item) => typeof item === 'string')
          ? value.join('')
          : '?'
      }
      return '?'
    })
    .join('')
}

class FakeMemorySearchDb {
  whereCondition: unknown
  limitValue: number | undefined

  constructor(private readonly rows: Row[]) {}

  select() {
    return {
      from: (table: unknown) => {
        assert.equal(table, memories)
        return {
          where: (condition: unknown) => {
            this.whereCondition = condition
            return {
              orderBy: () => ({
                limit: async (limit: number) => {
                  this.limitValue = limit
                  return this.rows.slice(0, limit)
                },
              }),
            }
          },
        }
      },
    }
  }
}

test('Memory Sliding Renewal Calculation', async (t) => {
  const maxIncrement = 30 * 24 * 60 * 60 * 1000 // 30 days
  const maxLifespan = 180 * 24 * 60 * 60 * 1000 // 180 days

  await t.test('returns exact same date if already expired', () => {
    const now = Date.now()
    const expiresAt = new Date(now - 1000) // 1 second ago
    const result = calculateSlidingRenewal(expiresAt, now, maxIncrement, maxLifespan)
    assert.strictEqual(result.getTime(), expiresAt.getTime())
  })

  await t.test('returns exact same date if remaining lifespan >= maxLifespan', () => {
    const now = Date.now()
    const expiresAt = new Date(now + maxLifespan + 1000) // max + 1s
    const result = calculateSlidingRenewal(expiresAt, now, maxIncrement, maxLifespan)
    assert.strictEqual(result.getTime(), expiresAt.getTime())
  })

  await t.test('adds near maximum increment if remaining lifespan is close to 0', () => {
    const now = Date.now()
    const expiresAt = new Date(now + 1000) // 1 second in the future (R ≈ 0)
    const result = calculateSlidingRenewal(expiresAt, now, maxIncrement, maxLifespan)
    const diff = result.getTime() - expiresAt.getTime()

    // Formula delta = MAX_INCREMENT * (1 - R / MAX_LIFESPAN)^2
    // For R ≈ 0, delta ≈ MAX_INCREMENT
    assert.ok(diff > maxIncrement * 0.999 && diff <= maxIncrement)
  })

  await t.test('adds negligible increment if remaining lifespan is close to maxLifespan', () => {
    const now = Date.now()
    const expiresAt = new Date(now + maxLifespan - 1000) // 1s before max (R ≈ maxLifespan)
    const result = calculateSlidingRenewal(expiresAt, now, maxIncrement, maxLifespan)
    const diff = result.getTime() - expiresAt.getTime()

    // For R ≈ maxLifespan, delta ≈ 0
    assert.ok(diff < 1)
  })

  await t.test('caps the expiration at now + maxLifespan', () => {
    const now = Date.now()
    const expiresAt1 = new Date(now + 24 * 60 * 60 * 1000)
    const result1 = calculateSlidingRenewal(expiresAt1, now, maxIncrement, maxLifespan)
    assert.ok(result1.getTime() <= now + maxLifespan)

    // Let's set a custom small maxLifespan to trigger capping
    const smallMaxLifespan = 5 * 1000 // 5 seconds
    const smallMaxIncrement = 10 * 1000 // 10 seconds
    const expiresAtCapped = new Date(now + 1000) // R = 1 second
    
    // delta = 10 * (1 - 1/5)^2 = 10 * 0.64 = 6.4 seconds
    // newExpiresTime = 1s + 6.4s = 7.4s. Capping limit is now + 5 seconds.
    // Result should be capped at now + 5 seconds
    const resultCapped = calculateSlidingRenewal(expiresAtCapped, now, smallMaxIncrement, smallMaxLifespan)
    assert.strictEqual(resultCapped.getTime(), now + smallMaxLifespan)
  })
})

test('memory search rejects blank queries after trimming', () => {
  const result = searchMemorySchema.safeParse({ query: '   ' })

  assert.equal(result.success, false)
  if (!result.success) {
    assert.deepEqual(result.error.flatten().fieldErrors.query, ['String must contain at least 1 character(s)'])
  }
})

test('memory search builds keyword ILIKE matching without search_vector', async () => {
  const db = new FakeMemorySearchDb([
    {
      id: 'memory-1',
      title: 'Release checklist',
      content: 'Remember smoke validation before release.',
      memoryType: 'project',
      projectId: null,
      personalOwnerId: null,
      personalOwnerType: null,
      tags: null,
      entityType: null,
      entityId: null,
      createdBy: 'agent:codex',
      createdByType: 'agent',
      expiresAt: null,
      createdAt: new Date('2026-07-05T00:00:00.000Z'),
      score: 0.5,
    },
  ])

  const results = await searchMemories(db as any, {
    query: 'release checklist',
    includeGlobal: true,
    includePersonal: false,
    includeExpired: false,
    limit: 10,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0]!.title, 'Release checklist')
  assert.equal(db.limitValue, 10)

  const whereSql = sqlText(db.whereCondition)
  assert.match(whereSql, /ILIKE/)
  assert.doesNotMatch(whereSql, /search_vector/)

  const params = collectSqlParams(db.whereCondition)
  assert.ok(params.includes('%release%'))
  assert.ok(params.includes('%checklist%'))
})
