import type { HttpHeadersInit } from './options'
import type { HttpClientRequest } from './request'
import type { HttpClientResponse } from './response'
import { jsonReplacer } from '../utils'
import { redactUrl } from './redact'

/** 没有响应体的状态码（Response 构造函数不接受响应体） */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])

/** `Http.response()`：假响应（每次匹配都生成新的 Response） */
export class HttpFakeResponse {
  readonly status: number
  readonly headers: Headers
  readonly #body: RequestInit['body']

  constructor(body: unknown = '', status = 200, headers: HttpHeadersInit = {}) {
    this.status = status
    this.headers = new Headers(headers)
    if (body === '' || body === undefined || NULL_BODY_STATUS.has(status)) {
      this.#body = null
    }
    else if (typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof URLSearchParams || body instanceof FormData) {
      this.#body = body as NonNullable<RequestInit['body']>
    }
    else {
      this.#body = JSON.stringify(body, jsonReplacer)
      if (!this.headers.has('content-type'))
        this.headers.set('content-type', 'application/json')
    }
  }

  toResponse(): Response {
    return new Response(this.#body, { status: this.status, headers: this.headers })
  }
}

/** `Http.failedConnection()`：模拟连接失败（请求方收到 ConnectionException） */
export class HttpFailedConnection {
  constructor(readonly message = 'Connection refused (faked)') {}
}

/** 假响应的取值：响应对象、连接失败、标准 Response，或直接给出响应体（字符串 / 对象，状态 200） */
export type HttpStubResult = HttpFakeResponse | HttpFailedConnection | Response | string | Record<string, unknown> | unknown[]

/** 回调返回 undefined 表示不处理，继续匹配后面的规则 */
export type HttpStubCallback = (request: HttpClientRequest) => HttpStubResult | HttpResponseSequence | undefined | Promise<HttpStubResult | HttpResponseSequence | undefined>

export type HttpStub = HttpStubResult | HttpResponseSequence | HttpStubCallback

/** `Http.fake()` 的参数：不传为所有请求返回空的 200；URL 模式（`*` 为通配符）到假响应的映射；或一个回调 */
export type HttpFakeDefinition = Record<string, HttpStub> | HttpStubCallback

/** `Http.sequence()`：按顺序返回的假响应 */
export class HttpResponseSequence {
  readonly #items: Array<HttpFakeResponse | HttpFailedConnection | Response>
  #whenEmpty: HttpFakeResponse | undefined

  constructor(items: Array<HttpFakeResponse | HttpFailedConnection | Response> = []) {
    this.#items = [...items]
  }

  /** 追加一个响应：`push({ id: 1 })`、`push('', 500)` */
  push(body: unknown = '', status = 200, headers: HttpHeadersInit = {}): this {
    return this.pushResponse(new HttpFakeResponse(body, status, headers))
  }

  pushStatus(status: number, headers: HttpHeadersInit = {}): this {
    return this.push('', status, headers)
  }

  pushResponse(response: HttpFakeResponse | HttpFailedConnection | Response): this {
    this.#items.push(response)
    return this
  }

  pushFailedConnection(message?: string): this {
    return this.pushResponse(new HttpFailedConnection(message))
  }

  /** 用完之后返回的响应（默认用完后抛出错误） */
  whenEmpty(response: HttpFakeResponse | unknown): this {
    this.#whenEmpty = response instanceof HttpFakeResponse
      ? response
      : new HttpFakeResponse(response)
    return this
  }

  /** 用完之后返回空的 200 */
  dontFailWhenEmpty(): this {
    return this.whenEmpty(new HttpFakeResponse())
  }

  get isEmpty(): boolean {
    return this.#items.length === 0
  }

