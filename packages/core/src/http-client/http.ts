import type { HttpFake, HttpFakeDefinition, HttpRecord, HttpRecordPredicate } from './fake'
import type { HttpManager } from './manager'
import type { HttpClientOptions, HttpHeadersInit } from './options'
import { HttpFailedConnection, HttpFakeResponse, HttpResponseSequence } from './fake'
import { useHttpManager } from './manager'
import { PendingRequest } from './pending'

/**
 * `Http` 门面：本身是一个默认的请求构造器，另有创建客户端与测试用的方法。
 * 假响应只拦截经 `Http` 发出的请求，不修改 `globalThis.fetch`。
 */
export class HttpFactory extends PendingRequest {
  /** 独立的客户端：只使用传入的选项（不使用 config/http.ts 的 defaults），假响应与遥测照常生效 */
  create(options: HttpClientOptions = {}): PendingRequest {
    return new PendingRequest({
      layers: [options],
      standalone: true,
    })
  }

  /**
   * 拦截请求并返回假响应：
   * - `Http.fake()`：所有请求返回空的 200；
   * - `Http.fake({ 'api.github.com/*': Http.response({ login: 'ada' }) })`：按 URL 模式；
   * - `Http.fake(request => ...)`：回调，返回 undefined 时继续匹配。
   * 可以多次调用，后添加的规则优先；没有匹配的请求照常发出（除非 preventStrayRequests()）。
   */
  fake(definition?: HttpFakeDefinition): HttpFake {
    return useHttpManager().fake(definition)
  }

  /** 假响应：对象 / 数组编码为 JSON，字符串原样返回 */
  response(body: unknown = '', status = 200, headers: HttpHeadersInit = {}): HttpFakeResponse {
    return new HttpFakeResponse(body, status, headers)
  }

  /** 按顺序返回的假响应：`Http.sequence().push({ ok: true }).push('', 500).whenEmpty(Http.response('', 404))` */
  sequence(responses: unknown[] = []): HttpResponseSequence {
    return new HttpResponseSequence(responses.map(item => item instanceof HttpFakeResponse || item instanceof HttpFailedConnection || item instanceof Response
      ? item
      : new HttpFakeResponse(item)))
  }

  /** 模拟连接失败（请求方收到 ConnectionException） */
  failedConnection(message?: string): HttpFailedConnection {
    return new HttpFailedConnection(message)
  }

  /** 没有匹配假响应的请求抛出 StrayRequestException */
  preventStrayRequests(prevent = true): HttpFake {
    return useHttpManager().preventStrayRequests(prevent)
  }

  /** preventStrayRequests() 下仍允许真实发出的 URL 模式 */
  allowStrayRequests(patterns: string[]): HttpFake {
    return useHttpManager().allowStrayRequests(patterns)
  }

  /** 取消假响应与记录 */
  restore(): void {
    useHttpManager().restore()
  }

  recorded(predicate?: HttpRecordPredicate): HttpRecord[] {
    return useHttpManager().requireFake().recorded(predicate)
  }

  assertSent(predicate: HttpRecordPredicate): void {
    useHttpManager().requireFake().assertSent(predicate)
  }

  assertNotSent(predicate: HttpRecordPredicate): void {
    useHttpManager().requireFake().assertNotSent(predicate)
  }

  assertSentCount(count: number): void {
    useHttpManager().requireFake().assertSentCount(count)
  }

  assertNothingSent(): void {
    useHttpManager().requireFake().assertNothingSent()
  }

  assertSentInOrder(predicates: HttpRecordPredicate[]): void {
    useHttpManager().requireFake().assertSentInOrder(predicates)
  }

  assertSequencesAreEmpty(): void {
    useHttpManager().requireFake().assertSequencesAreEmpty()
  }

  /** 当前应用的 HttpManager */
  manager(): HttpManager {
    return useHttpManager()
  }
}

/**
 * 出站 HTTP 客户端（基于 fetch，可运行在 Node、Bun、Deno 与 Workers）：
 *
 * ```ts
 * const res = await Http.get('https://api.example.com/users', { query: { page: 2 } })
 * const users = await res.throw().json<User[]>()
 * await Http.client('github').retry(3, { backoff: 'exponential' }).post('/repos', { name: 'x' })
 * Http.fake({ 'api.github.com/*': Http.response({ login: 'ada' }) })   // 测试
 * ```
 */
export const Http: HttpFactory = new HttpFactory()
