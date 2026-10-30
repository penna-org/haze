# DevTools

`@hazejs/devtools` adds a DevTools hub to the dev server. It is built on [devframe](https://devfra.me) and is **experimental**: the panels and options may change between minor versions.

The hub has these panels:

- **Overview**: the app name, mode, debug flag, directories, Node.js version and route count; the result of the last (re)load; enabled modules with their prefix, app, connection and route count; sub-apps from `config/app.ts`.
- **Routes**: every route with its method, path, name, handler, middleware, module and app. Type to filter; every word must match some column.
- **Dashboard**: the [dev dashboard](./observability#dev-dashboard) at `/__haze`, embedded. It is hidden when the dashboard is turned off.
- **Terminals**: shells in the browser, plus one-click `haze route:list`, `haze module:list`, `haze schedule:list` and `haze queue:work`.

## Installation

```bash
pnpm add -D @hazejs/devtools
```

That's all. `haze dev` finds the package and prints its URL:

```
  ➜  Local:    http://localhost:3000/
  ➜  Routes:   12
  ➜  DevTools: http://localhost:3000/__devtools/
```

In full-stack projects the `haze()` Vite plugin mounts the hub on the Vite server and also injects a floating dock into your frontend pages. Press the hazejs button in the dock to open the panels over your app.

The hub runs in the dev server process, not inside your app. When you edit a file, the app reloads and the panels update in place: the browser stays connected and keeps its state. If a reload fails, the Overview panel shows the error and a notification appears; both clear once the app loads again.

Production builds never include DevTools: only the dev server loads it, and `haze build` output has no reference to it.

## Authorization

The panels can read your project and run commands in a terminal, so the hub only accepts browsers you authorize. The first time a browser connects, the terminal prints a one-time code and a link:

```
╭ hazejs DevTools ─────────────────────────────────────────╮
│ auth code   283377                                       │
│ or open     http://localhost:3000/__devtools/#devframe_otp=283377 │
╰──────────────────────────────────────────────────────────╯
```

Enter the code on the DevTools page, or open the link. The browser then stays authorized for this project, including after the dev server restarts. In full-stack projects, authorize once on `/__devtools/` and the floating dock on the same origin is authorized too.

## Configuration

Set `devtools` in `haze.config.ts`. In full-stack projects you can also pass it to `haze()`; the plugin option takes precedence.

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  devtools: {
    base: '/__devtools/', // mount path
    auth: true, // one-time code on first connect
    terminals: true, // the Terminals panel
    embedded: true, // full-stack: floating dock in the frontend
  },
})
```

| Option | Default | Description |
|--------|---------|-------------|
| `base` | `'/__devtools/'` | Where the hub is served. |
| `auth` | `true` | Ask new browsers for the one-time code. Turn it off only when you are the only user of the machine and the dev server listens on localhost. |
| `terminals` | `true` | Show the Terminals panel. |
| `embedded` | `true` | Full-stack projects: inject the floating dock into HTML pages served by Vite. |

Set `devtools: false` to turn DevTools off without uninstalling the package.

## Programmatic use

`createDevtools()` creates the hub for any object that exposes the current app and reload events, such as the `AppHost` from `@hazejs/vite`. It returns a Web Standard `handler`, a Connect-style `nodeMiddleware` and `attach` / `handleUpgrade` for the WebSocket:

```ts
import { createDevtools } from '@hazejs/devtools'

const devtools = createDevtools({ source: host, root })
// devtools.handler(request), devtools.nodeMiddleware, devtools.attach(server)
```

`inspectApp(app)` returns the serializable snapshot the panels render: app info, modules, sub-apps, routes and the dashboard path.
