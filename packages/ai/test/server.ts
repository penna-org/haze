import type { IncomingHttpHeaders } from 'node:http'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { afterAll, afterEach, beforeAll } from 'vitest'

export interface RecordedRequest {
  method: string
  /** 路径 + 查询参数 */
  url: string
  headers: IncomingHttpHeaders
  body: Buffer
  /** JSON 请求体（不是 JSON 时为 undefined） */
  json: any
}

export type MockReply
  = | { json: unknown, status?: number, headers?: Record<string, string> }
  /** SSE：每个元素是一条 data（对象会 JSON 序列化）；带 event 时写 event 行 */
    | { sse: Array<unknown | { event: string, data: unknown }>, status?: number }
  /** 原样写出（NDJSON、二进制、AWS event stream 等） */
    | { body: string | Uint8Array, status?: number, headers?: Record<string, string> }

export type MockHandler = (request: RecordedRequest) => MockReply | Promise<MockReply>

/**
 * 本地模拟厂商接口：记录请求并按 handler 返回 JSON / SSE / 原始响应。
 *
 * ```ts
 * const server = useMockServer()
 * server.reply(() => ({ json: { ... } }))
 * createOpenAI({ baseURL: server.url, apiKey: 'test' })
 * ```
 */
export function useMockServer() {
  const requests: RecordedRequest[] = []
  let handler: MockHandler = () => ({ json: {}, status: 404 })
  let url = ''
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', async () => {
      const body = Buffer.concat(chunks)
      let json: unknown
      try {
        json = body.length
          ? JSON.parse(body.toString())
          : undefined
      }
      catch {}
      const recorded: RecordedRequest = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body,
        json,
      }
      requests.push(recorded)
      const reply = await handler(recorded)
      if ('json' in reply) {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers })
        res.end(JSON.stringify(reply.json))
      }
      else if ('sse' in reply) {
        res.writeHead(reply.status ?? 200, { 'content-type': 'text/event-stream' })
        for (const item of reply.sse) {
          if (typeof item === 'object' && item !== null && 'event' in item && 'data' in item) {
            res.write(`event: ${(item as { event: string }).event}\ndata: ${JSON.stringify((item as { data: unknown }).data)}\n\n`)
          }
          else {
            res.write(`data: ${typeof item === 'string'
              ? item
              : JSON.stringify(item)}\n\n`)
          }
        }
        res.end()
      }
      else {
        res.writeHead(reply.status ?? 200, reply.headers ?? {})
        res.end(reply.body)
      }
    })
  })
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))
  afterEach(() => {
    requests.splice(0)
  })
  return {
    get url() {
      return url
    },
    requests,
    get last(): RecordedRequest {
      return requests.at(-1)!
    },
    reply(next: MockHandler) {
      handler = next
    },
  }
}
