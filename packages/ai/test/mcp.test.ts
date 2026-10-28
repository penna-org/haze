import type { MCPTransport } from '../src/mcp'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as v from 'valibot'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineTool, generateText, jsonSchema, mockModel } from '../src'
import { createMCPClient, createMCPServer, MCPError } from '../src/mcp'
import { useMockServer } from './server'

// Response.json() 的类型是 unknown
const read = (response: Response): Promise<any> => response.json()

const fixture = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url))

/** 用 Node http 服务承载 Request → Response 的处理函数 */
function useFetchServer(handler: (request: Request) => Promise<Response>) {
  let url = ''
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req)
      chunks.push(chunk as Buffer)
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      for (const item of Array.isArray(value)
        ? value
        : [value]) {
        if (item !== undefined)
          headers.append(key, item)
      }
    }
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : Buffer.concat(chunks),
    })
    const response = await handler(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
  })
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))
  return {
    get url() {
      return url
    },
  }
}

const tools = {
  weather: defineTool({
    description: 'Get the weather of a city',
    parameters: v.object({
      city: v.string(),
    }),
    execute: async ({ city }) => ({ city, temperature: 21 }),
  }),
  greet: defineTool({
    description: 'Greet someone',
    parameters: v.object({
      name: v.string(),
    }),
    execute: ({ name }) => `Hello, ${name}!`,
  }),
  fail: defineTool({
    parameters: v.object({}),
    execute: () => {
      throw new Error('Something broke')
    },
  }),
  query: defineTool({
    description: 'Run a query in a region',
    parameters: jsonSchema<{ region: string, sql: string }>({
      type: 'object',
      properties: {
        region: { 'type': 'string', 'x-mcp-header': 'Region' },
        sql: { type: 'string' },
      },
      required: ['region', 'sql'],
    }),
    execute: ({ region, sql }) => `${region}: ${sql}`,
  }),
  clientSide: defineTool({
    parameters: v.object({}),
  }),
}

const mcpServer = createMCPServer({
  name: 'test-server',
  version: '1.2.3',
  instructions: 'Use weather for forecasts',
  tools,
})

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return mcpServer.handle(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string'
      ? body
      : JSON.stringify(body),
  }))
}

describe('createMCPServer', () => {
  it('rejects GET and DELETE with 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await mcpServer.handle(new Request('http://localhost/mcp', { method }))
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
    }
  })

  it('answers legacy initialize, notifications and ping', async () => {
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'x', version: '1' },
      },
    })
    expect(init.status).toBe(200)
    expect(init.headers.get('mcp-session-id')).toBeNull()
    expect(await read(init)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'test-server', version: '1.2.3' },
        instructions: 'Use weather for forecasts',
      },
    })
    // 不认识的版本按最新的 legacy 版本应答
    const unknown = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    })
    expect((await read(unknown)).result.protocolVersion).toBe('2025-11-25')

    const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(notification.status).toBe(202)
    expect(await notification.text()).toBe('')

    const ping = await post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { 'mcp-protocol-version': '2025-06-18' })
    expect(await read(ping)).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
  })

  it('reports parse errors, batches and invalid messages', async () => {
    const parse = await post('{not json')
    expect(parse.status).toBe(400)
    expect(await read(parse)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
    })

    const batch = await post([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
    ])
    expect(batch.status).toBe(400)
    expect((await read(batch)).error.code).toBe(-32600)

    const invalid = await post({ id: 1, method: 'ping' })
    expect((await read(invalid)).error.code).toBe(-32600)
  })

  it('serves modern requests with resultType, serverInfo and header validation', async () => {
    const discover = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: { _meta: META },
    }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' })
    expect(await read(discover)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        resultType: 'complete',
        supportedVersions: [
          '2026-07-28',
          '2025-11-25',
          '2025-06-18',
          '2025-03-26',
          '2024-11-05',
        ],
        capabilities: { tools: {} },
        instructions: 'Use weather for forecasts',
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: 'test-server', version: '1.2.3' },
        },
      },
    })

    const mismatch = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: { _meta: META },
    }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' })
    expect(mismatch.status).toBe(400)
    expect((await read(mismatch)).error.code).toBe(-32020)

    const name = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'greet',
        arguments: { name: 'A' },
        _meta: META,
      },
    }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'weather' })
    expect((await read(name)).error.code).toBe(-32020)

    const unsupported = await post({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: {
        _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' },
      },
    }, { 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' })
    expect(unsupported.status).toBe(400)
    const body = await read(unsupported)
    expect(body.error.code).toBe(-32022)
    expect(body.error.data).toEqual({
      supported: expect.arrayContaining(['2026-07-28', '2025-11-25']),
      requested: '2099-01-01',
    })

    const unknown = await post({
      jsonrpc: '2.0',
      id: 5,
      method: 'prompts/list',
      params: { _meta: META },
    }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'prompts/list' })
    expect(unknown.status).toBe(404)
    expect((await read(unknown)).error.code).toBe(-32601)
  })

  it('rejects cross-origin requests by default', async () => {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })
    expect(response.status).toBe(403)
    const same = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'http://localhost' })
    expect(same.status).toBe(200)
  })
})

