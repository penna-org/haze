# HTTP Client

`Http` is a small client for calling other services: GitHub, payment providers, your own microservices. It is built on `fetch` with no dependencies, so it runs on Node, Bun, Deno and Cloudflare Workers, and it adds what plain `fetch` lacks: base URLs and named clients, JSON / form / multipart encoding, timeouts, retries with backoff, typed errors, concurrency limits, middleware, tracing, dashboard entries and test fakes.

```ts
import { Http } from '@hazejs/core'

const res = await Http.get('https://api.example.com/users', { query: { page: 2 } })
res.status // 200
const users = await res.throw().json<User[]>()
```

::: tip Paths
Examples on this page use the API template layout (`app/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Making requests

Every method returns a `Promise<HttpClientResponse>`:

```ts
await Http.get(url, options?)
await Http.head(url, options?)
await Http.post(url, data?, options?)
await Http.put(url, data?, options?)
await Http.patch(url, data?, options?)
await Http.delete(url, options?)        // a body goes in options.body
await Http.send('OPTIONS', url, options?)
```

`options` accepts everything the builder methods below set (`query`, `headers`, `timeout`, `retry`, `signal`, …) for a single request.

### Query parameters

```ts
await Http.get('https://api.example.com/search', { query: { q: 'haze', tags: ['a', 'b'], page: undefined } })
// → /search?q=haze&tags=a&tags=b

await Http.withQuery({ locale: 'en' }).get(url)
```

Arrays become repeated keys and `null` / `undefined` values are skipped. Parameters already in the URL are kept.

### Responses

| Member | Description |
| --- | --- |
| `status`, `statusText`, `headers`, `url`, `redirected` | As on `Response` |
| `ok` / `successful()` | 2xx |
| `failed()`, `clientError()`, `serverError()`, `redirect()` | 4xx–5xx, 4xx, 5xx, 3xx |
| `header(name)` | One header |
| `json<T>()`, `text()`, `blob()`, `bytes()`, `arrayBuffer()` | Read the body. They share one buffer, so you can call them more than once; an empty body reads as `null` from `json()` |
| `stream()`, `sse()` | Read the body incrementally (see [Streaming](#streaming)) |
| `throw()` | Throws `HttpRequestException` on 4xx / 5xx, otherwise returns the response |
| `throwIf(condition)` | `throw()` when the condition holds |
| `toResponse()` | A standard `Response`, e.g. to return it from a route |
| `raw` | The underlying `Response` |
| `request` | The request that produced it |

A response with a 4xx / 5xx status is buffered before it is returned, so `throw()` can include a preview of the body. Call `.throw()` on the builder to throw automatically:

```ts
const repo = await (await Http.throw().get(url)).json()
```

## Request bodies

Objects and arrays are sent as JSON by default (`BigInt` values become strings). Strings, `Blob`, `ArrayBuffer`, typed arrays, `URLSearchParams`, `FormData` and `ReadableStream` are sent as they are.

```ts
await Http.post(url, { name: 'Ada' })                        // application/json
await Http.asForm().post(url, { a: 1, user: { name: 'Ada' } }) // a=1&user%5Bname%5D=Ada
await Http.asMultipart().post(url, { caption: 'hi', photo: file })
await Http.attach('file', blob, 'a.png').post(url, { field: 'v' }) // multipart, with the fields
await Http.withBody('<xml/>', 'application/xml').post(url)
```

In form and multipart bodies nested objects use brackets (`user[name]`) and arrays repeat the key. `Blob` / `File` values in a multipart body are sent as files. `asJson()` switches back to JSON.

## Headers and authentication

```ts
Http.withHeaders({ 'x-request-source': 'billing' })
  .withHeader('x-one', '1')
  .accept('application/vnd.github+json') // or .acceptJson()
  .contentType('application/xml')
  .withUserAgent('my-app/1.0')
  .withToken(token)                      // Authorization: Bearer <token>
  .withToken(token, 'Token')             // Authorization: Token <token>
  .withBasicAuth('user', 'password')
```

Credentials in a URL (`https://user:pass@host/`) are turned into a basic `Authorization` header, because `fetch` rejects such URLs.

## The builder

`Http` is itself a request builder, and every method returns a **new** builder. Nothing is shared or mutated, so you can keep a configured builder in a module and reuse it:

```ts
// app/service/github.ts
export const github = Http.baseURL('https://api.github.com')
  .withHeaders({ accept: 'application/vnd.github+json' })
  .withToken(process.env.GITHUB_TOKEN!)
  .timeout('5s')
  .retry(3, { backoff: 'exponential' })

const repos = await (await github.get('/user/repos', { query: { per_page: 100 } })).json()
```

`baseURL` is joined by concatenation: `/api/v1` + `/users` gives `/api/v1/users`. Absolute URLs ignore it. Placeholders are filled from `withUrlParameters()` and encoded:

```ts
await github.withUrlParameters({ owner: 'penna-org', repo: 'haze' }).get('/repos/{owner}/{repo}')
```

Other builder methods: `withOptions(options)`, `withSignal(signal)`, `withoutRedirecting()` (3xx responses are returned as they are), `withFetch(fn)` (a custom `fetch`, e.g. a Workers service binding) and `withMiddleware(fn)`.

`Http.create(options)` makes an independent client from plain options (the same shape as a named client below). It does not use the `defaults` from `config/http.ts`.

## Named clients

Put shared settings in `config/http.ts`:

```ts
// config/http.ts
import { defineHttpConfig, env } from '@hazejs/core'

export default defineHttpConfig(() => ({
  // Applied to every request made through Http (not to Http.create())
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

Settings are layered: `defaults` → the named client → builder calls → per-request options. Headers and query parameters merge, middleware accumulates, everything else is overridden by the later layer.

| Option | Description |
| --- | --- |
| `baseURL` | Prefix for relative URLs |
| `headers` | Default headers |
| `query` | Default query parameters |
| `token` / `basicAuth` | Bearer token / `[username, password]` |
| `timeout` | Per attempt, default `30s`; `false` disables it |
| `retry` | Number of attempts or retry options (see below) |
| `bodyFormat` | `json` (default), `form` or `multipart` |
| `middleware` | Request middleware |
| `fetch` | A custom `fetch` |
| `redirect` | `follow` (default), `manual` or `error` |
| `throw` | Throw `HttpRequestException` on 4xx / 5xx |

The top level of `config/http.ts` also takes `redactHeaders`: extra header names to mask in telemetry.

## Timeouts

```ts
await Http.timeout('5s').get(url)
await Http.timeout(1500).get(url)  // numbers are milliseconds
await Http.timeout(false).get(url) // no limit
```

The default is 30 seconds. The timeout applies to **each attempt** and covers receiving the response and reading the body with `json()` / `text()` / …; when it runs out the request is aborted with a `TimeoutException`. Once you start reading with `stream()` or `sse()` the timeout no longer applies; pass a `signal` to bound a stream. A separate connect timeout is not available, since `fetch` has no such phase.

Pass an `AbortSignal` to cancel a request yourself. An aborted request rejects with the signal's reason (usually an `AbortError`), not with a `ConnectionException`, and is not retried.

```ts
await Http.get(url, { signal: AbortSignal.timeout(2000) })
```

## Retries

```ts
await Http.retry(3).get(url) // up to 3 attempts in total
await Http.retry(3, { delay: '200ms', backoff: 'exponential', maxDelay: '5s' }).post(url, data)
await Http.retry(5, {
  when: (response, error, request) => error !== undefined || response?.status === 409,
}).put(url, data)
```

`times` counts attempts, including the first one (as in Laravel's `retry(3)`). By default a request is retried when it fails to connect (including timeouts) or when the status is 408, 425, 429, 500, 502, 503 or 504. `when(response, error, request)` replaces that rule; it is called for connection errors and 4xx / 5xx responses.

| Option | Description |
| --- | --- |
| `delay` | Wait before the first retry, default `100ms` |
| `backoff` | `constant` (default), `linear`, `exponential`, a list of delays, or `(retry) => ms` |
| `maxDelay` | Upper bound for one wait |
| `retryAfter` | Honour `retry-after` (seconds or an HTTP date) and `retry-after-ms` on 429 / 503, default `true` |
| `maxRetryAfter` | Give up and return the response when `retry-after` asks for longer, default `60s` |

When the attempts run out, the last response is returned (call `throw()` to turn it into an exception) or the last `ConnectionException` is thrown. Requests with a `ReadableStream` body are never retried, since the body can only be read once.

## Errors

| Error | When | Useful properties |
| --- | --- | --- |
| `HttpRequestException` | `throw()` on a 4xx / 5xx response | `response`, `request`, `status`, `body` (the first 500 characters) |
| `ConnectionException` | No response: DNS, refused connection, TLS, reset | `request`, `cause` (the original error) |
| `TimeoutException` | The timeout ran out (a subclass of `ConnectionException`) | `request`, `timeout` (ms) |
| `StrayRequestException` | A request without a fake after `Http.preventStrayRequests()` | `request` |

Messages include the method and URL. Credentials in the URL and the values of query parameters that look secret (`token`, `api_key`, `key`, `secret`, `password`, `signature`, `sig`, `code`, …) are replaced with `[REDACTED]`:

```
HTTP request returned status code 404: GET https://api.example.com/items?api_key=[REDACTED]
{"message":"Not Found"}
```

## Concurrent requests

`pool()` sends a group of requests concurrently and resolves with the responses in the same order, or under the same keys:

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

The `p` passed to the callback inherits the builder's settings, and its requests only start when the pool schedules them, so `concurrency` really limits how many run at once (the default is no limit). If a request throws, no new requests are started and the pool rejects with that error. HTTP error statuses are responses, not errors.

## Middleware

Middleware wraps every attempt. It can change the request (its `url`, `method`, `headers` and `body` are writable) or look at the response:

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

The first middleware registered is the outermost. Middleware from `defaults`, the named client and the builder run in that order. Because retries happen outside the middleware, each attempt goes through it again (`request.attempt` says which one).

## Streaming

```ts
const res = await Http.get('https://example.com/large.csv')
for await (const chunk of res.stream()) {
  // chunk is a Uint8Array
}

// text/event-stream
for await (const event of (await Http.accept('text/event-stream').get(sseUrl)).sse()) {
  console.log(event.event, event.data, event.id)
}
```

`stream()` can only be read once and is not buffered. `sse()` handles multi-line `data`, comments, `id` and `retry` fields and CRLF line endings.

## Third-party SDKs

`Http.fake()` intercepts requests made through `Http` only. It does **not** patch `globalThis.fetch`, so other libraries keep using the real network. Most SDKs accept a custom `fetch`; give them one built from `Http` and their requests get the client's settings, retries, tracing, dashboard entries and fakes:

```ts
import OpenAI from 'openai'

const openai = new OpenAI({ fetch: Http.timeout(false).toFetch() })
```

`toFetch()` reads the request body into memory before sending it. For SDKs that don't accept a `fetch`, mock them at the module level in your tests (for example `vi.mock()`), or point them at a local test server.

## Observability

- **Tracing**: with [OpenTelemetry](./observability#opentelemetry) enabled, every attempt that reaches the network creates a CLIENT span (`http.request.method`, `url.full`, `server.address`, `http.response.status_code`) and sends `traceparent` downstream, continuing the current request's trace.
- **Dashboard**: each attempt is recorded as an `http` telemetry event and shown under **HTTP Client** in the [dev dashboard](./observability#dev-dashboard), linked to the request that made it: method, URL, status, duration (until the response headers arrive), request and response sizes, attempt, named client and error. Faked responses are marked. `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token` and CSRF headers are masked, plus anything in `redactHeaders`; URLs are redacted as in error messages.

Listen to the events yourself with `onTelemetry()`:

```ts
onTelemetry((kind, data) => {
  if (kind === 'http' && data.duration > 1000)
    logger.warn('Slow outgoing request', data)
})
```

## Testing

`Http.fake()` stops requests from leaving the process and records them for assertions. Like the other [fakes](./testing#fakes) it belongs to the current application, so with `useTestApp()` each test starts clean.

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

### Fake responses

```ts
Http.fake() // every request gets an empty 200

Http.fake({
  'api.github.com/*': Http.response({ login: 'ada' }, 200, { 'x-ratelimit-remaining': '42' }),
  'POST example.com/users': Http.response({ id: 1 }, 201),
  'example.com/users/*': request => Http.response({ id: request.url.split('/').pop() }),
  'example.com/health': 'ok',          // a string or object is a 200 body
  'example.com/down': Http.failedConnection(),
  '*': Http.response('', 500),         // everything else
})

Http.fake(request => request.method === 'DELETE' ? Http.response('', 204) : undefined)
```

- Patterns match the full URL, with or without the query string. `*` matches anything (including `/`), and a pattern without a scheme matches any scheme. Prefix a method to match only that method.
- `Http.response(body?, status = 200, headers?)`: objects and arrays are encoded as JSON with `content-type: application/json`; strings, `Blob` and bytes are returned as they are. A standard `Response` works too.
- A callback receives the [request](#the-request-object) and may return a response, a body, a sequence or `undefined` to fall through to the next rule.
- `Http.failedConnection(message?)` makes the request throw a `ConnectionException`, which is useful for testing retries.
- `Http.fake()` can be called again to add rules. Rules added later are checked first, so a test can override what a `beforeEach` set up.
- Faked requests still go through middleware, retries and `throw()`, and appear in telemetry.

### Sequences

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

Each matching request takes the next response. Without `whenEmpty()` (or `dontFailWhenEmpty()`, which returns an empty 200), a request after the last one throws. `Http.sequence([{ a: 1 }, Http.response('', 500)])` builds one from a list, and `Http.assertSequencesAreEmpty()` checks that every sequence was used up.

### Stray requests

Requests that no rule matches go to the network, and they are recorded too. `Http.preventStrayRequests()` makes them throw a `StrayRequestException` instead; it works with or without `Http.fake()`. Let some through, for example a local test server, with `Http.allowStrayRequests(['127.0.0.1:*'])`.

### Assertions

| Method | Checks |
| --- | --- |
| `Http.assertSent((request, response) => boolean)` | At least one recorded request matches |
| `Http.assertNotSent(predicate)` | No recorded request matches |
| `Http.assertSentCount(n)` | Exactly `n` requests (each retry attempt counts) |
| `Http.assertNothingSent()` | No requests |
| `Http.assertSentInOrder([predicate, …])` | The requests, in this order |
| `Http.assertSequencesAreEmpty()` | All sequences were used up |
| `Http.recorded(predicate?)` | `[request, response]` pairs; `response` is `undefined` for a failed connection |

Assertions need `Http.fake()` (or `preventStrayRequests()`) first. `Http.fake()` also returns the fake, which has the same methods. `Http.restore()` turns faking off.

### The request object

Middleware, fake callbacks and assertions receive an `HttpClientRequest`:

| Member | Description |
| --- | --- |
| `method`, `url`, `headers` | The final values, after middleware |
| `body` | The encoded body: a string for JSON, `URLSearchParams` for forms, `FormData` for multipart |
| `data` | What you passed to `post(url, data)` before encoding |
| `json()`, `form()`, `text()` | The body parsed as JSON, as form fields (repeated fields become arrays, files are `File`s) or as text |
| `header(name)`, `hasHeader(name, value?)` | `value` may be a string or a `RegExp` |
| `query` | Query parameters as an object |
| `isJson()`, `isForm()`, `isMultipart()` | The body type |
| `attempt` | 1 for the first attempt, 2 for the first retry, … |
| `client` | The named client, if any |

Without an application (plain unit tests that never boot one), `Http` uses a process-wide fake, so call `Http.restore()` in `afterEach`.

## Runtimes

The client uses only `fetch`, `Headers`, `Request` / `Response`, `FormData`, `Blob`, `AbortController` and `TextEncoder` / `TextDecoder`, which Node 22+, Bun, Deno and Workers all provide. On Workers, call another Worker through a service binding with `withFetch(env.OTHER.fetch.bind(env.OTHER))`.
