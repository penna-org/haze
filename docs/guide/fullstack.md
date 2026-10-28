# Full-stack with Vite

The `haze()` Vite plugin turns any Vite project — Vue, React, Svelte, Solid or plain — into a full-stack app: one repository, one port in development, and one build for production. The `vue` and `react` templates are set up this way; this page explains how it works and how to add it to an existing project.

## Setup

Add `haze()` next to your framework plugin:

```ts
// vite.config.ts
import { haze } from '@hazejs/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vue(),
    haze(),
  ],
})
```

Put the backend in its own directory and point `srcDir` at it:

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  srcDir: 'server',
  // production port; in dev the app uses Vite's port
  port: 3000,
})
```

The backend then has the usual layout under `server/` (`server/app`, `server/config`, `server/route`, …) — see [Directory Structure](./directory-structure). You need `@hazejs/core` as a dependency and `@hazejs/vite` and `@hazejs/cli` as dev dependencies.

## Plugin options {#plugin-options}

| Option | Default | Description |
| --- | --- | --- |
| `prefix` | `'/api'` | Path prefix (or array of prefixes) handled by the backend |
| `srcDir` | from `haze.config.ts`, else `.` | Backend source directory, relative to the Vite root or absolute |
| `alias` | `'~'` | Import alias pointing to `srcDir`; `false` disables it |
| `port`, `host` | from `haze.config.ts` | Default listen address of the production entry (`PORT` / `HOST` win at runtime) |
| `preset` | `HAZE_PRESET`, then `haze.config.ts`, else `node` | Deployment preset |
| `outDir` | from `haze.config.ts`, else `dist` | Build output directory |
| `typegen` | from `haze.config.ts`, else `true` | Generate types while the dev server runs |
| `cloudflare`, `vercel`, `externals` | from `haze.config.ts` | Same as the [`haze.config.ts` options](./configuration#haze-config-ts) |

::: tip
Keep options in `haze.config.ts` so the CLI and the plugin agree. If you pass `srcDir` to `haze()` directly, `haze.config.ts` is not read at all.
:::

## Development

```sh
pnpm dev   # runs haze dev, which starts Vite with your vite.config.ts
```

You can also run `vite` directly. Either way there is a single server, on Vite's port (`5173` by default):

- Requests whose path matches the prefix (`/api`, `/api/…`, `/api?…`) go to the backend. The plugin registers its middleware before Vite's own, so API requests never hit the static file handler or the SPA fallback.
- Everything else is served by Vite as usual.

There is no proxy to configure and no CORS: the page and the API share an origin.

::: warning Routes include the prefix
The prefix is not stripped. Routes must be defined with it, as the templates do with `r.group({ prefix: '/api' }, …)`. A route at `/health` outside the prefix would never be reached in dev.
:::

Need more than one prefix? Pass an array: `haze({ prefix: ['/api', '/webhooks'] })`.

### Hot reload on both sides

- **Frontend** changes use Vite's HMR as usual.
- **Backend** changes (anything under `srcDir`, plus `.env` files) rebuild the application and swap it in place. The Vite server keeps running, and the frontend is not reloaded.

When a backend request fails in the browser — for example opening `/api/users/oops` directly — you see the dev error page with source locations; `fetch` calls still receive JSON.

### Environment variables

Both sides read the same `.env`. Variables prefixed with `VITE_` are exposed to the frontend through `import.meta.env`; the rest are only visible to the backend through `env()`:

```sh
# .env
APP_NAME=my-app
DATABASE_URL=file:./data/app.db
VITE_APP_TITLE=my-app
```

## Calling the API from the frontend

Because the API is same-origin, plain `fetch('/api/…')` works in dev and in production. The templates wrap it in `src/api.ts`, which unwraps the response envelope and handles CSRF. A slightly simplified version:

```ts
// src/api.ts
function readCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match
    ? decodeURIComponent(match[1])
    : undefined
}

/** Unsafe methods send the XSRF-TOKEN cookie back as a header (fetching it once if missing) */
async function csrfHeader(method: string): Promise<Record<string, string>> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method))
    return {}
  if (!readCookie('XSRF-TOKEN'))
    await fetch('/api/csrf-cookie')
  const token = readCookie('XSRF-TOKEN')
  return token
    ? { 'x-xsrf-token': token }
    : {}
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...await csrfHeader((init.method ?? 'GET').toUpperCase()),
      ...init.headers,
    },
  })
  const body = await res.json()
  if (body.code !== 0)
    throw new Error(body.errors?.[0]?.message ?? body.message)
  return body.data as T
}
```

The backend side of this flow, in the full-stack templates:

```ts
// server/config/middleware.ts
import { defineMiddlewareConfig } from '@hazejs/core'

