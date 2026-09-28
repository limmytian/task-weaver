import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LocalSkillPackageStorageAdapter,
  sha256Hex,
} from './skill-package-storage.js'

test('local skill package storage writes, lists, reads, verifies, and deletes objects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tw-skill-storage-'))
  try {
    const storage = new LocalSkillPackageStorageAdapter(dir)
    const body = 'hello skill package'
    const written = await storage.putObject({
      key: 'pkg/v1/SKILL.md',
      body,
      sha256: sha256Hex(body),
      contentType: 'text/markdown',
    })

    const listed = await storage.listObjects('pkg')
    const stat = await storage.statObject('pkg/v1/SKILL.md')
    const read = await storage.getObject('pkg/v1/SKILL.md')

    const chunks: Buffer[] = []
    for await (const chunk of read.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    assert.equal(listed.length, 1)
    assert.equal(stat.sha256, written.sha256)
    assert.equal(Buffer.concat(chunks).toString('utf8'), body)

    await storage.deleteObject('pkg/v1/SKILL.md')
    assert.deepEqual(await storage.listObjects('pkg'), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('local skill package storage rejects traversal keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tw-skill-storage-'))
  try {
    const storage = new LocalSkillPackageStorageAdapter(dir)
    await assert.rejects(
      () => storage.putObject({ key: '../escape', body: 'nope' }),
      /Invalid skill package storage key/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
