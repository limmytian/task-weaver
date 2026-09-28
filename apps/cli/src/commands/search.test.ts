import assert from 'node:assert'
import { test } from 'node:test'
import { Command } from 'commander'
import { registerDocuments } from './documents.js'
import { registerSearch } from './search.js'

type FetchCall = {
  url: URL
  init?: RequestInit
}

function createProgram(): Command {
  const program = new Command()
  program.exitOverride()
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  })
  registerSearch(program)
  registerDocuments(program)
  return program
}

async function runCli(
  args: string[],
  responses: Record<string, unknown>,
): Promise<{ calls: FetchCall[]; stdout: string }> {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const previousEnv = {
    TW_API_URL: process.env.TW_API_URL,
    TW_API_KEY: process.env.TW_API_KEY,
    TW_CLIENT_ID: process.env.TW_CLIENT_ID,
    TW_NODE_ID: process.env.TW_NODE_ID,
  }
  const calls: FetchCall[] = []
  const logs: string[] = []

  process.env.TW_API_URL = 'http://tw.test'
  process.env.TW_API_KEY = 'test-key'
  process.env.TW_CLIENT_ID = 'cli-test-client'
  process.env.TW_NODE_ID = 'cli-test-node'
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '))
  }
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    const key = `${url.pathname}${url.search}`
    assert.ok(key in responses, `unexpected request: ${key}`)
    return new Response(JSON.stringify(responses[key]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await createProgram().parseAsync(args, { from: 'user' })
    return { calls, stdout: logs.join('\n') }
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('search routes entity filters to the intended endpoints and types rows', async (t) => {
  const cases = [
    {
      entity: 'task',
      expectedPath: '/api/v1/search/tasks?q=release&projectId=project-1',
      response: [{ id: 'task-1', title: 'Release task', status: 'todo' }],
      expectedType: 'task',
      expectedId: 'task-1',
    },
    {
      entity: 'requirement',
      expectedPath: '/api/v1/search/requirements?q=release&projectId=project-1',
      response: { items: [{ id: 'req-1', title: 'Release requirement', status: 'approved' }] },
      expectedType: 'requirement',
      expectedId: 'req-1',
    },
    {
      entity: 'document',
      expectedPath: '/api/v1/search/documents?query=release&projectId=project-1',
      response: { items: [{ id: 'doc-1', title: 'Release document', score: 0.9 }] },
      expectedType: 'document',
      expectedId: 'doc-1',
    },
  ]

  for (const entry of cases) {
    await t.test(entry.entity, async () => {
      const { calls, stdout } = await runCli(
        ['search', 'release', '--entity', entry.entity, '--project', 'project-1', '--json'],
        { [entry.expectedPath]: entry.response },
      )

      assert.equal(calls.length, 1)
      assert.equal(`${calls[0]!.url.pathname}${calls[0]!.url.search}`, entry.expectedPath)

      const output = JSON.parse(stdout) as { items: Array<Record<string, unknown>> }
      assert.equal(output.items.length, 1)
      assert.equal(output.items[0]!.type, entry.expectedType)
      assert.equal(output.items[0]!.id, entry.expectedId)
    })
  }
})

test('search rejects unsupported entity filters before making a request', async () => {
  await assert.rejects(
    () => runCli(['search', 'release', '--entity', 'milestone'], {}),
    /Unsupported entity: milestone/,
  )
})

test('search all prefers canonical items responses', async () => {
  const expectedPath = '/api/v1/search/all?q=release'
  const { stdout } = await runCli(
    ['search', 'release', '--json'],
    {
      [expectedPath]: {
        items: [{ type: 'task', id: 'task-1', title: 'Release task', status: 'todo' }],
        tasks: [],
        requirements: [],
        documents: [],
      },
    },
  )

  assert.deepEqual(JSON.parse(stdout), {
    items: [{ type: 'task', id: 'task-1', title: 'Release task', status: 'todo' }],
  })
})

test('doc search normalizes bare-array JSON responses into the items envelope', async () => {
  const expectedPath = '/api/v1/search/documents?query=release&mode=keyword&projectId=project-1'
  const { calls, stdout } = await runCli(
    ['doc', 'search', 'release', '--mode', 'keyword', '--project', 'project-1', '--json'],
    { [expectedPath]: [{ id: 'doc-1', title: 'Release doc', score: 0.8 }] },
  )

  assert.equal(calls.length, 1)
  assert.equal(`${calls[0]!.url.pathname}${calls[0]!.url.search}`, expectedPath)
  assert.deepEqual(JSON.parse(stdout), {
    items: [{ id: 'doc-1', title: 'Release doc', score: 0.8 }],
  })
})

test('doc search renders table output from item-wrapped responses', async () => {
  const expectedPath = '/api/v1/search/documents?query=release&mode=hybrid'
  const { stdout } = await runCli(
    ['doc', 'search', 'release'],
    { [expectedPath]: { items: [{ id: 'doc-2', title: 'Wrapped doc', score: 0.7 }] } },
  )

  assert.match(stdout, /ID\s+TITLE\s+SCORE/)
  assert.match(stdout, /doc-2\s+Wrapped doc\s+0.7/)
})
