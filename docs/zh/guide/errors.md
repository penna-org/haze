# 异常与日志

hazejs 集中处理所有异常：路由、中间件、控制器中抛出的任何错误，都会在请求边界被捕获，交给异常处理器上报，并以与成功响应相同的格式渲染。

## 抛出 HTTP 异常

需要中止处理并返回错误时，直接抛出异常：

```ts
// app/service/UserService.ts
import { ForbiddenException, inject, NotFoundException } from '@hazejs/core'
import { UserRepository } from '~/app/repository/UserRepository'

export class UserService {
  private repo = inject(UserRepository)

  async find(id: number) {
    const user = await this.repo.findById(id)
    if (!user)
      throw new NotFoundException(`用户 ${id} 不存在`)
    if (user.banned)
      throw new ForbiddenException('该账号已被停用')
    return user
  }
}
```

```json
{ "code": 404, "message": "用户 9 不存在", "data": null }
```

| 异常类 | 状态码 | 默认消息 |
|--------|--------|----------|
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
| `BusinessException` | 200 | （必填） |

它们都继承自 `HttpException`，而 `HttpException` 继承自 h3 的 `HTTPError`。第二个参数为选项：

```ts
import { ConflictException, HttpException, TooManyRequestsException } from '@hazejs/core'

throw new ConflictException('邮箱已被注册', {
  code: 40901, // 响应体中的业务码（默认等于 HTTP 状态码）
  data: { field: 'email' }, // 写入 data
})

throw new TooManyRequestsException('请求过于频繁', { headers: { 'retry-after': '60' } })

throw new HttpException('需要付费', { status: 402, cause: error })
```

### 业务异常

`BusinessException` 用于违反业务规则的情况：客户端应把它当作带错误码的正常响应处理，因此默认 HTTP 状态码为 200：

```ts
import { BusinessException } from '@hazejs/core'

throw new BusinessException(10001, '余额不足')
// HTTP 200：{ "code": 10001, "message": "余额不足", "data": null }

throw new BusinessException(10002, '订单已关闭', { status: 409 })
```

### 校验异常

`ValidationException` 携带字段级的错误列表，渲染为 `errors`。使用 `validate()` 或 `.validate()` 校验时会自动抛出，也可以手动抛出：

```ts
import { ValidationException } from '@hazejs/core'

throw new ValidationException([{ path: 'email', message: '邮箱已被注册' }])
```

响应格式见 [请求与校验](./requests#校验错误)。

### 未预期的错误

不是 `HTTPError` 的错误（如 `TypeError`、数据库错误）一律返回 **500**。非调试模式下，错误消息会被替换为 `Internal Server Error`，避免泄露内部信息。

## 异常处理器

在 `app/exception/Handler.ts` 中定制错误的上报与渲染，继承 `ExceptionHandler` 即可：

```ts
// app/exception/Handler.ts
import type { HttpContext } from '@hazejs/core'
import { BusinessException, ExceptionHandler } from '@hazejs/core'
import { PaymentGatewayError } from '~/app/service/payment'

export default class Handler extends ExceptionHandler {
  // 这些异常永不上报
  protected override dontReport = [PaymentGatewayError]

  override async report(error: unknown, ctx: HttpContext) {
    await super.report(error, ctx) // 通过 ctx.logger 记录（带 requestId）
    // if (this.shouldReport(error)) Sentry.captureException(error)
  }

  override render(error: unknown, ctx: HttpContext) {
    if (error instanceof BusinessException)
      ctx.setHeader('x-business-code', String(error.code))
    return super.render(error, ctx)
  }
}
```

| 成员 | 说明 |
|------|------|
| `report(error, ctx)` | 记录错误；默认以 `error` 级别输出 `[METHOD] /path` 和错误本身 |
| `shouldReport(error)` | `dontReport` 中的类型以及 4xx 的 `HTTPError` 返回 `false`，客户端错误不上报 |
| `dontReport` | 永不上报的异常类 |
| `render(error, ctx)` | 设置状态码和响应头，返回响应体：调试错误页或 `Formatter.error()` 的结果 |
| `normalize(error, ctx)`（protected） | 把任意错误转换为 `NormalizedError` |
| `format(error, ctx)`（protected） | 生成响应体，默认交给 `ResponseFormatter.error()` |

`render()` 把响应体的结构交给响应格式化器，所以成功与失败共用同一套格式。如果想调整所有错误响应的结构，应在 `app/response/Formatter.ts` 中覆盖 `error()`（见 [响应](./responses)），而不是覆盖 `render()`。

即使 `report()` 自身抛错，也只会记录一条日志，响应照常渲染。

## 调试模式

`app.debug` 在开发环境开启，在生产与测试环境关闭。如无特殊理由，不要在生产环境开启。开启后：

- 错误 JSON 中带有 `stack` 数组，未预期错误会显示真实消息；
- 浏览器请求（`Accept: text/html`）会看到错误页：异常信息、映射回 TypeScript 源码的代码片段、调用栈、校验错误和请求信息（敏感请求头已脱敏）；404 时还会列出全部路由。

API 客户端始终收到 JSON；关闭调试模式时永远不会渲染错误页。

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  // debug: env('APP_DEBUG', false), // 强制开启或关闭
}))
```

## 日志

请求内使用 `ctx.logger`。它是已经带上请求 ID 的子日志器（[多应用](./multi-app) 时还带有应用名）：

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

请求之外，注入应用日志器或使用 `app.logger`：

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

可用方法：`error`、`warn`、`info`、`success`、`debug`、`trace`；`child(context)` 返回在每行日志中附加字段的子日志器。

### 配置

日志配置放在 `config/logger.ts`：

```ts
// config/logger.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  level: env('LOG_LEVEL', 'info'),
  // format: 'json',
  // requests: false,
}))
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `level` | `silent`、`error`、`warn`、`info`、`debug`、`trace` | `info`（测试时为 `warn`） |
| `format` | `pretty`（彩色）或 `json`（每行一个 JSON） | 生产环境 `json`，其余 `pretty` |
| `requests` | 为每个请求记录访问日志 | 开启（测试时关闭） |
| `tag` | 输出中显示的标签 | `hazejs` |
| `write` | 自定义 JSON 行的输出目标 `(line, level) => void` | `error` 写 stderr，其余写 stdout |

开发环境为彩色输出，访问日志形如 `GET /api/hello 200 3ms`。生产环境每行是一个 JSON，包含 `time`、`level`、`tag`、`msg`、`requestId`、上下文字段，记录错误时还有 `err`（name、message、stack），方便日志平台采集。

## 请求 ID

每个请求都有一个 ID：可以通过 `ctx.requestId` 读取，会出现在每一行 `ctx.logger` 日志中，并写入响应头 `x-request-id`。

- 如果请求带有 `x-request-id` 头且只包含安全字符（`[\w.:-]`，最长 128），就沿用这个 ID，便于跨服务追踪；
- 否则自动生成一个 UUID。

可以通过 `config/app.ts` 的 `requestIdHeader` 修改请求头名称；设为 `false` 则既不读取也不回写该请求头，但仍会为日志生成 ID。
