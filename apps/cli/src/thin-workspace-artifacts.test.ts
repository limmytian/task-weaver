import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { publishThinArtifact } from './thin-workspace-artifacts.js'

test('artifact upload binds the verified attempt and refuses a lost lease', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tw-thin-upload-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'delivery.json')
  await writeFile(path, '{"version":1}')
  const documentId = '00000000-0000-4000-8000-000000000001'
  const outputId = '00000000-0000-4000-8000-000000000002'
  const attemptId = '00000000-0000-4000-8000-000000000003'
  const workerId = '00000000-0000-4000-8000-000000000004'
  const projectId = '00000000-0000-4000-8000-000000000005'
  const token = `twa_${'1'.repeat(64)}`
  let uploads = 0, bindings = 0
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-key')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    if (req.url === '/api/v1/documents/attachments') {
      uploads++
      assert.equal(Buffer.concat(chunks).toString(), await readFile(path, 'utf8'))
      res.end(JSON.stringify({ id: documentId }))
    } else if (req.url === '/api/v1/thin-workers/output') {
      bindings++
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(body.attemptId, attemptId)
      assert.equal(body.token, token)
      assert.equal(body.documentId, documentId)
      res.end(JSON.stringify({ id: outputId }))
    } else { res.statusCode = 404; res.end() }
  }).listen(0, '127.0.0.1')
  t.after(() => server.close())
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const options = { apiUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-key', projectId, attemptId, workerId, token, path, assertAuthority: async () => {} }
  assert.deepEqual(await publishThinArtifact(options), { documentId, outputId })
  let checks = 0
  await assert.rejects(publishThinArtifact({ ...options, assertAuthority: async () => { if (++checks === 2) throw new Error('Lease expired') } }), /Lease expired/)
  assert.equal(uploads, 2)
  assert.equal(bindings, 1)
  await truncate(path, 50 * 1024 * 1024 + 1)
  await assert.rejects(publishThinArtifact(options), /too large/)
  assert.equal(uploads, 2)
})
