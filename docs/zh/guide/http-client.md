# HTTP 客户端

`Http` 用来调用其它服务：GitHub、支付平台、自己的微服务等。它基于 `fetch`，没有任何依赖，可以运行在 Node、Bun、Deno 与 Cloudflare Workers 上，并补上了 `fetch` 缺少的部分：baseURL 与命名客户端、JSON / 表单 / multipart 编码、超时、带退避的重试、明确的错误类型、并发上限、中间件、链路追踪、开发面板记录以及测试用的 fake。

```ts
import { Http } from '@hazejs/core'

const res = await Http.get('https://api.example.com/users', { query: { page: 2 } })
res.status // 200
const users = await res.throw().json<User[]>()
```

::: tip 路径
本页示例使用 API 模板的目录结构（`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 发送请求

每个方法都返回 `Promise<HttpClientResponse>`：

```ts
await Http.get(url, options?)
await Http.head(url, options?)
await Http.post(url, data?, options?)
await Http.put(url, data?, options?)
await Http.patch(url, data?, options?)
await Http.delete(url, options?)        // 请求体放在 options.body
await Http.send('OPTIONS', url, options?)
```

`options` 可以设置下文构造器方法能设置的所有选项（`query`、`headers`、`timeout`、`retry`、`signal` 等），只作用于这一次请求。

### 查询参数

```ts
await Http.get('https://api.example.com/search', { query: { q: 'haze', tags: ['a', 'b'], page: undefined } })
// → /search?q=haze&tags=a&tags=b

await Http.withQuery({ locale: 'zh-CN' }).get(url)
```

数组会展开为同名参数，值为 `null` / `undefined` 的参数会被跳过。URL 中原有的参数保留。

### 响应

| 成员 | 说明 |
| --- | --- |
| `status`、`statusText`、`headers`、`url`、`redirected` | 与 `Response` 相同 |
| `ok` / `successful()` | 2xx |
| `failed()`、`clientError()`、`serverError()`、`redirect()` | 4xx–5xx、4xx、5xx、3xx |
| `header(name)` | 读取一个响应头 |
| `json<T>()`、`text()`、`blob()`、`bytes()`、`arrayBuffer()` | 读取响应体。它们共用同一份缓冲，可以重复调用；响应体为空时 `json()` 返回 `null` |
| `stream()`、`sse()` | 逐步读取响应体（见[流式响应](#流式响应)） |
| `throw()` | 4xx / 5xx 时抛出 `HttpRequestException`，否则返回响应本身 |
| `throwIf(condition)` | 条件成立时执行 `throw()` |
| `toResponse()` | 转为标准 `Response`，例如直接作为路由的返回值 |
| `raw` | 底层的 `Response` |
| `request` | 产生该响应的请求 |

状态码为 4xx / 5xx 的响应在返回之前会先读入缓冲，因此 `throw()` 的错误信息里能带上响应体的开头部分。在构造器上调用 `.throw()` 则会自动抛出：

```ts
const repo = await (await Http.throw().get(url)).json()
```

## 请求体

对象与数组默认编码为 JSON（`BigInt` 转为字符串）。字符串、`Blob`、`ArrayBuffer`、TypedArray、`URLSearchParams`、`FormData` 与 `ReadableStream` 原样发送。

```ts
await Http.post(url, { name: 'Ada' })                        // application/json
await Http.asForm().post(url, { a: 1, user: { name: 'Ada' } }) // a=1&user%5Bname%5D=Ada
await Http.asMultipart().post(url, { caption: 'hi', photo: file })
await Http.attach('file', blob, 'a.png').post(url, { field: 'v' }) // multipart，字段一并发送
await Http.withBody('<xml/>', 'application/xml').post(url)
```

表单与 multipart 中，嵌套对象用方括号表示（`user[name]`），数组重复同名字段。multipart 中值为 `Blob` / `File` 的字段作为文件发送。`asJson()` 切换回 JSON。

## 请求头与认证

```ts
Http.withHeaders({ 'x-request-source': 'billing' })
  .withHeader('x-one', '1')
  .accept('application/vnd.github+json') // 或 .acceptJson()
  .contentType('application/xml')
  .withUserAgent('my-app/1.0')
  .withToken(token)                      // Authorization: Bearer <token>
  .withToken(token, 'Token')             // Authorization: Token <token>
  .withBasicAuth('user', 'password')
