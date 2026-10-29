# Maintenance Mode

While the application is "down", every request gets a 503 response instead of reaching your routes: API clients receive the normal error envelope, browsers a clean maintenance page. Health checks keep answering, so load balancers don't pull the instances, and you can let yourself in with a secret.

```sh
npx haze down --secret=let-me-in --retry=60
npx haze up
```

In production, without the CLI:

```sh
node dist/worker.mjs down --secret=let-me-in
node dist/worker.mjs up
node dist/worker.mjs maintenance:status
```

Running servers, queue workers and the scheduler pick the change up within two seconds. Nothing restarts — that includes `haze dev`.

## Where the state lives

`haze down` writes a small JSON state (time, status, Retry-After, the hashed secret, …) and every process reads it. By default it goes to the default [cache store](./cache), so all instances that share the store see the same state:

```ts
// config/maintenance.ts
import { defineMaintenanceConfig } from '@hazejs/core'

export default defineMaintenanceConfig({
  driver: 'cache', // 'cache' (default) or 'file'
  store: 'redis', // a cache store from config/cache.ts; defaults to the default store
  // file: 'storage/framework/down', // for driver: 'file', relative to the project root
})
```

| Option | Default | Description |
| --- | --- | --- |
| `driver` | `'cache'` | `'cache'` or `'file'` |
| `store` | Default cache store | Cache store for the `cache` driver |
| `key` | `'framework:down'` | Cache key (the cache prefix is added) |
| `file` | `'storage/framework/down'` | State file for the `file` driver |
| `interval` | `2000` | How long each process caches the state, in milliseconds. `haze up` reaches every process within this time |
| `except` | `[]` | Paths that always pass, merged with `--except` |
| `pauseWorkers` | `true` | Pause queue workers and skip scheduled tasks while down |
| `workerSleep` | `3000` | How often paused workers check the state, in milliseconds |
| `cookie` | `'haze_maintenance'` | Name of the bypass cookie |
| `bypassTtl` | `43200` | Lifetime of the bypass cookie, in seconds (12 hours) |

::: warning In-process memory store
The `memory` cache store (the template default) lives inside one process, so a `haze down` run in another process could never reach the server. When the store is `memory`, the state is kept in `storage/framework/down` instead (except in tests, where memory keeps each test isolated), and `haze down` says so. For several machines, use a shared store such as `redis`; `file` only affects the machine it is written on.
:::

## Options

| Option | Description |
| --- | --- |
| `--secret=<s>` | Bypass secret: visiting `/<s>` sets a cookie and redirects to `/`; that browser can then use the app normally. Letters, digits, `-` and `_` |
| `--with-secret` | Generate a random secret and print it |
| `--retry=60` | `Retry-After` header, in seconds (default 60) |
| `--refresh=15` | `Refresh` header: browsers reload the page after this many seconds |
| `--status=503` | Status code (default 503) |
| `--redirect=/maintenance` | Redirect browser requests to this path (it shows the maintenance page itself; add it to `--except` to serve your own route) |
| `--render=Maintenance` | Render `app/view/Maintenance.tsx` instead of the built-in page |
| `--except=/api/webhooks/*,/status` | Paths that pass through, comma-separated, `*` matches anything |
| `--message="Back at 10:00"` | Message for the page and the JSON response; may be a translation key |

`haze maintenance:status` prints the current state. Every command accepts `--root`.

## Responses

- **JSON** — requests that don't accept `text/html`, and every path under `/api`, get the error envelope with the real status code:

  ```json
  { "code": 503, "message": "The application is down for maintenance. Please check back soon.", "data": null }
  ```

  With [`config/i18n.ts`](./localization), the message is translated with the `http.maintenance` key (zh-CN: `系统正在维护，请稍后再访问。`). Override it in `lang/<locale>/http.ts`.

- **HTML** — browsers get a self-contained page (no external assets, dark mode aware), your `--render` view, or a redirect.

Every response carries `Retry-After`, `Refresh` when set, and `Cache-Control: no-store`.

### A custom page

The view receives `{ status, title, message, lang, retry, refresh, state }`:

```tsx
// app/view/Maintenance.tsx — haze down --render=Maintenance
export default function Maintenance(props: { title: string, message: string, retry?: number }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{props.title}</title>
      </head>
      <body>
        <h1>We'll be right back</h1>
        <p>{props.message}</p>
      </body>
    </html>
  )
}
```

If the view is missing or fails to render, the built-in page is used and a warning is logged. See [Views](./views).

## What still passes

- Paths in `except` (config and `--except`).
- The [health checks](./observability#health-checks) (`/health`, `/health/ready`, `/health/live`).
- The development dashboard `/__haze` in dev.
- Requests with a valid bypass cookie. The cookie is signed with `APP_KEY`, expires after `bypassTtl`, and only works for the maintenance window it was issued for: a new `haze down --secret` invalidates it.

The secret itself is stored as a SHA-256 hash. The middleware runs right after the request scope, before static files, OpenAPI docs, health checks and your global middleware, so authentication or CSRF never runs while the app is down.

In full-stack dev, only `/api/**` reaches the backend; the frontend is served by Vite and is not affected. In production, the backend also serves the frontend files, so they are blocked too — add `/assets/*` to `except` if your custom page needs them.

## Queue workers and the scheduler

With `pauseWorkers: true` (the default), queue workers finish the job they are running, then wait between jobs until the application is up again, checking every `workerSleep` milliseconds. Due scheduled tasks are skipped with the reason `maintenance`. This applies to `haze queue:work`, `haze schedule:*`, `worker.mjs queue` / `schedule` and the in-process memory queue.

## In code

```ts
import { Maintenance } from '@hazejs/core'

const { secret } = await Maintenance.down({ withSecret: true, retry: 120 })
await Maintenance.isDown()
await Maintenance.up()
```

`MaintenanceModeEnabled` and `MaintenanceModeDisabled` are [events](./events) emitted in the process that runs `down()` / `up()`:

```ts
// app/listener/NotifyOps.ts
import { defineListener, MaintenanceModeEnabled } from '@hazejs/core'

export default defineListener(MaintenanceModeEnabled, ({ state }) => {
  console.log(`down since ${new Date(state.time).toISOString()}`)
})
```

## Serverless and edge

Platforms without a writable project directory or a long-running process (Cloudflare Workers, Vercel, Netlify, Lambda) need the `cache` driver with a shared store — KV on Workers, Upstash or Redis elsewhere. There is no `worker.mjs` there: set the state through the store. Either run `haze down` from a machine that is configured with the same store (for example the Upstash credentials in `.env`), or write the key directly:

```sh
# Cloudflare KV: <cache prefix>framework:down
wrangler kv key put --binding CACHE "haze:framework:down" '{"time":0,"status":503,"retry":60}'
wrangler kv key delete --binding CACHE "haze:framework:down"
```

KV is eventually consistent, so it can take up to a minute to reach every location.

See also [Deployment](./deployment#maintenance-mode).
