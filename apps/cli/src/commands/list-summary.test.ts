import assert from 'node:assert'
import { test } from 'node:test'
import { Command } from 'commander'
import { registerRequirements } from './requirements.js'
import { registerTasks } from './tasks.js'
import { registerProjects } from './projects.js'
import { registerDocuments } from './documents.js'

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
  registerRequirements(program)
  registerTasks(program)
  registerProjects(program)
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
  }
  const calls: FetchCall[] = []
  const logs: string[] = []

  process.env.TW_API_URL = 'http://tw.test'
  process.env.TW_API_KEY = 'test-key'
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

test('req list defaults to a compact paginated summary and explains omissions', async () => {
  const { calls, stdout } = await runCli(
    ['req', 'list', '--project', 'project-1'],
    {
      '/api/v1/projects/project-1/requirements?view=summary&page=1&pageSize=20&completedWithinDays=7': {
        items: [{
          id: 'req-1',
          title: 'Release requirement',
          status: 'in_progress',
          priority: 'high',
          modelTier: 'strong',
          updatedAt: '2026-08-06T12:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
        pageCount: 1,
        view: 'summary',
      },
    },
  )

  assert.equal(
    `${calls[0]!.url.pathname}${calls[0]!.url.search}`,
    '/api/v1/projects/project-1/requirements?view=summary&page=1&pageSize=20&completedWithinDays=7',
  )
  assert.match(stdout, /STATUS\s+PRIORITY\s+TITLE/)
  assert.match(stdout, /Release requirement/)
  assert.match(stdout, /Summary view only/)
  assert.match(stdout, /Page 1\/1 · 1 requirements/)
})

test('req list JSON declares summary fields and full mode is paginated', async () => {
  const summaryResponse = {
    items: [{
      id: 'req-1',
      title: 'Release requirement',
      status: 'done',
      priority: 'high',
      modelTier: 'strong',
      branchName: 'main',
      updatedAt: '2026-08-06T12:00:00.000Z',
    }],
    total: 7,
    page: 1,
    pageSize: 20,
    pageCount: 1,
    view: 'summary',
  }
  const { calls, stdout } = await runCli(
    ['req', 'list', '--project', 'project-1', '--json'],
    { '/api/v1/projects/project-1/requirements?view=summary&page=1&pageSize=20&completedWithinDays=7': summaryResponse },
  )

  const output = JSON.parse(stdout)
  assert.deepEqual(output.items, summaryResponse.items)
  assert.equal(output.meta.view, 'summary')
  assert.equal(output.meta.isFull, false)
  assert.deepEqual(output.meta.omitted, ['description', 'tasks', 'dependencies', 'dependents', 'repositories'])
  assert.equal(output.meta.total, 7)
  assert.equal(calls.length, 1)

  const full = await runCli(
    ['req', 'list', '--project', 'project-1', '--full', '--json'],
    {
      '/api/v1/projects/project-1/requirements?view=full&page=1&pageSize=5&completedWithinDays=7': {
        items: [{
          ...summaryResponse.items[0],
          tasks: [{ id: 'task-1', title: 'Nested task' }],
          dependencies: [{ id: 'dep-1' }],
        }],
        total: 7,
        page: 1,
        pageSize: 5,
        pageCount: 2,
        view: 'full',
      },
    },
  )
  const fullOutput = JSON.parse(full.stdout)
  assert.deepEqual(fullOutput.items[0].tasks, [{ id: 'task-1', title: 'Nested task' }])
  assert.equal(fullOutput.meta.view, 'full')
  assert.equal(fullOutput.meta.isFull, true)
  assert.deepEqual(fullOutput.meta.omitted, [])
  assert.equal(fullOutput.meta.nextPage, 2)
})

test('req list supports status, priority, text, and page filters', async () => {
  const { calls } = await runCli(
    [
      'req', 'list', '--project', 'project-1', '--status', 'approved',
      '--priority', 'high', '--query', 'release', '--page', '2', '--page-size', '3',
    ],
    {
      '/api/v1/projects/project-1/requirements?view=summary&page=2&pageSize=3&status=approved&priority=high&q=release&completedWithinDays=7': {
        items: [],
        total: 4,
        page: 2,
        pageSize: 3,
        pageCount: 2,
        view: 'summary',
      },
    },
  )

  assert.equal(
    `${calls[0]!.url.pathname}${calls[0]!.url.search}`,
    '/api/v1/projects/project-1/requirements?view=summary&page=2&pageSize=3&status=approved&priority=high&q=release&completedWithinDays=7',
  )
})

test('task list defaults to a compact paginated JSON summary', async () => {
  const { calls, stdout } = await runCli(
    ['task', 'list', '--project', 'project-1', '--json'],
    {
      '/api/v1/projects/project-1/tasks?view=summary&page=1&pageSize=20&completedWithinDays=7': {
        items: [{
          id: 'task-1',
          requirementId: 'req-1',
          title: 'Release task',
          status: 'todo',
          priority: 'medium',
          assignee: 'agent-1',
          updatedAt: '2026-08-06T12:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
        pageCount: 1,
        view: 'summary',
      },
    },
  )

  assert.equal(
    `${calls[0]!.url.pathname}${calls[0]!.url.search}`,
    '/api/v1/projects/project-1/tasks?view=summary&page=1&pageSize=20&completedWithinDays=7',
  )
  const output = JSON.parse(stdout)
  assert.deepEqual(output.items[0], {
    id: 'task-1',
    requirementId: 'req-1',
    title: 'Release task',
    status: 'todo',
    priority: 'medium',
    assignee: 'agent-1',
    updatedAt: '2026-08-06T12:00:00.000Z',
  })
  assert.deepEqual(output.meta.omitted, ['description', 'repositories'])
})

test('list commands preserve an explicit zero completed-days filter', async () => {
  const { calls } = await runCli(
    ['req', 'list', '--project', 'project-1', '--completed-within-days', '0'],
    {
      '/api/v1/projects/project-1/requirements?view=summary&page=1&pageSize=20&completedWithinDays=0': {
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        pageCount: 0,
        view: 'summary',
      },
    },
  )

  assert.equal(
    `${calls[0]!.url.pathname}${calls[0]!.url.search}`,
    '/api/v1/projects/project-1/requirements?view=summary&page=1&pageSize=20&completedWithinDays=0',
  )
})
test('project list defaults to active navigation summaries and supports search', async () => {
  const { calls, stdout } = await runCli(
    ['project', 'list', '--query', 'Task'],
    {
      '/api/v1/projects?status=active&view=summary&page=1&pageSize=20&query=Task': {
        items: [{
          id: 'project-1',
          name: 'Task Weaver',
          status: 'active',
          updatedAt: '2026-08-06T12:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
        pageCount: 1,
        view: 'summary',
      },
    },
  )

  assert.equal(
    `${calls[0]!.url.pathname}${calls[0]!.url.search}`,
    '/api/v1/projects?status=active&view=summary&page=1&pageSize=20&query=Task',
  )
  assert.match(stdout, /Task Weaver/)
  assert.match(stdout, /Summary view only; description is omitted/)
})

test('document list omits Markdown by default and paginates full content', async () => {
  const { calls, stdout } = await runCli(
    ['doc', 'list', '--project', 'project-1', '--type', 'design', '--query', 'architecture'],
    {
      '/api/v1/documents?view=summary&page=1&pageSize=20&includeGlobal=true&includePersonal=false&projectId=project-1&docType=design&query=architecture': {
        items: [{
          id: 'doc-1',
          projectId: 'project-1',
          title: 'Architecture',
          summary: 'System architecture',
          docType: 'design',
          updatedAt: '2026-08-06T12:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
        pageCount: 1,
        view: 'summary',
      },
    },
  )

  assert.equal(
    `${calls[0]!.url.pathname}${calls[0]!.url.search}`,
    '/api/v1/documents?view=summary&page=1&pageSize=20&includeGlobal=true&includePersonal=false&projectId=project-1&docType=design&query=architecture',
  )
  assert.match(stdout, /Architecture/)
  assert.match(stdout, /Markdown content and generation metadata are omitted/)

  const full = await runCli(
    ['doc', 'list', '--project', 'project-1', '--full', '--json', '--page', '2'],
    {
      '/api/v1/documents?view=full&page=2&pageSize=5&includeGlobal=true&includePersonal=false&projectId=project-1': {
        items: [{
          id: 'doc-2',
          projectId: 'project-1',
          title: 'Design details',
          content: '# Design',
        }],
        total: 6,
        page: 2,
        pageSize: 5,
        pageCount: 2,
        view: 'full',
      },
    },
  )
  const fullOutput = JSON.parse(full.stdout)
  assert.equal(fullOutput.items[0].content, '# Design')
  assert.equal(fullOutput.meta.isFull, true)
  assert.equal(fullOutput.meta.nextPage, null)
})