```

`fetch` 不接受带用户名密码的 URL（`https://user:pass@host/`），这类 URL 中的凭据会自动转为 Basic 认证的 `Authorization` 请求头。

## 构造器

`Http` 本身就是一个请求构造器，每个方法都返回**新的**构造器，不会修改原来的对象。因此可以把配置好的构造器放在模块里反复使用：

```ts
// app/service/github.ts
export const github = Http.baseURL('https://api.github.com')
  .withHeaders({ accept: 'application/vnd.github+json' })
  .withToken(process.env.GITHUB_TOKEN!)
  .timeout('5s')
  .retry(3, { backoff: 'exponential' })

const repos = await (await github.get('/user/repos', { query: { per_page: 100 } })).json()
```

`baseURL` 与路径直接拼接：`/api/v1` + `/users` 得到 `/api/v1/users`；绝对地址不受它影响。路径中的占位符由 `withUrlParameters()` 填充，并自动编码：

```ts
await github.withUrlParameters({ owner: 'penna-org', repo: 'haze' }).get('/repos/{owner}/{repo}')
```

其它构造器方法：`withOptions(options)`、`withSignal(signal)`、`withoutRedirecting()`（不跟随重定向，原样返回 3xx）、`withFetch(fn)`（自定义 `fetch`，例如 Workers 的 service binding）和 `withMiddleware(fn)`。

`Http.create(options)` 用一组选项创建独立的客户端（选项格式与下面的命名客户端相同），它不使用 `config/http.ts` 中的 `defaults`。

## 命名客户端

公共的设置放在 `config/http.ts` 中：

```ts
// config/http.ts
import { defineHttpConfig, env } from '@hazejs/core'

export default defineHttpConfig(() => ({
  // 所有经 Http 发出的请求都使用（Http.create() 创建的客户端除外）
  defaults: {
    timeout: '10s',
    headers: { 'user-agent': 'my-app/1.0' },
  },
  clients: {
    github: {
      baseURL: 'https://api.github.com',
      headers: { accept: 'application/vnd.github+json' },
      token: env('GITHUB_TOKEN'),
      timeout: '5s',
      retry: { times: 3, backoff: 'exponential' },
    },
  },
}))
```

```ts
const user = await (await Http.client('github').get('/user')).json()
await Http.client('github').withHeader('x-github-api-version', '2026-03-10').post('/user/repos', { name: 'x' })
```

设置按层叠加：`defaults` → 命名客户端 → 构造器上的调用 → 单次请求的选项。请求头与查询参数合并，中间件依次追加，其余选项由后面的层覆盖。

| 选项 | 说明 |
| --- | --- |
| `baseURL` | 相对地址的前缀 |
| `headers` | 默认请求头 |
| `query` | 默认查询参数 |
| `token` / `basicAuth` | Bearer 令牌 / `[用户名, 密码]` |
| `timeout` | 每次尝试的超时，默认 `30s`；`false` 不限制 |
| `retry` | 尝试次数或重试选项（见下文） |
| `bodyFormat` | `json`（默认）、`form` 或 `multipart` |
| `middleware` | 请求中间件 |
| `fetch` | 自定义 `fetch` |
| `redirect` | `follow`（默认）、`manual` 或 `error` |
| `throw` | 4xx / 5xx 时抛出 `HttpRequestException` |

`config/http.ts` 的顶层还可以设置 `redactHeaders`：遥测中额外需要隐藏的请求头。

## 超时

```ts
await Http.timeout('5s').get(url)
await Http.timeout(1500).get(url)  // 数字为毫秒
await Http.timeout(false).get(url) // 不限制
```

默认 30 秒。超时**按每次尝试**计算，包括收到响应与用 `json()` / `text()` 等方法读取响应体的时间；到时请求被中止，抛出 `TimeoutException`。开始用 `stream()` 或 `sse()` 读取之后不再受超时限制，需要时传入 `signal`。`fetch` 没有单独的建立连接阶段，因此不提供连接超时。

