# Configuration

hazejs has two kinds of configuration:

- **Application config** in `config/*.ts` — read at runtime with `config('app.name')`. It covers the framework modules (auth, cache, queue, …) and anything your app needs.
- **Toolchain config** in `haze.config.ts` — read by the CLI and the Vite plugin: where the source lives, the dev port, the deployment preset.

## Config files

Every file in `config/` is loaded automatically, and its **file name is the config key**:

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
}))
```

```ts
config('app.name') // 'my-app'
```

Each file is deep-merged over the framework defaults, so you only write what you change. To add your own config, create a file — or generate one:

```sh
npx haze make:config payment   # config/payment.ts → config('payment.enabled')
```

### Helpers

`defineConfig()` works for any file. The framework modules also export typed helpers that give you autocompletion for their options:

| File | Helper | Package |
| --- | --- | --- |
| `config/app.ts`, `config/logger.ts`, your own files | `defineConfig` | `@hazejs/core` |
| `config/auth.ts` | `defineAuthConfig` | `@hazejs/core` |
| `config/broadcasting.ts` | `defineBroadcastingConfig` | `@hazejs/core` |
| `config/cache.ts` | `defineCacheConfig` | `@hazejs/core` |
| `config/compress.ts` | `defineCompressConfig` | `@hazejs/core` |
| `config/cors.ts` | `defineCorsConfig` | `@hazejs/core` |
| `config/csrf.ts` | `defineCsrfConfig` | `@hazejs/core` |
| `config/filesystem.ts` | `defineFilesystemConfig` | `@hazejs/core` |
| `config/health.ts` | `defineHealthConfig` | `@hazejs/core` |
| `config/i18n.ts` | `defineI18nConfig` | `@hazejs/core` |
| `config/mail.ts` | `defineMailConfig` | `@hazejs/core` |
| `config/middleware.ts` | `defineMiddlewareConfig` | `@hazejs/core` |
| `config/notification.ts` | `defineNotificationConfig` | `@hazejs/core` |
| `config/observability.ts` | `defineObservabilityConfig` | `@hazejs/core` |
| `config/openapi.ts` | `defineOpenAPIConfig` | `@hazejs/core` |
| `config/queue.ts` | `defineQueueConfig` | `@hazejs/core` |
| `config/redis.ts` | `defineRedisConfig` | `@hazejs/core` |
| `config/schedule.ts` | `defineScheduleConfig` | `@hazejs/core` |
| `config/secureHeaders.ts` | `defineSecureHeadersConfig` | `@hazejs/core` |
| `config/session.ts` | `defineSessionConfig` | `@hazejs/core` |
| `config/tenancy.ts` | `defineTenancyConfig` | `@hazejs/core` |
| `config/throttle.ts` | `defineThrottleConfig` | `@hazejs/core` |
| `config/websocket.ts` | `defineWebSocketConfig` | `@hazejs/core` |
| `config/database.ts` | `defineDatabaseConfig` | `@hazejs/orm` |
| `config/ai.ts` | `defineAIConfig` | `@hazejs/ai` |
| `config/graphql.ts` | `defineGraphQLConfig` | `@hazejs/graphql` |
| `config/microservices.ts` | `defineMicroservicesConfig` | `@hazejs/microservices` |
| `config/oauth.ts` | `defineOAuthConfig` | `@hazejs/oauth` |
| `config/search.ts` | `defineSearchConfig` | `@hazejs/search` |
| `config/socketio.ts` | `defineSocketIOConfig` | `@hazejs/socket.io` |

The options of each file are documented on the page of its module: [Broadcasting](./broadcasting), [Redis](./redis), [Observability](./observability) (`health`, `observability`), [Localization](./localization), [Notifications](./notifications), [OpenAPI](./openapi), [Multi-tenancy](./tenancy), [AI](./ai), [GraphQL](./graphql), [Microservices](./microservices), [OAuth Social Login](./oauth), [Search](./search) and so on. Most of these files are optional: OpenAPI docs and health checks work without them, and `config/i18n.ts` turns on translated validation and framework messages.

### Object form vs function form

Every helper accepts either an object or a function returning one. **Use the function form whenever you read environment variables**:

```ts
// config/queue.ts
import { defineQueueConfig, env } from '@hazejs/core'

