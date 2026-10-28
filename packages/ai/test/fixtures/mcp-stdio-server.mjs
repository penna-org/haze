// 测试用的最小 MCP stdio 服务端：按行读写 JSON-RPC。
// 参数 `legacy` 时只支持 initialize 握手（2025-11-25），否则按 2026-07-28 的无状态协议应答。
import process from 'node:process'
import { createInterface } from 'node:readline'

const legacy = process.argv.includes('legacy')
let initialized = false

const tools = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({
    jsonrpc: '2.0',
    id,
    result: legacy
      ? value
      : { resultType: 'complete', ...value },
  })
}

function error(id, code, message) {
  send({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })
}

process.stderr.write(`fixture started (${legacy ? 'legacy' : 'modern'})\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim())
    return
  const message = JSON.parse(line)
  if (message.id === undefined) {
    if (message.method === 'notifications/initialized')
      initialized = true
    return
  }
  const { id, method, params = {} } = message
  if (legacy) {
    if (method === 'initialize') {
      return result(id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      })
    }
    if (!initialized)
      return error(id, -32601, `Method not found: ${method}`)
  }
  else if (params._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') {
    return error(id, -32602, 'Missing protocol version')
  }
  switch (method) {
    case 'server/discover':
      return result(id, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        instructions: 'stdio fixture',
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '1.0.0' },
        },
      })
    case 'tools/list':
      return result(id, { tools })
    case 'tools/call':
      if (params.name === 'echo') {
        return result(id, {
          content: [
            { type: 'text', text: params.arguments.text },
          ],
        })
      }
      if (params.name === 'add') {
        const sum = params.arguments.a + params.arguments.b
        return result(id, {
          content: [
            {
              type: 'text',
              text: String(sum),
            },
          ],
          structuredContent: { sum },
        })
      }
      return error(id, -32602, `Unknown tool: ${params.name}`)
    default:
      return error(id, -32601, `Method not found: ${method}`)
  }
})
