# Errors & Logging

All exceptions are handled in one place. Whatever a route, middleware or controller throws is caught at the edge of the request, reported by the exception handler and rendered in the same response format as successful results.

## Throwing HTTP exceptions

Throw an exception to stop handling and return an error:

```ts
// app/service/UserService.ts
import { ForbiddenException, inject, NotFoundException } from '@hazejs/core'
import { UserRepository } from '~/app/repository/UserRepository'

export class UserService {
  private repo = inject(UserRepository)

  async find(id: number) {
    const user = await this.repo.findById(id)
    if (!user)
      throw new NotFoundException(`User ${id} not found`)
    if (user.banned)
      throw new ForbiddenException('This account is suspended')
    return user
  }
}
```

```json
{ "code": 404, "message": "User 9 not found", "data": null }
```

| Class | Status | Default message |
|-------|--------|-----------------|
| `BadRequestException` | 400 | Bad Request |
| `UnauthorizedException` | 401 | Unauthorized |
| `ForbiddenException` | 403 | Forbidden |
| `NotFoundException` | 404 | Not Found |
| `MethodNotAllowedException` | 405 | Method Not Allowed |
| `ConflictException` | 409 | Conflict |
| `CsrfTokenMismatchException` | 419 | Page Expired |
| `ValidationException` | 422 | Validation Failed |
| `TooManyRequestsException` | 429 | Too Many Requests |
| `InternalServerErrorException` | 500 | Internal Server Error |
| `BusinessException` | 200 | (required) |

All of them extend `HttpException`, which in turn extends h3's `HTTPError`. The second argument takes options:

```ts
import { ConflictException, HttpException, TooManyRequestsException } from '@hazejs/core'

throw new ConflictException('Email already registered', {
  code: 40901, // business code in the body (defaults to the HTTP status)
  data: { field: 'email' }, // goes into `data`
})

throw new TooManyRequestsException('Slow down', { headers: { 'retry-after': '60' } })

throw new HttpException('Payment required', { status: 402, cause: error })
```

### Business exceptions

`BusinessException` is for business-rule failures that clients should treat as a normal response with an error code. It responds with HTTP 200 by default:

```ts
import { BusinessException } from '@hazejs/core'

throw new BusinessException(10001, 'Insufficient balance')
// HTTP 200: { "code": 10001, "message": "Insufficient balance", "data": null }

throw new BusinessException(10002, 'Order closed', { status: 409 })
```

### Validation exceptions

`ValidationException` carries field-level issues, which are rendered as `errors`. Validation via `validate()` or `.validate()` throws it for you. You can also throw it yourself:

```ts
import { ValidationException } from '@hazejs/core'

throw new ValidationException([{ path: 'email', message: 'Already taken' }])
```

See [Requests & Validation](./requests#validation-errors) for the response format.

### Unexpected errors

Anything that is not an `HTTPError`, such as a `TypeError` or a database error, becomes a **500**. Outside debug mode, the message is replaced with `Internal Server Error` so internals don't leak.

## The exception handler

`app/exception/Handler.ts` customizes how errors are reported and rendered. Extend `ExceptionHandler`:

```ts
// app/exception/Handler.ts
import type { HttpContext } from '@hazejs/core'
import { BusinessException, ExceptionHandler } from '@hazejs/core'
import { PaymentGatewayError } from '~/app/service/payment'

export default class Handler extends ExceptionHandler {
  // Never report these
  protected override dontReport = [PaymentGatewayError]

  override async report(error: unknown, ctx: HttpContext) {
    await super.report(error, ctx) // logs with ctx.logger (includes requestId)
    // if (this.shouldReport(error)) Sentry.captureException(error)
  }

  override render(error: unknown, ctx: HttpContext) {
    if (error instanceof BusinessException)
      ctx.setHeader('x-business-code', String(error.code))
    return super.render(error, ctx)
  }
}
```

| Member | Description |
|--------|-------------|
| `report(error, ctx)` | Records the error. By default, logs `[METHOD] /path` and the error at `error` level |
| `shouldReport(error)` | `false` for `dontReport` types and any 4xx `HTTPError`. Client errors are not reported |
| `dontReport` | Exception classes that are never reported |
| `render(error, ctx)` | Sets status and headers, then returns the body: the debug page or `Formatter.error()` |
| `normalize(error, ctx)` (protected) | Turns any error into a `NormalizedError` |
| `format(error, ctx)` (protected) | Builds the body. Defaults to `ResponseFormatter.error()` |

`render()` delegates the body shape to the response formatter, so success and error responses share one format. To change the shape of every error, override `error()` in `app/response/Formatter.ts` (see [Responses](./responses)) rather than `render()`.

If `report()` itself throws, the failure is logged and the response is still rendered.

## Debug mode

`app.debug` is on in development and off in production and tests. Unless you have a reason to, don't enable it in production. When it is on:

- Error JSON includes a `stack` array, and the messages of unexpected errors are shown.
- Browser requests (`Accept: text/html`) get an error page with the exception, a source snippet mapped back to your TypeScript, the stack, validation issues and request details. Sensitive headers are masked. For a 404, the page lists all routes.

API clients always get JSON, and the error page is never rendered when debug is off.

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  // debug: env('APP_DEBUG', false), // force it on or off
}))
```

## Logging

Use `ctx.logger` inside a request. It is a child logger that already carries the request ID (and the app name with [multiple apps](./multi-app)):

```ts
// app/controller/OrderController.ts
import type { HttpContext } from '@hazejs/core'