describe('mCP over HTTP (round trip)', () => {
  const server = useFetchServer(request => mcpServer.handle(request))

  it('discovers the server and lists tools with JSON Schema parameters', async () => {
    const client = createMCPClient({
      transport: { type: 'http', url: server.url },
    })
    const info = await client.initialize()
    expect(info).toEqual({
      protocolVersion: '2026-07-28',
      era: 'modern',
      capabilities: { tools: {} },
      serverInfo: { name: 'test-server', version: '1.2.3' },
      instructions: 'Use weather for forecasts',
    })
    const list = await client.listTools()
    // 没有 execute 的工具不对外提供
    expect(list.map(tool => tool.name)).toEqual(['weather', 'greet', 'fail', 'query'])
    expect(list[0]).toEqual({
      name: 'weather',
      description: 'Get the weather of a city',
      inputSchema: {
        type: 'object',
        properties: {
          city: { type: 'string' },
        },
        required: ['city'],
      },
    })
    await client.close()
  })

  it('calls tools: text, structured output, errors and invalid arguments', async () => {
    const client = createMCPClient({
      transport: { type: 'http', url: server.url },
    })
    expect(await client.callTool('greet', { name: 'Ada' })).toEqual({
      content: [
        { type: 'text', text: 'Hello, Ada!' },
      ],
      isError: false,
      resultType: 'complete',
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: 'test-server', version: '1.2.3' },
      },
    })
    const weather = await client.callTool('weather', { city: 'Paris' })
    expect(weather.structuredContent).toEqual({ city: 'Paris', temperature: 21 })
    expect(weather.content).toEqual([
      { type: 'text', text: '{"city":"Paris","temperature":21}' },
    ])

    const failed = await client.callTool('fail', {})
    expect(failed.isError).toBe(true)
    expect(failed.content).toEqual([
      { type: 'text', text: 'Something broke' },
    ])

    const invalid = await client.callTool('weather', { city: 42 })
    expect(invalid.isError).toBe(true)
    expect((invalid.content[0] as { text: string }).text).toContain('Invalid arguments for tool "weather"')

    const error = await client.callTool('missing', {}).catch(error => error)
    expect(error).toBeInstanceOf(MCPError)
    expect(error.code).toBe(-32602)
    expect(error.message).toContain('Unknown tool: missing')
    await client.close()
  })

  it('mirrors x-mcp-header parameters into Mcp-Param headers', async () => {
    const client = createMCPClient({
      transport: { type: 'http', url: server.url },
    })
    // 不先 list：服务端返回 HeaderMismatch，客户端重新 list 后重试
    const result = await client.callTool('query', { region: 'us-west1', sql: 'SELECT 1' })
    expect(result.content).toEqual([
      { type: 'text', text: 'us-west1: SELECT 1' },
    ])
    await client.close()
  })

  it('converts server tools into a ToolSet', async () => {
    const client = createMCPClient({
      transport: { type: 'http', url: server.url },
    })
    const set = await client.tools({
      include: ['weather', 'greet', 'fail'],
    })
    expect(Object.keys(set)).toEqual(['weather', 'greet', 'fail'])
    const context = { toolCallId: 'c1', messages: [] }
    expect(await set.weather.execute!({ city: 'Rome' }, context)).toEqual({ city: 'Rome', temperature: 21 })
    expect(await set.greet.execute!({ name: 'Bo' }, context)).toBe('Hello, Bo!')
    await expect(set.fail.execute!({}, context)).rejects.toThrow('Something broke')
    await client.close()
  })

  it('speaks the legacy protocol when forced', async () => {
    const client = createMCPClient({
      transport: { type: 'http', url: server.url },
      protocolVersion: '2025-11-25',
    })
    const info = await client.initialize()
    expect(info.era).toBe('legacy')
    expect(info.protocolVersion).toBe('2025-11-25')
    expect(await client.callTool('greet', { name: 'Old' })).toEqual({
      content: [
        { type: 'text', text: 'Hello, Old!' },
      ],
      isError: false,
    })
    await client.close()
  })

  it('runs an MCP tool inside generateText', async () => {
    const client = createMCPClient({
      transport: { type: 'http', url: server.url },
    })
    const model = mockModel([
      {
        toolCalls: [
          {
            toolName: 'weather',
            input: { city: 'Oslo' },
            toolCallId: 'c1',
          },
        ],
      },
      'It is 21°C in Oslo.',
    ])
    const result = await generateText({ model, prompt: 'Weather in Oslo?', tools: await client.tools() })
    expect(result.text).toBe('It is 21°C in Oslo.')
    expect(result.steps[0].toolResults).toEqual([
      {
        toolCallId: 'c1',
        toolName: 'weather',
        input: { city: 'Oslo' },
        output: { city: 'Oslo', temperature: 21 },
      },
    ])
    expect(model.requests[0].tools?.map(tool => tool.name)).toEqual(['weather', 'greet', 'fail', 'query'])
    expect(model.requests[1].messages.at(-1)).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'weather',
          output: { city: 'Oslo', temperature: 21 },
        },
      ],
    })
    await client.close()
  })
})

