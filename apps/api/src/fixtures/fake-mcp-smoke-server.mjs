let buffer = ''

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  writeMessage({ jsonrpc: '2.0', id, result: value })
}

function error(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } })
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return
  const { id, method, params } = message

  if (id === undefined) {
    return
  }

  if (method === 'initialize') {
    result(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'task-weaver-fake-mcp-smoke',
        version: '1.0.0',
      },
    })
    return
  }

  if (method === 'tools/list') {
    result(id, {
      tools: [
        {
          name: 'smoke_echo',
          description: 'Deterministic smoke echo tool for MCP side-effect validation.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string' },
            },
            required: ['message'],
          },
        },
      ],
    })
    return
  }

  if (method === 'tools/call') {
    const messageText = typeof params?.arguments?.message === 'string'
      ? params.arguments.message
      : ''
    result(id, {
      content: [
        {
          type: 'text',
          text: `fake-mcp-smoke:${messageText}`,
        },
      ],
    })
    return
  }

  error(id, -32601, `Method not found: ${method}`)
}

function processBuffer() {
  while (true) {
    const lineEnd = buffer.indexOf('\n')
    if (lineEnd === -1) return

    const payload = buffer.slice(0, lineEnd).replace(/\r$/, '')
    buffer = buffer.slice(lineEnd + 1)
    if (!payload) continue

    try {
      handleMessage(JSON.parse(payload))
    } catch (err) {
      process.stderr.write(`Failed to handle MCP message: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  processBuffer()
})

process.stdin.on('end', () => {
  process.exit(0)
})