export default defineQueueConfig(() => ({
  default: env('QUEUE_CONNECTION', 'memory'),
  connections: {
    memory: { driver: 'memory', concurrency: 2 },
    redis: { driver: 'redis', connection: 'default' },
  },
}))
```

Config modules are imported before the application boots. The function is called during boot, after `.env` has been loaded — an object literal would be evaluated too early and miss values from `.env`.

## Environment variables

### `env()`

`env(key, default)` reads `process.env` and converts the value to the type of the default:

```ts
env('APP_NAME', 'my-app')   // string
env('PORT', 3000)           // number — falls back to 3000 if the value is not a number
env('DB_LOGGING', false)    // boolean
env('APP_URL')              // string | undefined
```

Booleans accept `true`, `1`, `yes`, `on` and `false`, `0`, `no`, `off` or an empty string (case-insensitive). Any other value falls back to the default.

### `.env` files

Files are loaded from the project root (in production: the working directory of the process — `haze start` switches to the project root) in this order, later files overriding earlier ones:

1. `.env`
2. `.env.local` — skipped in the `test` mode so tests are reproducible
3. `.env.[mode]` — `.env.development`, `.env.production` or `.env.test`
4. `.env.[mode].local`

The mode comes from `NODE_ENV`: `production` and `test` are used as-is, anything else is `development`. `haze test` runs in `test` mode, so the templates' `.env.test` (`DATABASE_URL=:memory:`) points tests at an in-memory database.

Real environment variables always win over `.env` files. The templates ignore `.env.local` and `.env.*.local` in git — use them for machine-specific secrets.

::: tip
In dev, editing a `.env` file or anything in `config/` reloads the application in place, like any other source file.
:::

## Reading config

```ts
import { config } from '@hazejs/core'

config('app.name')               // typed value
config('payment.retries', 3)     // with a default
```

Inside a request, the context carries the config too, and classes can inject it:

```ts
// app/controller/GreetingController.ts
import type { HttpContext } from '@hazejs/core'
import { Config, inject } from '@hazejs/core'

export class GreetingController {
  private config = inject(Config)