也可以传入 `AbortSignal` 自行取消请求。被取消的请求以 signal 的 reason（通常是 `AbortError`）拒绝，而不是 `ConnectionException`，也不会重试。

```ts
await Http.get(url, { signal: AbortSignal.timeout(2000) })
```

## 重试

```ts
await Http.retry(3).get(url) // 最多尝试 3 次
await Http.retry(3, { delay: '200ms', backoff: 'exponential', maxDelay: '5s' }).post(url, data)
await Http.retry(5, {
  when: (response, error, request) => error !== undefined || response?.status === 409,
}).put(url, data)
```

`times` 是包括第一次在内的尝试次数（与 Laravel 的 `retry(3)` 相同）。默认在连接失败（包括超时）以及状态码为 408、425、429、500、502、503、504 时重试。`when(response, error, request)` 会替代这条默认规则，它在连接失败与响应为 4xx / 5xx 时调用。

| 选项 | 说明 |
| --- | --- |
| `delay` | 第一次重试前等待的时间，默认 `100ms` |
| `backoff` | `constant`（默认）、`linear`、`exponential`、延迟列表，或 `(retry) => 毫秒数` |
| `maxDelay` | 单次等待的上限 |
| `retryAfter` | 429 / 503 时遵循 `retry-after`（秒数或 HTTP 日期）与 `retry-after-ms`，默认 `true` |
| `maxRetryAfter` | `retry-after` 要求的等待超过该值时不再重试，直接返回该响应，默认 `60s` |

次数用完后返回最后一个响应（需要异常时调用 `throw()`），或抛出最后一个 `ConnectionException`。请求体为 `ReadableStream` 的请求不会重试，因为流只能读一次。

## 错误

| 错误 | 何时抛出 | 常用属性 |
| --- | --- | --- |
| `HttpRequestException` | 对 4xx / 5xx 响应调用 `throw()` | `response`、`request`、`status`、`body`（前 500 个字符） |
| `ConnectionException` | 没有拿到响应：DNS、连接被拒绝、TLS、连接重置等 | `request`、`cause`（原始错误） |
| `TimeoutException` | 超时（`ConnectionException` 的子类） | `request`、`timeout`（毫秒） |
| `StrayRequestException` | 调用 `Http.preventStrayRequests()` 后发出了没有假响应的请求 | `request` |

错误信息包含请求方法与 URL。URL 中的凭据，以及名称像密钥的查询参数（`token`、`api_key`、`key`、`secret`、`password`、`signature`、`sig`、`code` 等）的值会替换为 `[REDACTED]`：

```
HTTP request returned status code 404: GET https://api.example.com/items?api_key=[REDACTED]
{"message":"Not Found"}
```

## 并发请求

`pool()` 并发发送一组请求，按相同的顺序（或相同的键）返回响应：

```ts
const [users, posts] = await Http.pool(p => [
  p.get('https://api.example.com/users'),
  p.get('https://api.example.com/posts'),
], { concurrency: 5 })

const { user, repos } = await Http.client('github').pool(p => ({
  user: p.get('/user'),
  repos: p.get('/user/repos'),
}))
```

回调中的 `p` 继承当前构造器的设置，它发出的请求要等到被调度时才真正开始，所以 `concurrency` 确实限制了同时进行的请求数（默认不限制）。某个请求抛出错误后，不再调度新的请求，`pool()` 以该错误拒绝。HTTP 错误状态码属于正常的响应，不算错误。

## 中间件

中间件包裹每一次尝试，可以修改请求（`url`、`method`、`headers`、`body` 都可写），也可以查看响应：

```ts
const signed = Http.withMiddleware(async (request, next) => {
  request.headers.set('x-signature', await sign(request.text()))
  return next(request)
}).withMiddleware(async (request, next) => {
  const started = Date.now()
  const response = await next(request)
  logger.info(`${request.method} ${request.url} ${response.status} ${Date.now() - started}ms`)
  return response
})
```