describe('mCP client against mock servers', () => {
  const mock = useMockServer()

  it('follows tools/list pagination and sends modern headers', async () => {
    mock.reply(({ json }) => {
      const result = (value: Record<string, unknown>) => ({
        json: {
          jsonrpc: '2.0',
          id: json.id,
          result: { resultType: 'complete', ...value },
        },
      })
      if (json.method === 'server/discover') {
        return result({
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
        })
      }
      if (json.params?.cursor === 'page-2') {
        return result({
          tools: [
            {
              name: 'b',
              inputSchema: { type: 'object' },
            },
          ],
          ttlMs: 0,
          cacheScope: 'private',
        })
      }
      return result({
        tools: [
          {
            name: 'a',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        nextCursor: 'page-2',
        ttlMs: 0,
        cacheScope: 'private',
      })
    })
    const client = createMCPClient({
      transport: {
        type: 'http',
        url: mock.url,
        headers: { authorization: 'Bearer t' },
      },
      name: 'tester',
      version: '9.9.9',
    })
    const tools = await client.listTools()
    expect(tools.map(tool => tool.name)).toEqual(['a', 'b'])
    expect(mock.requests.map(request => request.json.method)).toEqual(['server/discover', 'tools/list', 'tools/list'])
    const last = mock.last
    expect(last.json.params).toEqual({
      cursor: 'page-2',
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'tester', version: '9.9.9' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    })
    expect(last.headers['mcp-protocol-version']).toBe('2026-07-28')
    expect(last.headers['mcp-method']).toBe('tools/list')
    expect(last.headers.accept).toBe('application/json, text/event-stream')
    expect(last.headers.authorization).toBe('Bearer t')
    // ToolSet 的参数 schema 补全 properties
    const set = await client.tools()
    expect(Object.keys(set)).toEqual(['a', 'b'])
    await client.close()
  })

  it('skips tools with invalid x-mcp-header annotations and encodes header values', async () => {
    mock.reply(({ json }) => {
      const result = (value: Record<string, unknown>) => ({
        json: {
          jsonrpc: '2.0',
          id: json.id,
          result: { resultType: 'complete', ...value },
        },
      })
      if (json.method === 'server/discover') {
        return result({
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
        })
      }
      if (json.method === 'tools/list') {
        return result({
          tools: [
            {
              name: 'good',
              inputSchema: {
                type: 'object',
                properties: {
                  greeting: { 'type': 'string', 'x-mcp-header': 'Greeting' },
                  n: { 'type': 'integer', 'x-mcp-header': 'N' },
                },
              },
            },
            {
              name: 'bad',
              inputSchema: {
                type: 'object',
                properties: {
                  ratio: { 'type': 'number', 'x-mcp-header': 'Ratio' },
                },
              },
            },
            {
              name: 'nested',
              inputSchema: {
                type: 'object',
                properties: {
                  list: {
                    type: 'array',
                    items: { 'type': 'string', 'x-mcp-header': 'Item' },
                  },
                },
              },
            },
          ],
          ttlMs: 0,
          cacheScope: 'private',
        })
      }
      return result({
        content: [
          { type: 'text', text: 'ok' },
        ],
      })
    })
    const warnings: string[] = []
    const client = createMCPClient({
      transport: { type: 'http', url: mock.url },
      onWarning: message => warnings.push(message),
    })
    expect((await client.listTools()).map(tool => tool.name)).toEqual(['good'])
    expect(warnings).toHaveLength(2)
    await client.callTool('good', { greeting: 'Hello, 世界', n: 42 })
    expect(mock.last.headers['mcp-name']).toBe('good')
    expect(mock.last.headers['mcp-param-greeting']).toBe(`=?base64?${Buffer.from('Hello, 世界').toString('base64')}?=`)
    expect(mock.last.headers['mcp-param-n']).toBe('42')
    await client.close()
  })

  it('falls back to a legacy session with SSE responses', async () => {
    mock.reply(({ json, method, headers }) => {
      if (method === 'DELETE')
        return { body: '', status: 200 }
      if (json.method === 'server/discover') {
        return {
          json: {
            jsonrpc: '2.0',
            id: json.id,
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          },
          status: 400,
        }
      }
      if (json.method === 'initialize') {
        return {
          json: {
            jsonrpc: '2.0',
            id: json.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'legacy', version: '0.1.0' },
            },
          },
          headers: { 'mcp-session-id': 'session-1' },
        }
      }
      if (json.method === 'notifications/initialized' || !('method' in json))
        return { body: '', status: 202 }
      if (headers['mcp-session-id'] !== 'session-1') {
        return {
          json: { error: 'no session' },
          status: 400,
        }
      }
      if (json.method === 'tools/list') {
        return {
          sse: [
            '',
            {
              jsonrpc: '2.0',
              method: 'notifications/message',
              params: { level: 'info', data: 'listing' },
            },
            { jsonrpc: '2.0', id: 'srv-1', method: 'ping' },
            {
              jsonrpc: '2.0',
              id: json.id,
              result: {
                tools: [
                  {
                    name: 'echo',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        text: { type: 'string' },
                      },
                    },
                  },
                ],
              },
            },
          ],
        }
      }
      return {
        sse: [
          {
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: 1, progress: 1 },
          },
          {
            jsonrpc: '2.0',
            id: json.id,
            result: {
              content: [
                { type: 'text', text: json.params.arguments.text },
                { type: 'image', data: 'AAAA', mimeType: 'image/png' },
              ],
            },
          },
        ],
      }
    })
    const client = createMCPClient({
      transport: { type: 'http', url: mock.url },
    })
    const info = await client.initialize()
    expect(info).toEqual({
      protocolVersion: '2025-06-18',
      era: 'legacy',
      capabilities: { tools: {} },
      serverInfo: { name: 'legacy', version: '0.1.0' },
      instructions: undefined,
    })
    const set = await client.tools()
    const output = await set.echo.execute!({ text: 'hi' }, { toolCallId: 'c1', messages: [] })
    // 含非文本内容时返回原始内容数组
    expect(output).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ])
    await client.close()

    const methods = mock.requests.map(request => request.method === 'POST'
      ? request.json.method ?? `response:${request.json.id}`
      : request.method)
    expect(methods).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
      'tools/list',
      'response:srv-1',
      'tools/call',
      'DELETE',
    ])
    const initialize = mock.requests[1]
    expect(initialize.json.params).toEqual({
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: '@hazejs/ai', version: '0.0.0' },
    })
    expect(initialize.headers['mcp-session-id']).toBeUndefined()
    for (const request of mock.requests.slice(2)) {
      expect(request.headers['mcp-session-id']).toBe('session-1')
      expect(request.headers['mcp-protocol-version']).toBe('2025-06-18')
    }
    // legacy 请求不带 _meta
    expect(mock.requests[3].json.params).toBeUndefined()
    expect(mock.requests[4].json).toEqual({ jsonrpc: '2.0', id: 'srv-1', result: {} })
  })

  it('re-initializes when the legacy session expires', async () => {
    let sessions = 0
    let expired = false
    mock.reply(({ json, headers }) => {
      if (json.method === 'server/discover') {
        return {
          json: {
            jsonrpc: '2.0',
            id: json.id,
            error: { code: -32601, message: 'Method not found' },
          },
        }
      }
      if (json.method === 'initialize') {
        sessions++
        return {
          json: {
            jsonrpc: '2.0',
            id: json.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              serverInfo: { name: 'legacy', version: '1' },
            },
          },
          headers: { 'mcp-session-id': `s${sessions}` },
        }
      }
      if (!('id' in json))
        return { body: '', status: 202 }
      if (headers['mcp-session-id'] === 's1' && !expired) {
        expired = true
        return { body: 'Session not found', status: 404 }
      }
      return {
        json: {
          jsonrpc: '2.0',
          id: json.id,
          result: { tools: [] },
        },
      }
    })
    const client = createMCPClient({
      transport: { type: 'http', url: mock.url },
    })
    expect(await client.listTools()).toEqual([])
    expect(sessions).toBe(2)
    expect(mock.last.headers['mcp-session-id']).toBe('s2')
  })

  it('falls back to legacy when the server only supports legacy versions', async () => {
    mock.reply(({ json }) => {
      if (json.method === 'server/discover') {
        return {
          json: {
            jsonrpc: '2.0',
            id: json.id,
            error: {
              code: -32022,
              message: 'Unsupported protocol version',
              data: {
                supported: ['2025-11-25'],
                requested: '2026-07-28',
              },
            },
          },
          status: 400,
        }
      }
      if (json.method === 'initialize') {
        return {
          json: {
            jsonrpc: '2.0',
            id: json.id,
            result: { protocolVersion: '2025-11-25', capabilities: {} },
          },
        }
      }
      return { body: '', status: 202 }
    })
    const client = createMCPClient({
      transport: { type: 'http', url: mock.url },
    })
    expect((await client.initialize()).era).toBe('legacy')
  })

  it('rejects multi round-trip results it cannot answer', async () => {
    mock.reply(({ json }) => {
      if (json.method === 'server/discover') {
        return {
          json: {
            jsonrpc: '2.0',
            id: json.id,
            result: {
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
              capabilities: {},
            },
          },
        }
      }
      return {
        json: {
          jsonrpc: '2.0',
          id: json.id,
          result: { resultType: 'input_required', inputRequests: {} },
        },
      }
    })
    const client = createMCPClient({
      transport: { type: 'http', url: mock.url },
    })
    await expect(client.callTool('x', {})).rejects.toThrow('multi round-trip')
  })

  it('surfaces HTTP errors that are not JSON-RPC', async () => {
    mock.reply(() => ({
      json: { message: 'boom' },
      status: 500,
    }))
    const client = createMCPClient({
      transport: { type: 'http', url: mock.url },
    })
    await expect(client.initialize()).rejects.toMatchObject({ name: 'APICallError', status: 500 })
  })
})