  index(ctx: HttpContext) {
    return {
      app: this.config.get('app.name'),
      debug: ctx.config.get('app.debug'),
    }
  }
}
```

`Config` also has `has(key)`, `set(key, value)` and `all()`. With [multiple apps](./multi-app), `config()` and `ctx.config` inside a request return the app's config: `app/<name>/config/*.ts` deep-merged over the global files.

### Typed config keys

The dev server (and `haze typegen`) writes `.haze/types/haze.d.ts`, which infers the type of every file in `config/`. Keys autocomplete, values are typed, and typos fail type checking:

```ts
config('app.name')   // string
config('app.nmae')   // type error
```

Once types are generated, `config()` only accepts known keys; reading an unknown key requires a default value. Make sure `.haze/types/**/*.d.ts` is in your `tsconfig.json` `include` (the templates already do this).

## `config/app.ts`

| Option | Default | Description |
| --- | --- | --- |
| `name` | `'hazejs'` | Application name |
| `debug` | `true` in development | Error responses include stack traces; the dev error page is shown |
| `url` | — | Public URL of the app, used for absolute links such as signed temporary storage URLs |
| `key` | `APP_KEY` | Application key; see below |
| `previousKeys` | `APP_PREVIOUS_KEYS` | Keys used before the last rotation; see below |
| `bodyLimit` | `'1mb'` | Request body limit; override per route with the `bodyLimit:10mb` middleware |
| `trustProxy` | `false` | Read the client IP and protocol from `X-Forwarded-For` / `X-Forwarded-Proto` |
| `cookie` | — | Default cookie options (httpOnly, `SameSite=Lax` and `Secure` outside debug by default) |
| `requestIdHeader` | `'x-request-id'` | Header used to read and echo the request ID; `false` disables it |
| `response` | `{ envelope: true, successCode: 0, successMessage: 'ok' }` | The success envelope |
| `apps` | — | [Multiple apps](./multi-app) by prefix or domain |

`app.mode` is read-only and reflects the current mode. Logging is configured in `config/logger.ts` with `level` (`'silent'` to `'trace'`), `format` (`'pretty'` or `'json'`, JSON by default in production) and `requests` (access logs).

### `APP_KEY`

`APP_KEY` signs cookies, encrypts sessions and is the default JWT secret. It must be at least 32 characters. `create-hazejs` writes one into `.env`; generate a new one with:

```sh
npx haze key:generate           # writes APP_KEY to .env (refuses to overwrite)
npx haze key:generate --force   # replace it — existing cookies, sessions and tokens become invalid
npx haze key:generate --show    # print a key without writing it
```

Set `APP_KEY` as a real environment variable in production. Setting `key` in `config/app.ts` overrides it.

When you rotate the key, list the old ones in `APP_PREVIOUS_KEYS` (comma-separated) or `previousKeys` in `config/app.ts`. They are only used to read existing data: `Crypt` payloads are decrypted and [signed URLs](./routing#signed-urls) are verified with the current key first, then each previous key, while everything new is encrypted and signed with `APP_KEY`. Signed cookies, sessions, JWTs and temporary storage URLs only use the current key, so they still become invalid. See [Key rotation](./security#key-rotation).

### `APP_URL`

`app.url` — the public address used for absolute links such as `Storage.temporaryUrl()` on local disks — defaults to the `APP_URL` environment variable:

```sh
# .env.production
APP_URL=https://example.com
```

Set `url` in `config/app.ts` to override it (an empty `APP_URL` counts as unset). Without either, those links are site-relative paths.

## `haze.config.ts` {#haze-config-ts}

Toolchain options live in `haze.config.ts` at the project root. All of them are optional:

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  srcDir: 'server',
  port: 3000,
  preset: 'node',
})
```

| Option | Default | Description |
| --- | --- | --- |
| `srcDir` | `'.'` | Backend source directory, relative to the project root. Full-stack templates use `'server'` |
| `port` | `3000` | Dev server port for backend-only projects, and the default port of the production entry. `PORT` takes precedence |
| `host` | `localhost` in dev, `0.0.0.0` in production | Listen address. `HOST` takes precedence in production |
| `outDir` | `'dist'` | Build output directory |
| `typegen` | `true` | Generate `.haze/types` automatically while `haze dev` runs |
| `preset` | `'node'` | Deployment preset: `node`, `bun`, `deno`, `docker`, `cloudflare`, `vercel`, `netlify`, `aws-lambda`. `haze build --preset` overrides it |
| `cloudflare` | — | `wrangler` (merged into the generated `wrangler.json`: bindings, vars, routes…) and `websocket` (generate the WebSocket Durable Object; on by default when a route uses `r.ws()`) |
| `vercel` | — | `cron`: the Vercel Cron expression that triggers scheduled tasks (every minute by default) |
| `externals` | — | Dependency handling: `trace` (copy external dependencies into the output, default `true`), `traceDeps` (extra packages to keep external and trace; `pkg*` copies the whole package), `inline` (force-bundle packages) |
| `vite` | — | Extra Vite config (plugins, aliases…) for backend-only projects. Full-stack projects use `vite.config.ts` instead |

In full-stack projects the dev server runs on Vite's port, so `port` only sets the production default. See [Full-stack with Vite](./fullstack) and [Deployment](./deployment) for the preset-specific options.