  /** @internal */
  next(request: HttpClientRequest): HttpFakeResponse | HttpFailedConnection | Response {
    const item = this.#items.shift()
    if (item)
      return item
    if (this.#whenEmpty)
      return this.#whenEmpty
    throw new Error(`The response sequence for ${request.method} ${redactUrl(request.url)} is empty`)
  }
}

/** 记录的一次请求：[请求, 响应]；连接失败时响应为 undefined */
export type HttpRecord = [request: HttpClientRequest, response: HttpClientResponse | undefined]

export type HttpRecordPredicate = (request: HttpClientRequest, response: HttpClientResponse | undefined) => boolean

interface Rule {
  matches: (request: HttpClientRequest) => boolean
  stub: HttpStub
}

const METHOD_RE = /^([A-Z]+)\s+(\S.*)$/

/** URL 模式 → 正则：`*` 匹配任意字符；没有协议的模式自动在前面补 `*`；可以带方法前缀（`POST api.example.com/*`） */
export function urlPattern(pattern: string): (request: HttpClientRequest) => boolean {
  const method = METHOD_RE.exec(pattern)
  const [verb, rest] = method
    ? [method[1], method[2]!]
    : [undefined, pattern]
  const source = /^(?:\*|[a-z][\w+.-]*:\/\/)/i.test(rest)
    ? rest
    : `*${rest}`
  const regex = new RegExp(`^${source.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return (request) => {
    if (verb && request.method !== verb)
      return false
    return regex.test(request.url) || regex.test(request.url.split(/[?#]/)[0]!)
  }
}

/** 断言失败时给出已记录的请求（最多 10 条） */
function describeRecorded(records: HttpRecord[]): string {
  if (!records.length)
    return 'No requests were recorded.'
  const lines = records.slice(-10).map(([request, response]) => `  ${request.method} ${redactUrl(request.url)} → ${response?.status ?? 'connection failed'}`)
  return `Recorded requests${records.length > 10
    ? ' (last 10)'
    : ''}:\n${lines.join('\n')}`
}

/**
 * `Http.fake()` 的状态（每个应用一份，随应用创建与销毁）：假响应规则、记录与断言。
 * 只拦截 `Http` 客户端发出的请求，不修改 globalThis.fetch。
 */
export class HttpFake {
  readonly #rules: Rule[] = []
  readonly #records: HttpRecord[] = []
  readonly #sequences = new Set<HttpResponseSequence>()
  #preventStray = false
  readonly #allowed: Array<(request: HttpClientRequest) => boolean> = []

  /** 追加规则（后添加的优先匹配，便于在单个用例中覆盖 beforeEach 中的规则） */
  stub(definition?: HttpFakeDefinition): this {
    const rules: Rule[] = []
    if (definition === undefined) {
      rules.push({
        matches: () => true,
        stub: new HttpFakeResponse(),
      })
    }
    else if (typeof definition === 'function') {
      rules.push({
        matches: () => true,
        stub: definition,
      })
    }
    else {
      for (const [pattern, stub] of Object.entries(definition)) {
        if (stub instanceof HttpResponseSequence)
          this.#sequences.add(stub)
        rules.push({
          matches: urlPattern(pattern),
          stub,
        })
      }
    }
    this.#rules.unshift(...rules)
    return this
  }

  /** 没有匹配的假响应时抛出 StrayRequestException（而不是发出真实请求） */
  preventStrayRequests(prevent = true): this {
    this.#preventStray = prevent
    return this
  }

  /** 在 preventStrayRequests() 下仍允许真实发出的 URL 模式（如本地的测试服务器） */
  allowStrayRequests(patterns: string[]): this {
    this.#allowed.push(...patterns.map(urlPattern))
    return this
  }

  /** @internal */
  async resolve(request: HttpClientRequest): Promise<HttpFakeResponse | HttpFailedConnection | Response | undefined> {
    for (const rule of this.#rules) {
      if (!rule.matches(request))
        continue
      const result = await this.#evaluate(rule.stub, request)
      if (result !== undefined)
        return result
    }
    return undefined
  }

  async #evaluate(stub: HttpStub | undefined, request: HttpClientRequest): Promise<HttpFakeResponse | HttpFailedConnection | Response | undefined> {
    if (stub === undefined)
      return undefined
    if (typeof stub === 'function')
      return this.#evaluate(await stub(request), request)
    if (stub instanceof HttpResponseSequence)
      return stub.next(request)
    if (stub instanceof HttpFakeResponse || stub instanceof HttpFailedConnection || stub instanceof Response)
      return stub
    return new HttpFakeResponse(stub)
  }

  /** @internal */
  isStray(request: HttpClientRequest): boolean {
    return this.#preventStray && !this.#allowed.some(matches => matches(request))
  }

  /** @internal */
  record(request: HttpClientRequest, response: HttpClientResponse | undefined): void {
    this.#records.push([request, response])
  }

  /** 已记录的请求与响应；传入条件时只返回匹配的 */
  recorded(predicate?: HttpRecordPredicate): HttpRecord[] {
    return predicate
      ? this.#records.filter(([request, response]) => predicate(request, response))
      : [...this.#records]
  }

  /** 至少有一个请求满足条件 */
  assertSent(predicate: HttpRecordPredicate): void {
    if (!this.recorded(predicate).length)
      throw new Error(`An expected request was not recorded.\n${describeRecorded(this.#records)}`)
  }

  /** 没有请求满足条件 */
  assertNotSent(predicate: HttpRecordPredicate): void {
    const matched = this.recorded(predicate)
    if (matched.length)
      throw new Error(`An unexpected request was recorded.\n${describeRecorded(matched)}`)
  }

  assertSentCount(count: number): void {
    if (this.#records.length !== count)
      throw new Error(`Expected ${count} request(s) to be sent, got ${this.#records.length}.\n${describeRecorded(this.#records)}`)
  }

  assertNothingSent(): void {
    if (this.#records.length)
      throw new Error(`Expected no requests to be sent, got ${this.#records.length}.\n${describeRecorded(this.#records)}`)
  }

  /** 按顺序发送了这些请求（每个条件依次匹配一个记录） */
  assertSentInOrder(predicates: HttpRecordPredicate[]): void {
    if (predicates.length !== this.#records.length)
      throw new Error(`Expected ${predicates.length} request(s) in order, got ${this.#records.length}.\n${describeRecorded(this.#records)}`)
    predicates.forEach((predicate, index) => {
      const [request, response] = this.#records[index]!
      if (!predicate(request, response))
        throw new Error(`Request #${index + 1} (${request.method} ${redactUrl(request.url)}) did not match.\n${describeRecorded(this.#records)}`)
    })
  }

  /** 传给 fake() 的所有 sequence 都已用完 */
  assertSequencesAreEmpty(): void {
    for (const sequence of this.#sequences) {
      if (!sequence.isEmpty)
        throw new Error('Not all response sequences are empty')
    }
  }
}