先注册的中间件在最外层。`defaults`、命名客户端与构造器上的中间件按这个顺序执行。重试发生在中间件之外，因此每次尝试都会重新经过中间件（`request.attempt` 表示第几次）。

## 流式响应

```ts
const res = await Http.get('https://example.com/large.csv')
for await (const chunk of res.stream()) {
  // chunk 是 Uint8Array
}

// text/event-stream
for await (const event of (await Http.accept('text/event-stream').get(sseUrl)).sse()) {
  console.log(event.event, event.data, event.id)
}
```

`stream()` 只能读取一次，不经过缓冲。`sse()` 处理多行 `data`、注释、`id` 与 `retry` 字段以及 CRLF 换行。

## 第三方 SDK

`Http.fake()` 只拦截经 `Http` 发出的请求，**不会**修改 `globalThis.fetch`，其它库仍然访问真实网络。大多数 SDK 都可以传入自定义的 `fetch`，把由 `Http` 生成的 fetch 交给它们，它们的请求就会使用客户端的设置、重试、链路追踪、开发面板记录与 fake：

```ts
import OpenAI from 'openai'

const openai = new OpenAI({ fetch: Http.timeout(false).toFetch() })
```

`toFetch()` 会先把请求体读入内存再发送。不支持自定义 `fetch` 的 SDK，可以在测试中按模块 mock（例如 `vi.mock()`），或让它访问本地的测试服务器。

## 可观测性