export default defineMiddlewareConfig({
  global: ['secureHeaders', 'compress', 'csrf'],
  alias: {},
})
```

```ts
// server/route/api.ts — inside the /api group
r.get('/csrf-cookie', ctx => ctx.noContent())
```

1. The global `csrf` middleware keeps a token in the session and sends it to the browser as the `XSRF-TOKEN` cookie (readable by scripts, not `HttpOnly`).
2. `GET /api/csrf-cookie` is an empty route that just lets the frontend obtain the cookie before its first write.
3. `POST`, `PUT`, `PATCH` and `DELETE` requests must echo the token in `X-XSRF-TOKEN` (or `X-CSRF-TOKEN`, or a `_token` form field). Otherwise the response is `419`.
4. Requests with `Authorization: Bearer …` are not checked, and neither are requests in the `test` mode.

Usage from a component:

```ts
const data = await api<{ message: string }>('/api/hello', {
  method: 'POST',
  body: JSON.stringify({ name: 'Ada' }),
})
```

See [Sessions, CSRF & More](./security) for the `csrf` options.

## WebSocket and Socket.IO

Realtime connections share the same port too.

- **WebSocket** routes under the prefix — `r.ws('/api/ws', { … })` — receive upgrade requests from the Vite server. Vite's own HMR socket uses the `vite-hmr` protocol and is left alone. Connect from the page with `` new WebSocket(`ws://${location.host}/api/ws`) ``. See [WebSocket](./websocket).
- **Socket.IO** (`@hazejs/socket.io`) attaches to Vite's HTTP server at `/socket.io/`, so the client connects same-origin without any prefix:

```ts
// src/socket.ts
import type { Socket } from 'socket.io-client'
import { io } from 'socket.io-client'

export const chat: Socket = io('/chat', { autoConnect: false })
```

See [Socket.IO](./socket-io).

## Building

```sh
pnpm build   # haze build — or run vite build directly
```

One build produces both sides. The server is built first, then the client:

```
dist/
├─ client/          Frontend assets (index.html, assets/…)
└─ server/
   ├─ index.mjs     Production entry
   ├─ migrate.mjs   Production migrations (when using @hazejs/orm)
   ├─ worker.mjs    Queue worker and scheduler
   └─ node_modules/ Traced drivers and native packages
```

This is the layout for the default `node` preset; others are described in [Deployment](./deployment). Choose a preset with `haze build --preset vercel`, the `preset` option in `haze.config.ts`, or the `HAZE_PRESET` environment variable when running `vite build`. The build also records its preset and layout in `.haze/build.json` for previews.

## Running in production

```sh
pnpm start   # haze start, or: node dist/server/index.mjs
```

A single process serves the API and the frontend:

- requests under the prefix go to the application;
- other `GET` / `HEAD` requests are served from `dist/client`; files under `/assets/` get a long-lived immutable `Cache-Control`;
- unmatched requests that accept HTML fall back to `index.html` (no-cache), so client-side routing in history mode works. API paths never fall back.

On `vercel`, `netlify` and `cloudflare` the frontend is served by the platform's CDN and only the prefix reaches your function.

## Preview

```sh
pnpm preview   # haze preview — the same as vite preview
```

Previewing runs the **real build output** for its preset (default port `4173`), not your source: a child process for `node` / `bun` / `deno` / `docker`, the function handler for serverless presets, Miniflare for Cloudflare. WebSocket connections are forwarded for process-based presets.

## TypeScript

The templates use two projects referenced from `tsconfig.json`:

- `tsconfig.app.json` — the frontend (`src/**`), with the `@/*` alias and `vite/client` types.
- `tsconfig.server.json` — the backend (`server/**`, `tests/**`, `*.config.ts` and `.haze/types/**/*.d.ts`), with `~/*` mapped to `./server/*` and the types `node`, `vite/client` and `@hazejs/vite/client`.

`@hazejs/vite/client` declares the plugin's virtual modules (`virtual:haze/app`, `virtual:haze/migrations`) for code that imports them. Run `pnpm typecheck` (`vue-tsc --build` or `tsc --build`) to check both projects.

## Testing

Backend tests live in `tests/` at the project root and run with `haze test`. The test config adds the plugin in standalone mode, so tests boot the backend without starting the frontend:

```ts
// vitest.config.ts
import { defineHazeTestConfig } from '@hazejs/testing/config'
import { defineConfig } from 'vitest/config'

export default defineConfig(defineHazeTestConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
}))
```

See [Testing](./testing).
