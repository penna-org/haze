# Express, Koa, Hono and NestJS → hazejs

The kernel-swap strategy from the main skill applies to every source framework: keep the project's own abstractions, replace what is underneath, prove it with the existing tests. This page lists what maps to what. Verify each hazejs API in the `hazejs` skill before using it.

## Express / Koa

| Express / Koa | hazejs |
| --- | --- |
| `app.get('/users/:id', handler)` | `r.get('/users/:id', [UserController, 'show'])` in `route/*.ts`, or a closure `ctx => …` |
| `express.Router()` / `app.use('/api', router)` | `r.group({ prefix: '/api', middleware: [...] }, r => { … })` |
| `(req, res, next)` middleware | `(ctx, next) => …` (onion: `await next()` returns the result; return a value to short-circuit; throw to fail) |
| `req.params` / `req.query` / `req.body` | `ctx.params()` (URL-decoded) / `ctx.query()` / `await ctx.body()` — or `.validate()` + `ctx.validated` |
| `req.get(name)`, `req.cookies` | `ctx.header(name)`, `ctx.cookie(name)` / `ctx.signedCookie(name)` |
| `req.ip`, `req.protocol`, `req.hostname` with `trust proxy` | `ctx.ip`, `ctx.secure`, `ctx.origin` with `app.trustProxy` |
| `res.status(201).json(data)` | `ctx.status(201); return data` or `return ctx.created(data)` |
| `res.set(header)` / `res.cookie()` | `ctx.setHeader()` / `ctx.setCookie()` |
| `res.sendFile`, `stream.pipe(res)` | `return new Response(Readable.toWeb(stream), { headers })` |
| `res.redirect(url)` | `return ctx.redirect(url)` |
| error middleware `(err, req, res, next)` | `ExceptionHandler` subclass (`report()` / `render()`) |
| `helmet`, `cors`, `express-rate-limit`, `compression` | built-in `secureHeaders`, `cors`, `throttle`, `compress` middleware |
| `multer` | `await ctx.file('avatar')` → `UploadedFile` (or read `ctx.req.body` as a stream for large files) |
| `express.static` + history fallback | `createApplication({ static: { dir, spaFallback: true, exclude: ['/api'], precompressed: true } })` |
| `express-session` / `passport` | `session` middleware, `config/auth.ts` guards, `@hazejs/oauth` |
| `http.createServer(app).listen()` + socket.io on the server | `app.serve()`; `@hazejs/socket.io`, or `registerServerExtension` for an existing socket.io setup |
| `supertest(app)` | `@hazejs/testing` (`useTestApp()`), or a thin wrapper over `app.fetch(new Request(...))` |

Koa's `ctx.body = value` becomes `return value`; `ctx.throw(404)` becomes `throw new NotFoundException()`; `koa-compose` ordering matches hazejs's onion model.

Express middleware cannot be mounted as-is (hazejs is built on Web `Request`/`Response`, not Node's `req`/`res`); port each one to `(ctx, next)`.

## Hono

Hono is also Web-standard, so ports are mostly mechanical:

| Hono | hazejs |
| --- | --- |
| `c.req.param()` / `c.req.query()` / `await c.req.json()` | `ctx.params()` / `ctx.query()` / `await ctx.body()` |
| `c.json(data, status)` | `ctx.status(status); return data` (set `app.response.envelope: false` to keep bare JSON) |
| `zValidator('json', schema)` | `.validate({ body: schema })` |
| `app.route('/api', sub)` | `r.group({ prefix: '/api' }, …)` or a module (`defineModule`) |
| `c.env` bindings on Workers | `usePlatformBinding(name)` with the `cloudflare` preset |
| RPC client (`hc`) | OpenAPI + typed client from `haze typegen` |

## NestJS

| NestJS | hazejs |
| --- | --- |
| `@Module({ providers, controllers, imports })` | plain files + the container; reusable feature folders as `defineModule` (routes, config, providers, migrations, jobs…) |
| `@Injectable()` + constructor injection | classes with `private users = inject(UserService)` (no decorators, no `emitDecoratorMetadata`) |
| `@Controller('users')` + `@Get(':id')` | routes in `route/*.ts` pointing at `[UserController, 'show']` |
| scopes `DEFAULT` / `REQUEST` / `TRANSIENT` | `static scope = Scope.Singleton / Scope.Request / Scope.Transient` (controllers default to request scope) |
| `ValidationPipe` + class-validator DTOs | Standard Schema (Zod / Valibot / ArkType) in `.validate()` |
| Guards (`CanActivate`) | middleware: `auth`, `can:<ability>`, custom `(ctx, next)` |
| Interceptors | `app.intercept()` (outbound Response) or `ctx.onResponse()`; inbound logic as middleware |
| Exception filters | `ExceptionHandler` subclass |
| `@nestjs/config` | `config/*.ts` + `env()` + typed keys from `haze typegen` |
| `@nestjs/typeorm` / Prisma | `@hazejs/orm` (drizzle based) or keep your ORM behind a service |
| `@nestjs/schedule`, `@nestjs/bull`, `EventEmitter2` | `schedule/*.ts`, `app/job/*.ts` (`defineJob`), `defineEvent` / `defineListener` |
| `@nestjs/websockets` gateways | `r.ws()`, broadcasting channels, or `@hazejs/socket.io` namespaces |
| `@nestjs/swagger` decorators | `.doc({ summary, tags, response })` + generated OpenAPI |
| `Test.createTestingModule().overrideProvider()` | `useTestApp({ override: c => c.instance(Service, fake) })` |

When a NestJS codebase is large, keep its DI style during the kernel swap with a small bridge (map provider tokens to `createToken(...)` on `app.container`) and convert classes to `inject()` module by module afterwards.