- **链路追踪**：启用 [OpenTelemetry](./observability#opentelemetry) 后，每次真正发往网络的尝试都会创建 CLIENT span（假响应不创建）（`http.request.method`、`url.full`、`server.address`、`http.response.status_code`），并把 `traceparent` 传给下游，接续当前请求的链路。
- **开发面板**：每次尝试记录为一条 `http` 遥测事件，显示在[开发面板](./observability#开发面板)的 **HTTP Client** 中，并关联到发出它的请求：方法、URL、状态码、耗时（到收到响应头为止）、请求与响应的大小、第几次尝试、命名客户端与错误；假响应会单独标出。`authorization`、`proxy-authorization`、`cookie`、`set-cookie`、`x-api-key`、`x-auth-token` 与 CSRF 相关的请求头会隐藏，`redactHeaders` 中的请求头同样隐藏；URL 的脱敏方式与错误信息相同。

也可以用 `onTelemetry()` 自行订阅：

```ts
onTelemetry((kind, data) => {
  if (kind === 'http' && data.duration > 1000)
    logger.warn('Slow outgoing request', data)
})
```

## 测试

`Http.fake()` 让请求不离开进程，并记录下来供断言。与其它 [fake](./testing#fake) 一样，它属于当前应用，使用 `useTestApp()` 时每个用例都从干净的状态开始。

```ts
// tests/github.test.ts
import { Http } from '@hazejs/core'
import { useTestApp } from '@hazejs/testing'
import { expect, it } from 'vitest'

const t = useTestApp()

it('shows the GitHub profile', async () => {
  Http.preventStrayRequests()
  Http.fake({
    'api.github.com/user': Http.response({ login: 'ada' }),
  })

  const res = await t.get('/api/profile')
  expect(res.body.data.login).toBe('ada')
  Http.assertSent(request => request.url === 'https://api.github.com/user'
    && request.hasHeader('authorization', 'Bearer test-token'))
})
```

### 假响应

```ts
Http.fake() // 所有请求返回空的 200

Http.fake({
  'api.github.com/*': Http.response({ login: 'ada' }, 200, { 'x-ratelimit-remaining': '42' }),
  'POST example.com/users': Http.response({ id: 1 }, 201),
  'example.com/users/*': request => Http.response({ id: request.url.split('/').pop() }),
  'example.com/health': 'ok',          // 字符串或对象直接作为 200 的响应体
  'example.com/down': Http.failedConnection(),
  '*': Http.response('', 500),         // 其余所有请求
})

Http.fake(request => request.method === 'DELETE' ? Http.response('', 204) : undefined)
```

- 模式与完整的 URL 匹配，带不带查询字符串都可以。`*` 匹配任意字符（包括 `/`），不写协议的模式匹配任何协议；在前面加上方法则只匹配该方法。
- `Http.response(body?, status = 200, headers?)`：对象与数组编码为 JSON，并带上 `content-type: application/json`；字符串、`Blob` 与字节原样返回。也可以直接给出标准的 `Response`。
- 回调接收[请求对象](#请求对象)，可以返回响应、响应体、序列，或返回 `undefined` 交给下一条规则。
- `Http.failedConnection(message?)` 让请求抛出 `ConnectionException`，适合测试重试。
- 可以多次调用 `Http.fake()` 追加规则。后添加的规则先匹配，因此单个用例可以覆盖 `beforeEach` 中的设置。
- 假响应同样经过中间件、重试与 `throw()`，也会出现在遥测中。

### 响应序列

```ts
Http.fake({
  'api.example.com/jobs/*': Http.sequence()
    .push({ status: 'queued' })
    .push({ status: 'running' })
    .push('', 500)
    .pushStatus(204)
    .pushFailedConnection()
    .whenEmpty(Http.response({ status: 'done' })),
})
```

每个匹配的请求依次取下一个响应。没有设置 `whenEmpty()`（或返回空 200 的 `dontFailWhenEmpty()`）时，用完之后的请求会报错。`Http.sequence([{ a: 1 }, Http.response('', 500)])` 可以由列表创建序列，`Http.assertSequencesAreEmpty()` 检查所有序列都已用完。

### 未匹配的请求

没有任何规则匹配的请求照常发往网络，同样会被记录。调用 `Http.preventStrayRequests()` 后，这类请求改为抛出 `StrayRequestException`，调不调用 `Http.fake()` 都有效。需要放行的地址（例如本地的测试服务器）用 `Http.allowStrayRequests(['127.0.0.1:*'])`。

### 断言

| 方法 | 检查 |
| --- | --- |
| `Http.assertSent((request, response) => boolean)` | 至少有一个记录满足条件 |
| `Http.assertNotSent(predicate)` | 没有记录满足条件 |
| `Http.assertSentCount(n)` | 恰好 `n` 个请求（每次重试都算一次） |
| `Http.assertNothingSent()` | 没有任何请求 |
| `Http.assertSentInOrder([predicate, …])` | 请求按这个顺序发出 |
| `Http.assertSequencesAreEmpty()` | 所有序列都已用完 |
| `Http.recorded(predicate?)` | `[request, response]` 记录；连接失败时 `response` 为 `undefined` |

断言之前需要先调用 `Http.fake()`（或 `preventStrayRequests()`）。`Http.fake()` 也会返回 fake 对象，上面有同样的方法。`Http.restore()` 关闭 fake。

### 请求对象

中间件、假响应的回调与断言拿到的都是 `HttpClientRequest`：

| 成员 | 说明 |
| --- | --- |
| `method`、`url`、`headers` | 经过中间件之后的最终值 |
| `body` | 编码后的请求体：JSON 为字符串，表单为 `URLSearchParams`，multipart 为 `FormData` |
| `data` | 编码之前传给 `post(url, data)` 的数据 |
| `json()`、`form()`、`text()` | 按 JSON、表单字段（同名字段为数组，文件为 `File`）或文本解析请求体 |
| `header(name)`、`hasHeader(name, value?)` | `value` 可以是字符串或 `RegExp` |
| `query` | 查询参数对象 |
| `isJson()`、`isForm()`、`isMultipart()` | 请求体的类型 |
| `attempt` | 第一次为 1，第一次重试为 2，依此类推 |
| `client` | 命名客户端的名字（没有时为 undefined） |

没有启动应用的单元测试中，`Http` 使用进程内共享的 fake，记得在 `afterEach` 中调用 `Http.restore()`。

## 运行时

客户端只用到 `fetch`、`Headers`、`Request` / `Response`、`FormData`、`Blob`、`AbortController` 与 `TextEncoder` / `TextDecoder`，Node 22+、Bun、Deno 与 Workers 都提供这些 API。在 Workers 中经 service binding 调用另一个 Worker：`withFetch(env.OTHER.fetch.bind(env.OTHER))`。
