import assert from 'node:assert'
import { test } from 'node:test'
import { Command } from 'commander'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerDocuments } from './documents.js'
import { registerMemory } from './memory.js'
import { registerPlans } from './plans.js'

type FetchCall = {
  url: URL
  init?: RequestInit
}

type MockResponse = {
  body?: unknown
  status?: number
}

function createProgram(): Command {
  const program = new Command()
  program.exitOverride()
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  })
  registerDocuments(program)
  registerMemory(program)
  registerPlans(program)
  return program
}

async function runCli(
  args: string[],
  handler: (call: FetchCall) => MockResponse,
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
    const call = { url: new URL(String(input)), init }
    calls.push(call)
    const response = handler(call)
    if (response.status === 204) {
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
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

test('doc delete --force removes the targeted disposable document', async () => {
  const documentIds = new Set(['doc-delete-target', 'doc-keep'])

  const { calls, stdout } = await runCli(['doc', 'delete', 'doc-delete-target', '--force', '--json'], (call) => {
    assert.equal(call.init?.method, 'DELETE')
    assert.equal(call.url.pathname, '/api/v1/documents/doc-delete-target')
    documentIds.delete('doc-delete-target')
    return { status: 204 }
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(stdout), {
    deleted: true,
    id: 'doc-delete-target',
  })
  assert.deepEqual([...documentIds].sort(), ['doc-keep'])
})

test('memory forget removes only the targeted disposable memory', async () => {
  const memoryIds = new Set(['memory-delete-target', 'memory-keep'])

  const { calls, stdout } = await runCli(['memory', 'forget', 'memory-delete-target'], (call) => {
    assert.equal(call.init?.method, 'DELETE')
    assert.equal(call.url.pathname, '/api/v1/memories/memory-delete-target')
    memoryIds.delete('memory-delete-target')
    return { status: 204 }
  })

  assert.equal(calls.length, 1)
  assert.equal(stdout, 'Memory memory-delete-target deleted')
  assert.deepEqual([...memoryIds].sort(), ['memory-keep'])
})

test('plan validate expands YAML contentFile and posts a dry-run apply request', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-plan-'))
  const projectId = '00000000-0000-4000-8000-000000000001'
  const planPath = path.join(dir, 'plan.yaml')
  const contentPath = path.join(dir, 'auth.md')

  writeFileSync(contentPath, '# Auth Design\n', 'utf8')
  writeFileSync(planPath, [
    `projectId: ${projectId}`,
    'documents:',
    '  - key: auth-design',
    '    title: Auth Design',
    '    contentFile: ./auth.md',
    'requirements:',
    '  - key: auth-api',
    '    title: Auth API',
    '    tasks:',
    '      - key: auth-db',
    '        title: Add auth tables',
    '',
  ].join('\n'), 'utf8')

  try {
    const { calls } = await runCli(['plan', 'validate', '--file', planPath, '--json'], (call) => {
      assert.equal(call.init?.method, 'POST')
      assert.equal(call.url.pathname, '/api/v1/plans/apply')
      const body = JSON.parse(String(call.init?.body))
      assert.equal(body.dryRun, true)
      assert.equal(body.plan.projectId, projectId)
      assert.equal(body.plan.documents[0].content, '# Auth Design\n')
      assert.equal(body.plan.documents[0].contentFile, undefined)
      return {
        body: {
          dryRun: true,
          summary: {
            requirements: { create: 1, reuse: 0 },
            tasks: { create: 1, reuse: 0 },
            slices: { create: 0 },
            documents: { create: 1, reuse: 0 },
            requirementDependencies: 0,
            taskDependencies: 0,
            documentLinks: 0,
            documentRequirementLinks: 0,
            documentTaskLinks: 0,
            taskComments: 0,
            taskNotes: 0,
          },
          refs: { requirements: [], tasks: [], slices: [], documents: [] },
          warnings: [],
        },
      }
    })

    assert.equal(calls.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
