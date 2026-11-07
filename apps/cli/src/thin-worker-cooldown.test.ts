import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readThinCooldown, writeThinCooldown } from './thin-worker-cooldown.js'

test('quota cooldown survives restart and is scoped to node and profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tw-thin-cooldown-')), previous = process.env.HOME
  process.env.HOME = home
  try {
    const now = Date.now(), until = await writeThinCooldown('node-a', '/profile-a', null, now)
    assert.equal(await readThinCooldown('node-a', '/profile-a', now), until)
    assert.equal(await readThinCooldown('node-b', '/profile-a', now), null)
    assert.equal(await readThinCooldown('node-a', '/profile-b', now), null)
    assert.equal(await readThinCooldown('node-a', '/profile-a', Date.parse(until) + 1), null)
    const later = await writeThinCooldown('node-a', '/profile-a', new Date(now + 3600000).toISOString(), now)
    assert.equal(await writeThinCooldown('node-a', '/profile-a', null, now), later)
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; await rm(home, { recursive: true, force: true }) }
})