export class OrderController {
  async store(ctx: HttpContext) {
    ctx.logger.info('Creating order', { userId: 1 })
    ctx.logger.debug('Payload', await ctx.body())
    return ctx.created({ id: 1 })
  }
}
```

Outside a request, inject the application logger or use `app.logger`:

```ts
// app/service/ReportService.ts
import { inject, Logger } from '@hazejs/core'

export class ReportService {
  private logger = inject(Logger).child({ service: 'report' })

  run() {
    this.logger.success('Report generated')
  }
}
```

Methods: `error`, `warn`, `info`, `success`, `debug`, `trace`, plus `child(context)` to add fields to every line.

### Configuration

Logger settings live in `config/logger.ts`:

```ts
// config/logger.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  level: env('LOG_LEVEL', 'info'),
  // format: 'json',
  // requests: false,
}))
```

| Option | Description | Default |
|--------|-------------|---------|
| `level` | `silent`, `error`, `warn`, `info`, `debug`, `trace` | `info` (`warn` in tests) |
| `format` | `pretty` (colored) or `json` (one JSON object per line) | `json` in production, otherwise `pretty` |
| `requests` | Access log line per request | on, except in tests |
| `tag` | Tag shown in output | `hazejs` |
| `write` | Custom sink for JSON lines, `(line, level) => void` | `error` to stderr, the rest to stdout |
| `channel` | Channel name(s) to write to, see [Channels](#channels) | `'console'` |
| `channels` | Channel definitions | `console` and `json` are built in |

In development the output is colored, with access lines such as `GET /api/hello 200 3ms`. In production, each line is JSON with `time`, `level`, `tag`, `msg`, `requestId`, any context fields, and `err` (name, message, stack) when an error is logged. This works well with log collectors. When [OpenTelemetry](./observability#opentelemetry) is enabled and a span is active, JSON lines also carry `trace_id` and `span_id`.

### Channels {#channels}

Like Laravel's logging channels, a log line can go to several destinations at once. Everything above describes the default `console` channel. Define more channels and pick them with `channel`:

```ts
// config/logger.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  level: env('LOG_LEVEL', 'info'),
  channel: 'production',
  channels: {
    production: { driver: 'stack', channels: ['console', 'file', 'loki'] },
    file: { driver: 'file', path: 'storage/logs/app.log', daily: true, maxFiles: 14 },
    loki: {
      driver: 'http',
      url: env('LOKI_URL', 'http://localhost:3100/loki/api/v1/push'),
      format: 'loki',
      labels: { app: 'shop' },
      level: 'warn',
    },
    audit: { driver: 'file', path: 'storage/logs/audit.log', daily: false },
  },
}))
```

| Driver | Writes | Options |
|--------|--------|---------|
| `console` | Console output, `pretty` or `json` according to `format` (the default channel) | `level` |
| `json` | One JSON object per line to stdout, whatever `format` says | `level`, `stream: 'stdout' \| 'stderr'` |
| `file` | JSON lines to a file (Node, Bun and Deno only) | `path` (default `storage/logs/haze.log`), `daily` (default `true`: `haze-2026-10-28.log`), `maxFiles` (default 14, `0` keeps everything), `level` |
| `http` | Batched `POST` to a log platform | `url`, `headers`, `format` (`json` array, `ndjson`, `loki`, or `(entries) => body`), `batchSize` (100), `interval` (2000 ms), `maxBuffer` (10000), `labels` (Loki), `level` |
| `custom` | Your own transport | `transport: { log(entry), flush?(), close?() }` or `(entry) => void`, `level` |
| `stack` | Several channels | `channels: ['console', 'file']` |

- Each channel can have its own `level`. The logger's `level` is the default for channels without one.
- Access logs (`requests: true`) go to every channel too.
- Write to specific channels for one call with `logger.channel('audit').info('Refund approved', { orderId })`. Context added with `child()` is kept.
- The `http` driver sends a batch as soon as `batchSize` entries are buffered, or after `interval` ms. If the buffer passes `maxBuffer` (for example while the platform is down), the oldest entries are dropped. Delivery errors are printed to stderr and never thrown. `await logger.flush()` sends what is buffered, and the application flushes and closes all channels when it shuts down.

Shipping to common platforms:

```ts
channels: {
  // Datadog: JSON array to the HTTP intake
  datadog: { driver: 'http', url: 'https://http-intake.logs.datadoghq.eu/api/v2/logs', headers: { 'DD-API-KEY': env('DD_API_KEY') } },
  // Better Stack
  betterstack: { driver: 'http', url: env('BETTERSTACK_INGEST_URL'), headers: { authorization: `Bearer ${env('BETTERSTACK_TOKEN')}` } },
  // Grafana Loki
  loki: { driver: 'http', url: 'http://loki:3100/loki/api/v1/push', format: 'loki' },
}
```

## Request IDs

Every request gets an ID, available as `ctx.requestId`, in every `ctx.logger` line and in the `x-request-id` response header.

- If the incoming request has an `x-request-id` header with safe characters (`[\w.:-]`, up to 128), that ID is reused, so traces can span services.
- Otherwise, a UUID is generated.

Change the header name with `requestIdHeader` in `config/app.ts`, or set it to `false` to neither read nor send the header. An ID is still generated for logs.
