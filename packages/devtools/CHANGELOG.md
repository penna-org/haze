# @hazejs/devtools

## 0.5.0

### Patch Changes

- Updated dependencies [[`57b3b34`](https://github.com/penna-org/haze/commit/57b3b34daf04d05252f6fc5e0cd059b6676ca116)]:
  - @hazejs/core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`a7d7a1b`](https://github.com/penna-org/haze/commit/a7d7a1b2c351570511883fe28cc743e2b86f5c0f)]:
  - @hazejs/core@0.4.0

## 0.3.0

### Minor Changes

- [`6b98748`](https://github.com/penna-org/haze/commit/6b9874898151a075563b97a405700d6b990529f3) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - DevTools panels for module linkage, requests, AI and tasks, plus an MCP endpoint for coding agents:
  
  - **Graph**: modules, sub-apps, events and jobs as an interactive graph. Declared links (who defines an event or job, who listens, scheduled jobs, middleware used across modules, sub-app mounts) and runtime links with counts (events emitted and jobs dispatched while handling requests and jobs).
  - **Requests**: recent requests with a waterfall timeline of their queries, cache calls, events, jobs (including queued work they caused), mail, logs, exceptions, AI and outgoing HTTP calls, and repeated-query (N+1) warnings.
  - **AI**: calls, tokens and latency per model, the messages, output and tool calls of each call, and a playground that runs a prompt against the app's configured models.
  - **Tasks**: scheduled tasks with their next and last run and a "Run now" button, queue counts, and per-job dispatch / success / failure counts.
  - **Internals** (providers, container bindings, events and listeners, jobs, middleware) and **API Docs** (the app's `/docs` page).
  - **MCP** at `/__devtools/__mcp` (loopback only, clients send their local `Origin`): tools to inspect the app, search routes, read the module graph, list requests and their timelines, read AI calls and the OpenAPI document, and run a scheduled task. Turn it off with `devtools: { mcp: false }`.

- [`29360c7`](https://github.com/penna-org/haze/commit/29360c700a3f47424f28d4dab07d02afc98fc157) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - `haze devtools:report` writes the app structure (overview, module graph, routes, container and events) to a static site for CI artifacts and reviews (`buildReport()` in `@hazejs/devtools`). In full-stack projects that turn on Vite DevTools (`devtools: true` in `vite.config.ts`), the `haze()` plugin registers the hazejs panels inside Vite DevTools instead of serving its own at the same `/__devtools/` path (`setupViteDevtools()`). `@hazejs/vite` exports `importDevtools()`, and `devtools.mcp` turns the MCP endpoint off.

- [`011b503`](https://github.com/penna-org/haze/commit/011b503abb98faadea05bd1fd23fa7b3567e728d) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - New `@hazejs/devtools` package (experimental), built on [devframe](https://devfra.me): install it as a dev dependency and `haze dev` serves a DevTools hub at `/__devtools/` with an app overview (name, mode, reload status, modules, sub-apps), a searchable route table, the `/__haze` dev dashboard and terminals with one-click `haze` commands. The hub runs in the dev server process, so its connection and state survive hot reloads; failed reloads show up as a status badge and a notification. In full-stack Vite projects the `haze()` plugin mounts it on the Vite server and injects a floating dock into the frontend. Browsers authorize once with a one-time code printed in the terminal. Configure or turn it off with `devtools` in `haze.config.ts` or the `haze()` options; production builds never include it.

### Patch Changes

- Updated dependencies [[`7b5e0a9`](https://github.com/penna-org/haze/commit/7b5e0a95b73edbeac5aa5570483b2cbe2daf2eb8), [`cb51e0a`](https://github.com/penna-org/haze/commit/cb51e0aa95ad258aee8cc11e41cabe09448c01de), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`f46d960`](https://github.com/penna-org/haze/commit/f46d960fb67f600e402f3ba371f83c3a8f3592cb), [`ea86d01`](https://github.com/penna-org/haze/commit/ea86d0175adf24563dc62ce796e602a04fbe6dcd), [`940711c`](https://github.com/penna-org/haze/commit/940711c72b493eab636beb0fd034ff8f118165bc), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`4da85a8`](https://github.com/penna-org/haze/commit/4da85a83107181f99b029837798be84cb7c8c92a), [`bd81767`](https://github.com/penna-org/haze/commit/bd817672b975e2475a7644214396915d5f247f9b), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`15e802d`](https://github.com/penna-org/haze/commit/15e802d5f341a9928720189ed49a9cba8ff168f2), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4)]:
  - @hazejs/core@0.3.0