describe('custom transports', () => {
  it('accepts an MCPTransport implementation', async () => {
    const sent: string[] = []
    const transport: MCPTransport = {
      async request(message) {
        sent.push(message.method)
        return mcpServer.handle(new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': message.method,
            'mcp-name': String(message.params?.name ?? ''),
          },
          body: JSON.stringify(message),
        })).then(response => read(response))
      },
      async notify() {},
      async close() {},
    }
    const client = createMCPClient({ transport })
    expect((await client.callTool('greet', { name: 'Custom' })).content).toEqual([
      { type: 'text', text: 'Hello, Custom!' },
    ])
    expect(sent).toEqual(['server/discover', 'tools/call'])
    await client.close()
  })
})

describe('mCP over stdio', () => {
  it('talks to a modern stdio server', async () => {
    const stderr: string[] = []
    const client = createMCPClient({
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [fixture],
        onStderr: chunk => stderr.push(chunk),
      },
    })
    const info = await client.initialize()
    expect(info).toMatchObject({
      era: 'modern',
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'fixture', version: '1.0.0' },
      instructions: 'stdio fixture',
    })
    expect((await client.listTools()).map(tool => tool.name)).toEqual(['echo', 'add'])
    const set = await client.tools()
    const context = { toolCallId: 'c1', messages: [] }
    // 并发请求按 id 匹配
    const [echo, sum] = await Promise.all([
      set.echo.execute!({ text: 'over stdio' }, context),
      set.add.execute!({ a: 2, b: 3 }, context),
    ])
    expect(echo).toBe('over stdio')
    expect(sum).toEqual({ sum: 5 })
    await expect(client.callTool('nope')).rejects.toMatchObject({ code: -32602 })
    await client.close()
    expect(stderr.join('')).toContain('fixture started (modern)')
  })

  it('falls back to initialize for a legacy stdio server', async () => {
    const client = createMCPClient({
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [fixture, 'legacy'],
      },
    })
    expect(await client.initialize()).toMatchObject({
      era: 'legacy',
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'fixture' },
    })
    expect((await client.callTool('add', { a: 1, b: 1 })).structuredContent).toEqual({ sum: 2 })
    await client.close()
    await expect(client.listTools()).rejects.toThrow('closed')
  })

  it('reports a command that cannot be started', async () => {
    const client = createMCPClient({
      transport: { type: 'stdio', command: 'definitely-not-a-real-command-xyz' },
    })
    await expect(client.initialize()).rejects.toThrow('Failed to start MCP server')
  })
})
